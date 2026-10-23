import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { Message } from "@justai/shared";

import type { GitService } from "../../infrastructure/git/GitService.js";
import type { PermissionService } from "../agent/permissions/PermissionService.js";
import type { SessionManager } from "../agent/runtime/SessionManager.js";
import { BOT_MARKER, type GitHubClient, type GitHubComment, type GitHubIssue } from "./GitHubClient.js";

export const LABELS = {
    working: "justai:working",
    review: "justai:review",
    failed: "justai:failed",
} as const;

export interface GitHubRunnerConfig {
    /** Метка задач для JustAI. */
    label: string;
    /** Кто может ставить задачи; пусто — владелец токена. */
    allowedUsers: string[];
    profile: string;
    provider: string;
    model?: string;
    executorProvider?: string;
    pollMs: number;
    /** Работать с публичным репозиторием (задачи в нём может написать кто угодно). */
    allowPublic: boolean;
    /** Токен для git push по https://github.com (через переменные окружения, не в адресе и не в конфиге). */
    token: string;
}

export interface GitHubRunnerStatus {
    enabled: boolean;
    repo: string;
    state: "idle" | "working" | "error" | "stopped";
    currentIssue?: number;
    lastCheck?: string;
    lastError?: string;
    tasks: Array<{ issue: number; status: TaskState["status"]; branch: string; pullRequest?: string }>;
}

interface TaskState {
    sessionId: string;
    branch: string;
    status: "working" | "review" | "failed";
    /** Последний учтённый комментарий: новые после него — правки. */
    lastCommentId: number;
    pullRequest?: string;
}

interface StoredState {
    tasks: Record<string, TaskState>;
}

const REPORT_CHARS = 3_000;

/**
 * Мост GitHub → JustAI: задачи из issues выполняются локальным агентом без присмотра,
 * результат — ветка, pull request и отчёт в issue. Новые комментарии к задаче — доработка той же ветки.
 */
export class GitHubTaskRunner {

    private timer?: NodeJS.Timeout;
    private running?: Promise<void>;
    private allowed?: Set<string>;
    private readonly stateFile: string;
    private status: GitHubRunnerStatus;

    constructor(
        private readonly deps: {
            client: GitHubClient;
            git: GitService;
            sessions: SessionManager;
            permissions: PermissionService;
            workspaceRoot: string;
            config: GitHubRunnerConfig;
            log?: (message: string) => void;
        },
    ) {
        this.stateFile = path.join(deps.workspaceRoot, ".justai", "github-state.json");
        this.status = { enabled: false, repo: deps.client.repo, state: "stopped", tasks: [] };
    }

    public getStatus(): GitHubRunnerStatus {
        return this.status;
    }

    public start(): void {
        if (this.timer) return;

        this.status = { ...this.status, enabled: true, state: "idle" };
        this.timer = setInterval(() => void this.check(), this.deps.config.pollMs);
        this.timer.unref();
        void this.check();
    }

    public async stop(): Promise<void> {
        clearInterval(this.timer);
        this.timer = undefined;
        this.status = { ...this.status, enabled: false, state: "stopped" };
        await this.running?.catch(() => undefined);
    }

    /** Один проход: взять следующую задачу или правку. Параллельно не выполняется. */
    public check(): Promise<void> {
        this.running ??= this.tick()
            .catch(error => {
                this.status = { ...this.status, state: "error", lastError: message(error) };
                this.deps.log?.(`[github] ${message(error)}`);
            })
            .finally(() => {
                this.running = undefined;
            });

        return this.running;
    }

    private async tick(): Promise<void> {
        const { client, config } = this.deps;
        this.status = { ...this.status, lastCheck: new Date().toISOString() };

        if (!config.allowPublic && !(await client.isPrivate())) {
            throw new Error(`Repository ${client.repo} is public: anyone could post tasks that run on this computer. Make it private or set JUSTAI_GITHUB_ALLOW_PUBLIC=on.`);
        }

        const allowed = await this.allowedUsers();
        const state = await this.load();
        const issues = (await client.listIssues(config.label)).filter(issue => !issue.isPullRequest && allowed.has(issue.author.toLowerCase()));

        for (const issue of issues) {
            const task = state.tasks[issue.number];

            if (!task) {
                await this.run(issue, state, []);
                return;
            }

            if (task.status === "working") {
                continue;
            }

            const comments = await client.listComments(issue.number);
            const feedback = comments.filter(item =>
                item.id > task.lastCommentId && allowed.has(item.author.toLowerCase()) && !item.body.includes(BOT_MARKER));

            if (feedback.length > 0) {
                await this.run(issue, state, feedback, comments);
                return;
            }
        }

        this.status = { ...this.status, state: "idle", currentIssue: undefined, lastError: undefined };
    }

