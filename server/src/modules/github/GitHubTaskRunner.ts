import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { Message, ToolResultBlock } from "@justai/shared";

import type { GitService } from "../../infrastructure/git/GitService.js";
import type { PermissionService } from "../agent/permissions/PermissionService.js";
import type { SessionManager } from "../agent/runtime/SessionManager.js";
import { BOT_MARKER, GitHubError, type GitHubClient, type GitHubComment, type GitHubIssue } from "./GitHubClient.js";

export const LABELS = {
    working: "justai:working",
    review: "justai:review",
    failed: "justai:failed",
    paused: "justai:paused",
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
    /** Как часто обновлять отчёт о ходе работы и проверять команду остановки (мс, по умолчанию 30 с). */
    progressMs?: number;
}

export interface GitHubRunnerStatus {
    enabled: boolean;
    repo: string;
    state: "idle" | "working" | "error" | "stopped";
    currentIssue?: number;
    /** Сессия, в которой сейчас работает исполнитель (её можно открыть в интерфейсе и смотреть шаги). */
    currentSessionId?: string;
    lastCheck?: string;
    lastError?: string;
    /** Задачи выполняются, но что-то второстепенное не работает (например, нет прав на метки). */
    warning?: string;
    tasks: Array<{ issue: number; status: TaskState["status"]; branch: string; pullRequest?: string }>;
}

interface TaskState {
    sessionId: string;
    branch: string;
    status: "working" | "review" | "failed" | "paused";
    /** Последний учтённый комментарий: новые после него — правки. */
    lastCommentId: number;
    pullRequest?: string;
}

interface StoredState {
    tasks: Record<string, TaskState>;
    /** Служебные issues с правками, которые уже приняты. */
    followUps?: number[];
}

const REPORT_CHARS = 3_000;

const CONTINUE_NOTE = "Continue the task from where you stopped and finish it.";

const RESUME_NOTE = "The previous run of this task was interrupted (JustAI was restarted). Check the current state of the files and continue from where you stopped until the task, including any requested changes above, is complete.";