    private async run(issue: GitHubIssue, state: StoredState, feedback: GitHubComment[], knownComments?: GitHubComment[]): Promise<void> {
        const { client, sessions, permissions, config } = this.deps;

        // Чужие незакоммиченные изменения не трогаем: задача подождёт.
        const dirty = (await this.git(["status", "--porcelain", "--", ".", ":(exclude).justai"])).trim();

        if (dirty) {
            this.status = { ...this.status, state: "error", lastError: "The workspace has uncommitted changes; GitHub tasks wait until it is clean." };
            return;
        }

        const comments = knownComments ?? await client.listComments(issue.number);
        const previous = state.tasks[issue.number];
        const branch = previous?.branch ?? `justai/issue-${issue.number}`;
        const base = await client.defaultBranch();

        this.status = { ...this.status, state: "working", currentIssue: issue.number, lastError: undefined };
        this.deps.log?.(`[github] issue #${issue.number}: ${feedback.length ? "feedback" : "new task"} → ${branch}`);

        await client.addLabels(issue.number, [LABELS.working]);
        await client.removeLabel(issue.number, LABELS.review);
        await client.removeLabel(issue.number, LABELS.failed);

        const task: TaskState = {
            sessionId: previous?.sessionId ?? "",
            branch,
            status: "working",
            lastCommentId: Math.max(0, ...comments.map(item => item.id)),
            ...(previous?.pullRequest ? { pullRequest: previous.pullRequest } : {}),
        };

        state.tasks[issue.number] = task;
        await this.save(state);

        try {
            await this.checkoutBranch(branch, base, Boolean(previous));

            if (!task.sessionId || !(await sessions.get(task.sessionId).then(() => true, () => false))) {
                const created = await sessions.create({
                    profile: config.profile,
                    provider: config.provider,
                    ...(config.model ? { model: config.model } : {}),
                    ...(config.executorProvider ? { executorProvider: config.executorProvider } : {}),
                    mode: "full-auto",
                });
                task.sessionId = created.id;
            }

            permissions.setUnattended(task.sessionId, true);
            await sessions.send(task.sessionId, { text: feedback.length ? feedbackPrompt(issue, feedback, branch) : taskPrompt(issue, branch) });
            await sessions.waitForIdle(task.sessionId);

            const details = await sessions.get(task.sessionId);
            const report = lastAssistantText(details.messages) || "(no report)";
            const committed = await this.commit(issue);

            if (committed) {
                await this.push(branch);
                const pull = await client.findPullRequest(branch)
                    ?? await client.createPullRequest(branch, base, `JustAI: ${issue.title}`, `${clip(report, REPORT_CHARS)}\n\nCloses #${issue.number}\n\n${BOT_MARKER}`);
                task.pullRequest = pull.url;
            }

            const ok = details.session.status === "completed" && (committed || Boolean(task.pullRequest));
            task.status = ok ? "review" : "failed";

            await client.comment(issue.number, [
                ok ? "✅ **JustAI** finished this step." : "⚠️ **JustAI** could not complete this step.",
                committed ? `Branch \`${branch}\`${task.pullRequest ? ` · pull request: ${task.pullRequest}` : ""}` : "No file changes were made.",
                details.session.lastError ? `Error: ${details.session.lastError}` : "",
                "",
                "**Report:**",
                clip(report, REPORT_CHARS),
                "",
                "_Reply in this issue to request changes — JustAI will continue on the same branch._",
            ].join("\n"));

            await client.addLabels(issue.number, [ok ? LABELS.review : LABELS.failed]);
        }
        catch (error) {
            task.status = "failed";
            this.status = { ...this.status, state: "error", lastError: message(error) };
            await client.comment(issue.number, `⚠️ **JustAI** failed: ${clip(message(error), 1_000)}`).catch(() => undefined);
            await client.addLabels(issue.number, [LABELS.failed]).catch(() => undefined);
        }
        finally {
            permissions.setUnattended(task.sessionId, false);
            await client.removeLabel(issue.number, LABELS.working).catch(() => undefined);
            await this.git(["checkout", base]).catch(() => undefined);
            await this.save(state);
            this.status = { ...this.status, currentIssue: undefined, ...(this.status.state === "working" ? { state: "idle" as const } : {}) };
        }
    }

    private async allowedUsers(): Promise<Set<string>> {
        if (!this.allowed) {
            const users = this.deps.config.allowedUsers.length ? this.deps.config.allowedUsers : [await this.deps.client.currentUser()];
            this.allowed = new Set(users.map(user => user.toLowerCase()));
        }

        return this.allowed;
    }

    private async checkoutBranch(branch: string, base: string, existing: boolean): Promise<void> {
        await this.git(["fetch", "origin"], true);
        const remoteBranch = existing && (await this.git(["ls-remote", "--heads", "origin", branch], true)).trim() !== "";

        await this.git(["checkout", "-B", branch, remoteBranch ? `origin/${branch}` : `origin/${base}`]);
    }

    /** Закоммитить всё, что сделал агент. false — изменений нет. */
    private async commit(issue: GitHubIssue): Promise<boolean> {
        // .justai (сессии, токен, состояние моста) не коммитится никогда, даже если у проекта нет своего .gitignore.
        await this.git(["add", "-A", "--", ".", ":(exclude).justai"]);

        if (!(await this.git(["diff", "--cached", "--name-only"])).trim()) {
            return false;
        }

        const identity = (await this.git(["config", "user.email"]).catch(() => "")).trim()
            ? []
            : ["-c", "user.name=JustAI", "-c", "user.email=justai@users.noreply.github.com"];

        await this.git([...identity, "commit", "-m", `JustAI: ${issue.title} (#${issue.number})`]);
        return true;
    }

    private async push(branch: string): Promise<void> {
        await this.git(["push", "origin", `HEAD:refs/heads/${branch}`], true);
    }

    /** git в папке проекта; withAuth — заголовок авторизации для https://github.com через окружение. */
    private async git(args: string[], withAuth = false): Promise<string> {
        const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0" };

        if (withAuth && this.deps.config.token) {
            const basic = Buffer.from(`x-access-token:${this.deps.config.token}`).toString("base64");
            Object.assign(env, {
                GIT_CONFIG_COUNT: "1",
                GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
                GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
            });
        }

        const result = await this.deps.git.run(args, { cwd: this.deps.workspaceRoot, env });

        if (result.code !== 0) {
            throw new Error(`git ${args.filter(arg => !arg.startsWith("user.")).join(" ")} failed: ${result.stderr.trim().slice(0, 400)}`);
        }

        return result.stdout.toString("utf8");
    }

    private async load(): Promise<StoredState> {
        try {
            return JSON.parse(await readFile(this.stateFile, "utf8")) as StoredState;
        }
        catch {
            return { tasks: {} };
        }
    }

    private async save(state: StoredState): Promise<void> {
        await mkdir(path.dirname(this.stateFile), { recursive: true });
        await writeFile(this.stateFile, JSON.stringify(state, null, 2), "utf8");
        this.status = {
            ...this.status,
            tasks: Object.entries(state.tasks).map(([issue, task]) => ({
                issue: Number(issue),
                status: task.status,
                branch: task.branch,
                ...(task.pullRequest ? { pullRequest: task.pullRequest } : {}),
            })),
        };
    }
}

export function taskPrompt(issue: GitHubIssue, branch: string): string {
    return [
        issue.title,
        "",
        issue.body.trim() || "(no description)",
        "",
        "---",
        `This is GitHub task #${issue.number}. You are working in a git repository on branch ${branch}. Implement this task completely in the files, run the project's checks or tests if there are any, and fix what fails.`,
        "Do not commit or push: JustAI commits your changes and opens a pull request after you finish.",
        "Finish with a short report: what you changed (files), how you verified it, and anything left to do.",
    ].join("\n");
}

export function feedbackPrompt(issue: GitHubIssue, feedback: GitHubComment[], branch: string): string {
    return [
        ...feedback.map(item => item.body.trim()),
        "",
        "---",
        `These are new comments from ${[...new Set(feedback.map(item => item.author))].join(", ")} on GitHub task #${issue.number} (${issue.title}).`,
        `Address them on branch ${branch}. Do not commit or push. Finish with a short report of what you changed.`,
    ].join("\n");
}

function lastAssistantText(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i]!;

        if (message.role !== "assistant") continue;

        const text = message.content.map(block => block.type === "text" ? block.text : "").join("").trim();
        if (text) return text;
    }

    return "";
}

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