function summarize(state: StoredState): GitHubRunnerStatus["tasks"] {
    return Object.entries(state.tasks).map(([issue, task]) => ({
        issue: Number(issue),
        status: task.status,
        branch: task.branch,
        ...(task.pullRequest ? { pullRequest: task.pullRequest } : {}),
    }));
}

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

        // Папка проекта должна быть клоном именно этого репозитория: иначе можно отправить в него чужой код.
        const origin = await this.git(["remote", "get-url", "origin"]).catch(() => "");

        if (!originMatches(origin, client.repo)) {
            throw new Error(`The project folder is not a clone of ${client.repo} (origin: ${origin.trim() || "none"}). Clone the repository and open that folder in JustAI (📁).`);
        }

        const allowed = await this.allowedUsers();
        const state = await this.load();
        this.status = { ...this.status, tasks: summarize(state) };
        const open = (await client.listIssues()).filter(issue => !issue.isPullRequest && allowed.has(issue.author.toLowerCase()));

        // «В работе» в файле, но не в этом процессе: задачу оборвал перезапуск JustAI — продолжаем в той же сессии.
        for (const issue of open) {
            const task = state.tasks[issue.number];

            if (task?.status === "working" && task.sessionId) {
                await this.run(issue, state, [{ id: 0, author: "JustAI", body: RESUME_NOTE, createdAt: "" }]);
                return;
            }
        }

        // Правки отдельным issue («/justai #3»): для планировщиков, которым GitHub не даёт комментировать.
        for (const issue of open) {
            const target = followUpTarget(issue, config.label);
            const task = target === null ? undefined : state.tasks[target];

            if (target === null || !task || task.status === "working" || state.followUps?.includes(issue.number)) {
                continue;
            }

            state.followUps = [...state.followUps ?? [], issue.number];
            await this.save(state);

            // «/justai stop #N», когда задача не выполняется, — останавливать нечего.
            if (followUpCommand(issue, config.label)?.action === "stop") {
                await this.soft(client.comment(issue.number, `Задача #${target} сейчас не выполняется — останавливать нечего.`), "comments");
                await this.soft(client.closeIssue(issue.number), "closing issues");
                continue;
            }

            await this.soft(client.comment(issue.number, `Принято как правка к задаче #${target}. Отчёт будет в #${target}.`), "comments");
            await this.soft(client.closeIssue(issue.number), "closing issues");

            const body = stripCommands(issue.body, config.label) || CONTINUE_NOTE;
            await this.run(await client.getIssue(target), state, [{ id: 0, author: issue.author, body, createdAt: "" }]);
            return;
        }

        const issues = open.filter(issue => followUpTarget(issue, config.label) === null && isTask(issue, config.label));

        for (const issue of issues) {
            const task = state.tasks[issue.number];

            if (!task) {
                // Задачу могли пометить маркером в тексте (метку ставит не каждая интеграция) — метку ставим сами.
                if (!issue.labels.includes(config.label)) {
                    await this.soft(client.addLabels(issue.number, [config.label]), "labels");
                }

                await this.run(issue, state, []);
                return;
            }

            if (task.status === "working") {
                continue;
            }

            const comments = await client.listComments(issue.number);
            const feedback = comments.filter(item =>
                item.id > task.lastCommentId && allowed.has(item.author.toLowerCase()) && !item.body.includes(BOT_MARKER)
                && !isStopCommand(item.body, config.label));

            if (feedback.length > 0) {
                await this.run(issue, state, feedback, comments);
                return;
            }
        }

        this.status = { ...this.status, state: "idle", currentIssue: undefined, lastError: undefined };
    }

    private async run(issue: GitHubIssue, state: StoredState, feedback: GitHubComment[], knownComments?: GitHubComment[]): Promise<void> {
        const { client, sessions, permissions, config } = this.deps;

        const previous = state.tasks[issue.number];
        const branch = previous?.branch ?? `justai/issue-${issue.number}`;

        // Чужие незакоммиченные изменения не трогаем: задача подождёт.
        // Исключение — папка уже на ветке этой задачи (работу оборвал перезапуск): изменения агента продолжаются.
        const dirty = (await this.git(["status", "--porcelain", "--", ".", ":(exclude).justai"])).trim() !== "";
        const onTaskBranch = (await this.git(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim() === branch;

        if (dirty && !onTaskBranch) {
            this.status = { ...this.status, state: "error", lastError: "The workspace has uncommitted changes; GitHub tasks wait until it is clean." };
            return;
        }

        const comments = knownComments ?? await client.listComments(issue.number);
        const base = await client.defaultBranch();

        this.status = { ...this.status, state: "working", currentIssue: issue.number, lastError: undefined, warning: undefined };
        this.deps.log?.(`[github] issue #${issue.number}: ${feedback.length ? "feedback" : "new task"} → ${branch}`);

        await this.soft(client.addLabels(issue.number, [LABELS.working]), "labels");
        await this.soft(client.removeLabel(issue.number, LABELS.review), "labels");
        await this.soft(client.removeLabel(issue.number, LABELS.failed), "labels");
        await this.soft(client.removeLabel(issue.number, LABELS.paused), "labels");

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
            if (dirty && onTaskBranch) {
                await this.git(["fetch", "origin"], true);
            }
            else {
                await this.checkoutBranch(branch, base, Boolean(previous));
            }

            if (!task.sessionId || !(await sessions.get(task.sessionId).then(() => true, () => false))) {
                const created = await sessions.create({
                    profile: config.profile,
                    provider: config.provider,
                    ...(config.model ? { model: config.model } : {}),
                    ...(config.executorProvider ? { executorProvider: config.executorProvider } : {}),
                    mode: "full-auto",
                });
                task.sessionId = created.id;
                await sessions.setTitle(created.id, `GitHub #${issue.number}: ${cleanTitle(issue.title, config.label)}`);
            }

            this.status = { ...this.status, currentSessionId: task.sessionId };

            permissions.setUnattended(task.sessionId, true);
            const startIndex = (await sessions.get(task.sessionId)).messages.length;
            await sessions.send(task.sessionId, { text: feedback.length ? feedbackPrompt(issue, feedback, branch) : taskPrompt(issue, branch, config.label) });

            // Пока агент работает: живой отчёт в issue и проверка команды «/justai stop».
            const watch = await this.watch(issue, task, startIndex, state);
            await sessions.waitForIdle(task.sessionId);
            await watch.finish();

            const details = await sessions.get(task.sessionId);
            const report = lastAssistantText(details.messages.slice(startIndex)) || "(no report)";
            const committed = await this.commit(issue, watch.stopped ? "WIP: " : "");

            if (committed) {
                await this.push(branch);
                const pull = await client.findPullRequest(branch)
                    ?? await client.createPullRequest(branch, base, `JustAI: ${cleanTitle(issue.title, this.deps.config.label)}`, `${clip(report, REPORT_CHARS)}\n\nCloses #${issue.number}\n\n${BOT_MARKER}`);
                task.pullRequest = pull.url;
            }

            if (watch.stopped) {
                task.status = "paused";
                task.lastCommentId = Math.max(task.lastCommentId, watch.stopCommentId);

                await watch.update("⏸ **JustAI** остановлен по команде.");
                await this.soft(client.comment(issue.number, [
                    "⏸ **JustAI** stopped on request.",
                    committed ? `Work so far is saved in \`${branch}\`${task.pullRequest ? ` · pull request: ${task.pullRequest}` : ""}.` : "No file changes yet.",
                    "",
                    "**Where it stopped:**",
                    clip(report, REPORT_CHARS),
                    "",
                    "_To continue, reply in this issue with instructions (or create an issue with `/justai continue #" + issue.number + "`). JustAI resumes in the same session._",
                ].join("\n")), "comments");
                await this.soft(client.addLabels(issue.number, [LABELS.paused]), "labels");
                return;
            }

            const ok = details.session.status === "completed" && (committed || Boolean(task.pullRequest));
            task.status = ok ? "review" : "failed";
            await watch.update(ok ? "✅ **JustAI** закончил — отчёт ниже." : "⚠️ **JustAI** не смог закончить — подробности ниже.");

            await this.soft(client.comment(issue.number, [
                ok ? "✅ **JustAI** finished this step." : "⚠️ **JustAI** could not complete this step.",
                committed ? `Branch \`${branch}\`${task.pullRequest ? ` · pull request: ${task.pullRequest}` : ""}` : "No file changes were made.",
                details.session.lastError ? `Error: ${details.session.lastError}` : "",
                "",
                "**Report:**",
                clip(report, REPORT_CHARS),
                "",
                "_Reply in this issue to request changes — JustAI will continue on the same branch._",
            ].join("\n")), "comments");

            await this.soft(client.addLabels(issue.number, [ok ? LABELS.review : LABELS.failed]), "labels");
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
            this.status = { ...this.status, currentIssue: undefined, currentSessionId: undefined, ...(this.status.state === "working" ? { state: "idle" as const } : {}) };
        }
    }

    /**
     * Наблюдение за работающим агентом: отчёт о ходе работы (один комментарий, обновляется) и команда остановки —
     * комментарий «/justai stop» в задаче или issue «/justai stop #N».
     */
    private async watch(issue: GitHubIssue, task: TaskState, startIndex: number, state: StoredState): Promise<{
        readonly stopped: boolean;
        readonly stopCommentId: number;
        update(header: string): Promise<void>;
        finish(): Promise<void>;
    }> {
        const { client, sessions, config } = this.deps;
        const allowed = await this.allowedUsers();
        let progressId = 0;
        let stopped = false;
        let stopCommentId = 0;
        let busy: Promise<void> | undefined;

        const render = async (header: string, active = true): Promise<string> => {
            const details = await sessions.get(task.sessionId);
            return progressReport(header, details.messages.slice(startIndex), task.branch, issue.number, config.label, active);
        };

        const update = async (header: string, active = false) => {
            if (!progressId) return;
            await this.soft(render(header, active).then(body => client.updateComment(progressId, body)), "comments");
        };

        try {
            progressId = await client.comment(issue.number, await render("⏳ **JustAI** работает над задачей…"));
        }
        catch (error) {
            await this.soft(Promise.reject(error), "comments");
        }

        const checkStop = async () => {
            const comments = await client.listComments(issue.number).catch(() => [] as GitHubComment[]);
            const command = comments.find(item =>
                item.id > task.lastCommentId && allowed.has(item.author.toLowerCase()) && isStopCommand(item.body, config.label));
            const issues = command ? [] : await client.listIssues().catch(() => [] as GitHubIssue[]);
            const stopIssue = issues.find(item =>
                !item.isPullRequest && allowed.has(item.author.toLowerCase()) && !state.followUps?.includes(item.number)
                && followUpCommand(item, config.label)?.action === "stop" && followUpTarget(item, config.label) === issue.number);

            if (!command && !stopIssue) return;

            stopped = true;
            stopCommentId = command?.id ?? 0;

            if (stopIssue) {
                state.followUps = [...state.followUps ?? [], stopIssue.number];
                await this.soft(client.comment(stopIssue.number, `Задача #${issue.number} остановлена.`), "comments");
                await this.soft(client.closeIssue(stopIssue.number), "closing issues");
            }

            this.deps.log?.(`[github] issue #${issue.number}: stop requested`);
            await sessions.stop(task.sessionId);
        };

        const tick = () => {
            busy ??= (async () => {
                if (!stopped) await checkStop();
                if (!stopped) await update("⏳ **JustAI** работает над задачей…", true);
            })().catch(() => undefined).finally(() => { busy = undefined; });
        };

        const timer = setInterval(tick, config.progressMs ?? 30_000);
        timer.unref();

        return {
            get stopped() { return stopped; },
            get stopCommentId() { return stopCommentId; },
            update,
            finish: async () => {
                clearInterval(timer);
                await busy;
            },
        };
    }

    /**
     * Метки и комментарии — дополнительная функция: без прав на них задача всё равно выполняется
     * (ветка, коммит, pull request), а проблема показывается в статусе.
     */
    private async soft(action: Promise<unknown>, what: string): Promise<void> {
        try {
            await action;
        }
        catch (error) {
            const hint = error instanceof GitHubError && error.status === 403
                ? `No permission for ${what}: give the token \"Issues: Read and write\" (GitHub → Settings → Developer settings → Fine-grained tokens).`
                : `Could not update ${what}: ${message(error)}`;
            this.status = { ...this.status, warning: hint };
            this.deps.log?.(`[github] ${hint}`);
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

        if (!(await this.git(["ls-remote", "--heads", "origin", base], true)).trim()) {
            throw new Error(`The repository has no commits on '${base}' yet. Add a first commit (for example, "Add a README" on the repository page on GitHub), then the task will run.`);
        }

        const remoteBranch = existing && (await this.git(["ls-remote", "--heads", "origin", branch], true)).trim() !== "";

        await this.git(["checkout", "-B", branch, remoteBranch ? `origin/${branch}` : `origin/${base}`]);
    }

    /** Закоммитить всё, что сделал агент. false — изменений нет. */
    private async commit(issue: GitHubIssue, prefix = ""): Promise<boolean> {
        // .justai (сессии, токен, состояние моста) не коммитится никогда, даже если у проекта нет своего .gitignore.
        await this.git(["add", "-A", "--", ".", ":(exclude).justai"]);

        if (!(await this.git(["diff", "--cached", "--name-only"])).trim()) {
            return false;
        }

        const identity = (await this.git(["config", "user.email"]).catch(() => "")).trim()
            ? []
            : ["-c", "user.name=JustAI", "-c", "user.email=justai@users.noreply.github.com"];

        await this.git([...identity, "commit", "-m", `JustAI: ${prefix}${cleanTitle(issue.title, this.deps.config.label)} (#${issue.number})`]);
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
        this.status = { ...this.status, tasks: summarize(state) };
    }
}

/**
 * Задача для JustAI: метка, «[justai]» в начале заголовка или отдельная строка «/justai» в описании.
 * Маркеры нужны интеграциям, которым GitHub разрешает создавать issues, но не ставить метки.
 */
/** Заголовок без служебной пометки «[justai]». */
export function cleanTitle(title: string, label: string): string {
    return title.replace(new RegExp(`^\\s*\\[${escapeRegExp(label)}\\]\\s*`, "i"), "").trim() || title;
}

export function isTask(issue: GitHubIssue, label: string): boolean {
    const escaped = escapeRegExp(label);
    return issue.labels.includes(label)
        || new RegExp(`^\\s*\\[${escaped}\\]`, "i").test(issue.title)
        || new RegExp(`^\\s*/${escaped}\\s*$`, "im").test(issue.body);
}

/**
 * Служебный issue для задачи N: «/justai #3», «/justai continue #3» (правка или продолжение), «/justai stop #3» (остановить).
 */
export function followUpCommand(issue: GitHubIssue, label: string): { target: number; action: "stop" | "continue" } | null {
    const match = new RegExp(`^\\s*/${escapeRegExp(label)}\\s+(?:(stop|pause|continue)\\s+)?#(\\d+)\\s*$`, "im").exec(issue.body);

    if (!match) {
        return null;
    }

    return { target: Number(match[2]), action: match[1] === "stop" || match[1] === "pause" ? "stop" : "continue" };
}

/** Номер задачи, к которой этот issue — правка или команда, иначе null. */
export function followUpTarget(issue: GitHubIssue, label: string): number | null {
    return followUpCommand(issue, label)?.target ?? null;
}

/** Комментарий-команда «/justai stop» (или pause) отдельной строкой. */
export function isStopCommand(body: string, label: string): boolean {
    return new RegExp(`^\\s*/${escapeRegExp(label)}\\s+(stop|pause)\\s*$`, "im").test(body);
}

/** Текст правки без служебных строк «/justai …». */
export function stripCommands(body: string, label: string): string {
    return body.replace(new RegExp(`^\\s*/${escapeRegExp(label)}\\b.*$`, "gim"), "").trim();
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * origin указывает на owner/name на GitHub: https://github.com/owner/name(.git), git@github.com:owner/name.git.
 * Локальный путь (bare-репозиторий в тестах) принимается: проверить по нему владельца нельзя.
 */
export function originMatches(origin: string, repo: string): boolean {
    const url = origin.trim();

    if (!url) {
        return false;
    }

    const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(url);

    if (match) {
        return match[1]!.toLowerCase() === repo.toLowerCase();
    }

    return !/^[a-z]+:\/\//i.test(url) && !/^[\w.-]+@/.test(url);
}

export function taskPrompt(issue: GitHubIssue, branch: string, label = "justai"): string {
    return [
        cleanTitle(issue.title, label),
        "",
        issue.body.trim() || "(no description)",
        "",
        "---",
        `This is GitHub task #${issue.number}. You are working in a git repository on branch ${branch}. Implement this task completely in the files, run the project's checks or tests if there are any, and fix what fails.`,
        "Do not commit or push: JustAI commits your changes and opens a pull request after you finish.",
        "Finish with a short report: what you changed (files), how you verified it, and anything left to do.",
    ].join("\n");
}

const PROGRESS_ACTIONS = 8;

/**
 * Отчёт о ходе работы для issue: шаги, план агента, последние действия (с ошибками) и повторяющиеся сбои —
 * чтобы планировщик или человек видели, идёт ли работа, и могли вовремя остановить её.
 */
export function progressReport(header: string, messages: Message[], branch: string, issue: number, label: string, active = true): string {
    const results = new Map<string, ToolResultBlock>();

    for (const message of messages) {
        for (const block of message.content) {
            if (block.type === "tool_result") results.set(block.toolUseId, block);
        }
    }

    const actions: string[] = [];
    let plan: Array<{ content?: unknown; status?: unknown }> | undefined;
    let steps = 0;
    let lastFailure = "";
    let failureStreak = 0;
    let failureTool = "";

    for (const message of messages) {
        for (const block of message.content) {
            if (block.type !== "tool_use") continue;

            steps += 1;

            if (block.name === "todo_write") {
                const todos = (block.input as { todos?: unknown } | null)?.todos;
                if (Array.isArray(todos)) plan = todos as typeof plan;
                continue;
            }

            const result = results.get(block.id);
            const error = result?.isError ? firstLineOf(resultText(result)) : "";
            actions.push(`${!result ? "…" : result.isError ? "✕" : "✓"} \`${block.name}\` ${briefInput(block.input)}${error ? ` — ${error}` : ""}`);

            const key = `${block.name}:${JSON.stringify(block.input)}`;

            if (result?.isError) {
                failureStreak = key === lastFailure ? failureStreak + 1 : 1;
                lastFailure = key;
                failureTool = block.name;
            }
            else if (result) {
                failureStreak = 0;
                lastFailure = "";
            }
        }
    }

    const time = new Date().toISOString().slice(11, 16);
    const lines = [header, `Шагов: ${steps} · ветка \`${branch}\` · обновлено ${time} UTC`];

    if (plan?.length) {
        lines.push("", "**План:**", ...plan.map(todo => `- [${todo.status === "completed" ? "x" : " "}] ${String(todo.content)}${todo.status === "in_progress" ? " ← сейчас" : ""}`));
    }

    if (actions.length) {
        lines.push("", "**Последние действия:**", ...actions.slice(-PROGRESS_ACTIONS));
    }

    if (failureStreak >= 2) {
        lines.push("", `⚠ Одна и та же ошибка \`${failureTool}\` повторяется ${failureStreak} раза подряд — возможно, агент застрял.`);
    }

    if (active) lines.push("", `_Остановить: комментарий \`/${label} stop\` (или issue со строкой \`/${label} stop #${issue}\`). Продолжить потом — комментарий с указаниями._`);
    return lines.join("\n");
}

function resultText(block: ToolResultBlock): string {
    return typeof block.content === "string"
        ? block.content
        : block.content.map(part => part.type === "text" ? part.text : "[image]").join(" ");
}

function firstLineOf(text: string): string {
    const line = text.trim().split("\n").find(item => item.trim()) ?? "";
    return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

function briefInput(input: unknown): string {
    const value = input as { path?: unknown; command?: unknown; pattern?: unknown; query?: unknown; task?: unknown } | null;
    const main = value?.path ?? value?.command ?? value?.pattern ?? value?.query ?? value?.task;

    if (typeof main !== "string") return "";

    const single = main.replace(/\s+/g, " ").trim();
    return single.length > 80 ? `${single.slice(0, 79)}…` : single;
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
