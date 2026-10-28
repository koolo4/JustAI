import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { EventBus } from "../../../src/core/events/index.js";
import { GitService } from "../../../src/infrastructure/git/GitService.js";
import { AgentProfiles } from "../../../src/modules/agent/profiles.js";
import { PermissionService } from "../../../src/modules/agent/permissions/PermissionService.js";
import { ProviderRegistry } from "../../../src/modules/agent/providers/ProviderRegistry.js";
import { DEFAULT_BUDGET } from "../../../src/modules/agent/runtime/Budget.js";
import { SessionManager } from "../../../src/modules/agent/runtime/SessionManager.js";
import { SessionStore } from "../../../src/modules/agent/runtime/SessionStore.js";
import { AgentFileSystem } from "../../../src/modules/agent/tools/AgentFileSystem.js";
import { createFileTools } from "../../../src/modules/agent/tools/fileTools.js";
import { ToolRegistry } from "../../../src/modules/agent/tools/ToolRegistry.js";
import { defineTool } from "../../../src/modules/agent/tools/Tool.js";
import { createMessage } from "../../../src/modules/agent/runtime/AgentLoop.js";
import { BOT_MARKER, GitHubError, type GitHubClient, type GitHubComment, type GitHubIssue } from "../../../src/modules/github/GitHubClient.js";
import { ProcessManager } from "../../../src/infrastructure/process/ProcessManager.js";
import { BrowserService } from "../../../src/infrastructure/browser/BrowserService.js";
import { Verifier } from "../../../src/modules/agent/runtime/Verifier.js";
import {
    appCommand, ARTIFACTS_BRANCH, baseTarget, checksReport, isDependencyPath, isModelUnavailable, isTempFile, mentionedFiles, restrictsFiles, closeCommand, dependsOn, e2eCommand, testEvidence, followUpCommand, followUpTarget, GitHubTaskRunner, isMergeCommand, isStopCommand, isTask, isTestTask, LABELS, originMatches,
    progressReport, runCommentCommand, runIssueCommand, statusReport, stripCommands, taskPrompt, testTarget, testVerdict,
} from "../../../src/modules/github/GitHubTaskRunner.js";

const git = new GitService();

/** Поддельный GitHub: issues, комментарии, метки и PR в памяти. */
class FakeGitHub {
    public readonly repo = "me/project";
    public issues: GitHubIssue[] = [];
    public comments = new Map<number, GitHubComment[]>();
    public pulls: Array<{ number: number; url: string; head: string; base: string; body: string }> = [];
    public isPrivateRepo = true;
    private nextComment = 1;

    public async currentUser() { return "me"; }
    public async isPrivate() { return this.isPrivateRepo; }
    public async defaultBranch() { return "main"; }
    public closed: number[] = [];
    public async listIssues(label?: string) { return this.issues.filter(issue => !this.closed.includes(issue.number) && (!label || issue.labels.includes(label))); }
    public async getIssue(number: number) { return this.issues.find(issue => issue.number === number)!; }
    public async closeIssue(number: number) { this.closed.push(number); }
    public async listComments(number: number) { return this.comments.get(number) ?? []; }

    public async comment(number: number, body: string, asBot = true) {
        this.deny();
        const list = this.comments.get(number) ?? [];
        const id = this.nextComment++;
        list.push({ id, author: "me", body: asBot ? `${body}\n\n${BOT_MARKER}` : body, createdAt: "" });
        this.comments.set(number, list);
        return id;
    }

    public updates = 0;
    public async updateComment(id: number, body: string) {
        this.deny();
        this.updates += 1;
        for (const list of this.comments.values()) {
            const item = list.find(comment => comment.id === id);
            if (item) item.body = `${body}\n\n${BOT_MARKER}`;
        }
    }

    /** Токен без права Issues: write — метки и комментарии отклоняются (403). */
    public denyIssueWrites = false;

    private deny() {
        if (this.denyIssueWrites) throw new GitHubError(403, "Resource not accessible by personal access token");
    }

    public async addLabels(number: number, labels: string[]) {
        this.deny();
        const issue = this.issues.find(item => item.number === number)!;
        issue.labels = [...new Set([...issue.labels, ...labels])];
    }

    public async removeLabel(number: number, label: string) {
        this.deny();
        const issue = this.issues.find(item => item.number === number)!;
        issue.labels = issue.labels.filter(item => item !== label);
    }

    /** PR, созданные не мостом (например, планировщиком), — для «#N» в командах. */
    public foreignPulls: Array<{ number: number; head: string; sameRepo: boolean; state: string }> = [];
    public async getPullRequest(number: number) {
        const pull = this.foreignPulls.find(item => item.number === number);
        return pull ? { number, url: `https://github.com/me/project/pull/${number}`, head: pull.head, state: pull.state, sameRepo: pull.sameRepo } : null;
    }

    public async findPullRequest(head: string) {
        const pull = this.pulls.find(item => item.head === head);
        return pull ? { number: pull.number, url: pull.url, head, state: "open" } : null;
    }

    public async createPullRequest(head: string, base: string, _title: string, body: string) {
        const pull = { number: 100 + this.pulls.length, url: `https://github.com/me/project/pull/${100 + this.pulls.length}`, head, base, body };
        this.pulls.push(pull);
        return { number: pull.number, url: pull.url, head, state: "open" };
    }

    public rebased: Array<{ number: number; base: string }> = [];
    public async updatePullRequestBase(number: number, base: string) {
        this.rebased.push({ number, base });
        const pull = this.pulls.find(item => item.number === number);
        if (pull) pull.base = base;
    }

    /** Слияние: «GitHub» переносит основную ветку на ветку PR (в тестах она всегда от основной). */
    public onMerge?: (head: string) => void;
    public merged: number[] = [];
    public deletedBranches: string[] = [];
    public async mergePullRequest(number: number) {
        const pull = this.pulls.find(item => item.number === number)!;
        this.onMerge?.(pull.head);
        this.merged.push(number);
    }
    public async deleteBranch(branch: string) { this.deletedBranches.push(branch); }

    public uploads: Array<{ branch: string; path: string }> = [];
    public async uploadFile(branch: string, filePath: string) {
        this.uploads.push({ branch, path: filePath });
        return `https://github.com/me/project/blob/${branch}/${filePath}?raw=true`;
    }

    public issue(number: number, title: string, author = "me", options: { body?: string; labels?: string[] } = {}): GitHubIssue {
        const issue = { number, title, body: options.body ?? "", author, labels: options.labels ?? ["justai"], url: `https://github.com/me/project/issues/${number}`, isPullRequest: false };
        this.issues.push(issue);
        return issue;
    }
}

function run(cwd: string, ...args: string[]): string {
    return execFileSync(git.binary!, args, { cwd, encoding: "utf8" });
}

describe.skipIf(!git.available)("GitHubTaskRunner", () => {
    let root: string;
    let remote: string;
    let github: FakeGitHub;
    let runner: GitHubTaskRunner;
    let sessions: SessionManager;

    beforeEach(async () => {
        const base = await mkdtemp(path.join(os.tmpdir(), "justai-gh-"));
        remote = path.join(base, "remote.git");
        root = path.join(base, "work");

        run(base, "init", "--bare", "--initial-branch=main", remote);
        run(base, "clone", remote, root);
        run(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init");
        run(root, "push", "origin", "HEAD:main");

        const tools = new ToolRegistry();
        createFileTools(new AgentFileSystem(root, new EventBus(), () => undefined), () => false).forEach(tool => tools.register(tool));
        const permissions = new PermissionService({ rulesFile: path.join(root, ".justai", "permissions.json"), emit: () => undefined });

        sessions = new SessionManager({
            store: new SessionStore(path.join(root, ".justai", "sessions")),
            providers: new ProviderRegistry({ JUSTAI_LAST_RESORT: "off" }),
            tools,
            profiles: new AgentProfiles(),
            workspaceRoot: root,
            shouldIgnore: name => name === ".justai",
            limits: DEFAULT_BUDGET,
            permissions,
            emit: () => undefined,
        });

        github = new FakeGitHub();
        runner = new GitHubTaskRunner({
            client: github as unknown as GitHubClient,
            git,
            sessions,
            permissions,
            workspaceRoot: root,
            config: { label: "justai", allowedUsers: [], profile: "coder", provider: "mock", pollMs: 60_000, allowPublic: false, token: "" },
        });
    });

    afterEach(async () => {
        await runner.stop();
        await rm(path.dirname(root), { recursive: true, force: true });
    });

    it("turns an issue into a branch, a pull request and a report", async () => {
        github.issue(1, "создай файл notes/todo.md");

        await runner.check();

        // Ветка с коммитом агента ушла в «GitHub».
        expect(run(remote, "log", "--format=%s", "justai/issue-1")).toContain("JustAI: создай файл notes/todo.md (#1)");
        expect(run(remote, "show", "justai/issue-1:notes/todo.md")).toContain("Created by the JustAI mock agent.");

        expect(github.pulls).toEqual([expect.objectContaining({ head: "justai/issue-1", base: "main", body: expect.stringContaining("Closes #1") })]);
        expect(github.issues[0]!.labels).toEqual(["justai", LABELS.review]);

        // Первый комментарий — отчёт о ходе работы (обновляется), последний — итоговый отчёт.
        expect(github.comments.get(1)![0]!.body).toContain("закончил");
        const report = github.comments.get(1)!.at(-1)!.body;
        expect(report).toContain("закончил этот шаг");
        expect(report).toMatch(/Факты по git:\*\* в этом запуске изменено: 1 file changed/);
        expect(report).toContain("pull/100");
        expect(report).toContain(BOT_MARKER);

        // Рабочая папка вернулась на основную ветку и чистая.
        expect(run(root, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
        expect(existsSync(path.join(root, "notes", "todo.md"))).toBe(false);
        expect(runner.getStatus().tasks).toEqual([{ issue: 1, status: "review", branch: "justai/issue-1", kind: "code", pullRequest: "https://github.com/me/project/pull/100" }]);
        // Сессию моста видно в списке сессий по понятному названию.
        expect((await sessions.list()).map(session => session.title)).toEqual(["GitHub #1: создай файл notes/todo.md"]);
    }, 60_000);

    it("continues on the same branch when the owner comments, and ignores its own reports", async () => {
        github.issue(2, "создай файл a.txt");
        await runner.check();

        // Собственные комментарии JustAI (ход работы и отчёт) не считаются правкой.
        await runner.check();
        expect(github.comments.get(2)).toHaveLength(2);

        github.comments.get(2)!.push({ id: 50, author: "me", body: "создай файл b.txt", createdAt: "" });
        await runner.check();

        const files = run(remote, "ls-tree", "--name-only", "justai/issue-2");
        expect(files).not.toContain(".justai");
        expect(files).toContain("a.txt");
        expect(files).toContain("b.txt");
        expect(github.pulls).toHaveLength(1);
        expect(github.comments.get(2)).toHaveLength(5);
    }, 60_000);

    it("works for planners that can create issues but cannot label or comment", async () => {
        // Без метки, но с маркером в описании; issue без маркера не трогается.
        github.issue(10, "Unrelated question", "me", { labels: [] });
        github.issue(11, "создай файл c.txt", "me", { labels: [], body: "Need a file.\n/justai" });

        await runner.check();
        expect(github.issues.find(item => item.number === 11)!.labels).toEqual(["justai", LABELS.review]);
        expect(github.comments.get(10)).toBeUndefined();

        // Правка отдельным issue: принимается к #11, служебный issue закрывается.
        github.issue(12, "Доработка #11", "me", { labels: [], body: "/justai #11\nсоздай файл d.txt" });
        await runner.check();

        const files = run(remote, "ls-tree", "--name-only", "justai/issue-11");
        expect(files).toContain("c.txt");
        expect(files).toContain("d.txt");
        expect(github.closed).toEqual([12]);
        expect(github.comments.get(12)![0]!.body).toContain("правка к задаче #11");

        // Повторно та же правка не применяется.
        github.closed = [];
        await runner.check();
        expect(github.comments.get(11)).toHaveLength(4);
    }, 60_000);

    it("still delivers a pull request when the token cannot label or comment, and says why", async () => {
        github.denyIssueWrites = true;
        github.issue(20, "[justai] создай файл e.txt", "me", { labels: [] });

        await runner.check();

        expect(github.pulls).toEqual([expect.objectContaining({ head: "justai/issue-20" })]);
        expect(runner.getStatus()).toMatchObject({ state: "idle", warning: expect.stringContaining("Issues: Read and write") });
        expect(runner.getStatus().tasks[0]).toMatchObject({ issue: 20, status: "review" });
    }, 60_000);

    it("resumes a task interrupted by a restart, keeping the agent's unfinished changes", async () => {
        github.issue(30, "создай файл f.txt");
        await runner.check();

        // Имитация обрыва: состояние «в работе», папка на ветке задачи с незакоммиченной правкой агента.
        const stateFile = path.join(root, ".justai", "github-state.json");
        const fs = await import("node:fs/promises");
        const state = JSON.parse(await fs.readFile(stateFile, "utf8")) as { tasks: Record<string, { status: string }> };
        state.tasks["30"]!.status = "working";
        await fs.writeFile(stateFile, JSON.stringify(state));
        run(root, "checkout", "justai/issue-30");
        await fs.writeFile(path.join(root, "partial.txt"), "unfinished work", "utf8");

        const restarted = new GitHubTaskRunner({
            client: github as unknown as GitHubClient,
            git,
            sessions,
            permissions: new PermissionService({ rulesFile: path.join(root, ".justai", "p.json"), emit: () => undefined }),
            workspaceRoot: root,
            config: { label: "justai", allowedUsers: [], profile: "coder", provider: "mock", pollMs: 60_000, allowPublic: false, token: "" },
        });

        await restarted.check();

        expect(restarted.getStatus().tasks).toEqual([expect.objectContaining({ issue: 30, status: "review" })]);
        // Недописанная правка не потерялась: она в ветке задачи.
        expect(run(remote, "ls-tree", "--name-only", "justai/issue-30")).toContain("partial.txt");
        expect(run(root, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    }, 60_000);

    it("posts live progress, stops on «/justai stop» and resumes the same session on the next comment", async () => {
        // Отдельный исполнитель с «медленным» чтением: шаг длится, пока его не прервут.
        const slowTools = new ToolRegistry();
        slowTools.register(defineTool({
            name: "read_file",
            description: "slow read",
            inputSchema: z.object({ path: z.string() }),
            kind: "read",
            run: async ({ path: file }, context) => {
                if (file !== "slow.txt") return `contents of ${file}`;
                await new Promise<void>(resolve => {
                    const timer = setTimeout(resolve, 10_000);
                    context.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
                });
                return "slow contents";
            },
        }));

        const permissions = new PermissionService({ rulesFile: path.join(root, ".justai", "p2.json"), emit: () => undefined });
        const slowSessions = new SessionManager({
            store: new SessionStore(path.join(root, ".justai", "sessions")),
            providers: new ProviderRegistry({ JUSTAI_LAST_RESORT: "off" }),
            tools: slowTools,
            profiles: new AgentProfiles(),
            workspaceRoot: root,
            shouldIgnore: name => name === ".justai",
            limits: DEFAULT_BUDGET,
            permissions,
            emit: () => undefined,
        });
        const slow = new GitHubTaskRunner({
            client: github as unknown as GitHubClient,
            git,
            sessions: slowSessions,
            permissions,
            workspaceRoot: root,
            config: { label: "justai", allowedUsers: [], profile: "coder", provider: "mock", pollMs: 60_000, allowPublic: false, token: "", progressMs: 100 },
        });

        github.issue(40, "прочитай slow.txt");
        const running = slow.check();

        // Отчёт о ходе работы появился и обновляется, пока агент занят.
        const progress = () => github.comments.get(40)?.[0]?.body ?? "";
        for (let i = 0; i < 50 && !progress().includes("`read_file` slow.txt"); i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        expect(github.comments.get(40)![0]!.body).toContain("работает над задачей");
        expect(github.comments.get(40)![0]!.body).toContain("`read_file` slow.txt");
        expect(github.updates).toBeGreaterThan(0);

        github.comments.get(40)!.push({ id: 900, author: "me", body: "/justai stop", createdAt: "" });
        await running;

        expect(slow.getStatus().tasks).toEqual([expect.objectContaining({ issue: 40, status: "paused" })]);
        expect(github.issues.find(item => item.number === 40)!.labels).toContain(LABELS.paused);
        expect(github.comments.get(40)![0]!.body).toContain("остановлен по команде");
        expect(github.comments.get(40)!.at(-1)!.body).toContain("остановлен по команде");

        // Команда остановки — не правка: сама по себе работу не возобновляет.
        await slow.check();
        expect(slow.getStatus().tasks[0]!.status).toBe("paused");

        // Любой следующий комментарий — продолжение в той же сессии.
        github.comments.get(40)!.push({ id: 901, author: "me", body: "прочитай other.txt", createdAt: "" });
        await slow.check();

        expect(slow.getStatus().tasks[0]!.status).not.toBe("paused");
        const sessionList = await slowSessions.list();
        expect(sessionList).toHaveLength(1);
        const prompts = (await slowSessions.get(sessionList[0]!.id)).messages
            .filter(item => item.role === "user" && item.content.some(block => block.type === "text"));
        // Подсказки JustAI (проверка изменений: «ни один файл не изменён») — не запросы пользователя.
        expect(prompts.map(item => (item.content[0] as { text: string }).text.split("\n")[0]).filter(text => !text?.startsWith("[JustAI]"))).toEqual(["прочитай slow.txt", "прочитай other.txt"]);
    }, 60_000);

    it("runs a test task without changing files: project checks and screenshots in the report, no PASS without a verdict", async () => {
        await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "p", scripts: { test: "node -e \"console.log('tests ok')\"" } }));
        run(root, "add", "package.json");
        run(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "package");
        run(root, "push", "origin", "HEAD:main");

        // «Браузер» проверяющего: снимок экрана и мусор в папке, который после проверки должен исчезнуть.
        const tools = new ToolRegistry();
        tools.register(defineTool({
            name: "read_file",
            description: "fake screenshot",
            inputSchema: z.object({ path: z.string() }),
            kind: "read",
            run: async () => {
                await writeFile(path.join(root, "leftover.txt"), "test output");
                return [
                    { type: "text", text: "Screenshot of http://localhost:5173/ (viewport 375×812)." },
                    { type: "image", mediaType: "image/png", dataBase64: "iVBORw0KGgo=" },
                ];
            },
        }));

        const permissions = new PermissionService({ rulesFile: path.join(root, ".justai", "p3.json"), emit: () => undefined });
        const testSessions = new SessionManager({
            store: new SessionStore(path.join(root, ".justai", "sessions")),
            providers: new ProviderRegistry({ JUSTAI_LAST_RESORT: "off" }),
            tools,
            profiles: new AgentProfiles(),
            workspaceRoot: root,
            shouldIgnore: name => name === ".justai",
            limits: DEFAULT_BUDGET,
            permissions,
            emit: () => undefined,
        });
        const processes = new ProcessManager();
        const tester = new GitHubTaskRunner({
            client: github as unknown as GitHubClient,
            git,
            sessions: testSessions,
            permissions,
            workspaceRoot: root,
            processes,
            verifier: new Verifier({ processes, workspaceRoot: root, kinds: ["test"], timeoutMs: 60_000 }),
            config: { label: "justai", allowedUsers: [], profile: "coder", provider: "mock", pollMs: 60_000, allowPublic: false, token: "" },
        });

        github.issue(60, "[justai-test] прочитай страницу", "me", { labels: [] });
        await tester.check();

        const report = github.comments.get(60)!.at(-1)!.body;
        // Mock-агент не пишет «RESULT: PASS» и делает одно действие — это не подтверждённая проверка.
        expect(report).toContain("ветка `main`");
        expect(report).toContain("Проверки проекта");
        expect(report).toContain("✅ все прошли (1)");
        expect(report).toContain("viewport 375×812");
        expect(report).toContain(`![скриншот 1](https://github.com/me/project/blob/${ARTIFACTS_BRANCH}/screenshots/issue-60/`);
        expect(github.uploads).toEqual([expect.objectContaining({ branch: ARTIFACTS_BRANCH })]);

        // Ничего не закоммичено, PR нет, следы проверки убраны, папка на основной ветке.
        expect(github.pulls).toEqual([]);
        expect(run(remote, "branch", "--list", "justai/*").trim()).toBe("");
        expect(existsSync(path.join(root, "leftover.txt"))).toBe(false);
        expect(run(root, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
        expect(tester.getStatus().tasks).toEqual([{ issue: 60, status: "failed", branch: "main", kind: "test", checks: "passed" }]);
        expect(github.issues[0]!.labels).toContain(LABELS.failed);

        // Проверяющий работал без правки файлов.
        expect((await testSessions.list())[0]!.profile).toBe("tester");
    }, 90_000);

    it("runs «/justai run» commands on a task branch and refuses destructive ones", async () => {
        const processes = new ProcessManager();
        const commands = new GitHubTaskRunner({
            client: github as unknown as GitHubClient,
            git,
            sessions,
            permissions: new PermissionService({ rulesFile: path.join(root, ".justai", "p4.json"), emit: () => undefined }),
            workspaceRoot: root,
            processes,
            config: { label: "justai", allowedUsers: [], profile: "coder", provider: "mock", pollMs: 60_000, allowPublic: false, token: "" },
        });

        github.issue(70, "создай файл a.txt");
        await commands.check();
        const before = github.comments.get(70)!.length;

        // Команда в комментарии: выполняется в ветке задачи, агент не запускается.
        github.comments.get(70)!.push({ id: 500, author: "me", body: "/justai run node -p \"require('fs').existsSync('a.txt')\"", createdAt: "" });
        github.comments.get(70)!.push({ id: 501, author: "me", body: "/justai run git push origin main", createdAt: "" });
        await commands.check();

        const replies = github.comments.get(70)!.slice(before + 2);
        expect(replies[0]!.body).toContain("выполнил");
        expect(replies[0]!.body).toContain("ветке `justai/issue-70`");
        expect(replies[0]!.body).toContain("код выхода 0");
        expect(replies[0]!.body).toContain("true");
        expect(replies[1]!.body).toContain("⛔");
        expect(await sessions.list()).toHaveLength(1);
        expect(commands.getStatus().tasks[0]!.status).toBe("review");

        // Повторно те же команды не выполняются.
        await commands.check();
        expect(github.comments.get(70)!.length).toBe(before + 4);

        // Команда отдельным issue: результат в нём же, issue закрывается.
        github.issue(71, "Run", "me", { labels: [], body: "/justai run #70 node -p \"1+1\"" });
        await commands.check();
        expect(github.comments.get(71)![0]!.body).toMatch(/код выхода 0[\s\S]*\n2\n/);
        expect(github.closed).toContain(71);

        expect(run(root, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
        expect(run(root, "status", "--porcelain", "--", ".", ":(exclude).justai").trim()).toBe("");
    }, 90_000);

    it("writes the bridge feed: task, start, done, waiting, merged", async () => {
        const events: Array<{ kind: string; issue?: number; text: string }> = [];
        const bridge = new GitHubTaskRunner({
            client: github as unknown as GitHubClient,
            git,
            sessions,
            permissions: new PermissionService({ rulesFile: path.join(root, ".justai", "p9.json"), emit: () => undefined }),
            workspaceRoot: root,
            feed: { add: event => events.push(event) },
            config: { label: "justai", allowedUsers: [], profile: "coder", provider: "mock", pollMs: 60_000, allowPublic: false, token: "" },
        });
        github.onMerge = head => run(remote, "update-ref", "refs/heads/main", `refs/heads/${head}`);

        github.issue(90, "создай файл feed.txt");
        github.issue(91, "создай файл next.txt", "me", { body: "Depends on #90" });
        await bridge.check();
        await bridge.check();
        github.comments.get(90)!.push({ id: 900, author: "me", body: "/justai merge", createdAt: "" });
        await bridge.check();

        expect(events.map(event => `${event.kind}#${event.issue}`)).toEqual(["task#90", "start#90", "done#90", "waiting#91", "merged#90"]);
        expect(events[0]!.text).toContain("Задача от me");
        expect(events[2]!.text).toContain("Готово → PR 100");
    }, 90_000);

    it("waits for dependencies, merges on «/justai merge» and then starts the dependent task", async () => {
        github.onMerge = head => run(remote, "update-ref", "refs/heads/main", `refs/heads/${head}`);
        github.issue(80, "создай файл base.txt");
        github.issue(81, "создай файл next.txt", "me", { body: "Вторая часть.\nDepends on #80" });

        await runner.check();
        expect(runner.getStatus().tasks.map(task => task.issue)).toEqual([80]);

        // #81 ждёт и сообщает об этом один раз.
        await runner.check();
        await runner.check();
        expect(github.comments.get(81)).toHaveLength(1);
        expect(github.comments.get(81)![0]!.body).toContain("ждёт #80");

        github.comments.get(80)!.push({ id: 600, author: "me", body: "/justai merge", createdAt: "" });
        await runner.check();

        expect(github.merged).toEqual([100]);
        expect(github.closed).toContain(80);
        expect(github.deletedBranches).toEqual(["justai/issue-80"]);
        expect(github.issues.find(item => item.number === 80)!.labels).toContain(LABELS.merged);
        expect(github.comments.get(80)!.at(-1)!.body).toContain("слит в `main`");
        expect(runner.getStatus().tasks[0]).toMatchObject({ issue: 80, status: "merged" });

        // Зависимость закрыта — #81 начинается от обновлённой основной ветки.
        await runner.check();
        const files = run(remote, "ls-tree", "--name-only", "justai/issue-81");
        expect(files).toContain("base.txt");
        expect(files).toContain("next.txt");

        // Повторное слияние той же задачи не выполняется.
        github.issue(82, "Merge", "me", { labels: [], body: "/justai merge #80" });
        await runner.check();
        expect(github.merged).toEqual([100]);
        expect(github.comments.get(82)![0]!.body).toContain("она уже слита");
        expect(github.closed).toContain(82);
    }, 90_000);

    it("refuses to merge when the project checks fail or merging is off", async () => {
        await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "p", scripts: { test: "node -e \"process.exit(3)\"" } }));
        run(root, "add", "package.json");
        run(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "package");
        run(root, "push", "origin", "HEAD:main");

        const processes = new ProcessManager();
        const strict = new GitHubTaskRunner({
            client: github as unknown as GitHubClient,
            git,
            sessions,
            permissions: new PermissionService({ rulesFile: path.join(root, ".justai", "p5.json"), emit: () => undefined }),
            workspaceRoot: root,
            processes,
            verifier: new Verifier({ processes, workspaceRoot: root, kinds: ["test"], timeoutMs: 60_000 }),
            config: { label: "justai", allowedUsers: [], profile: "coder", provider: "mock", pollMs: 60_000, allowPublic: false, token: "" },
        });

        github.issue(90, "создай файл z.txt");
        await strict.check();
        expect(github.comments.get(90)!.at(-1)!.body).toContain("❌ не прошли: 1 из 1");

        github.comments.get(90)!.push({ id: 700, author: "me", body: "/justai merge", createdAt: "" });
        await strict.check();
        expect(github.merged).toEqual([]);
        // Красные проверки — задача не «готов PR», слить её нельзя.
        expect(strict.getStatus().tasks.find(task => task.issue === 90)).toMatchObject({ status: "failed", checks: "failed" });
        expect(github.comments.get(90)!.at(-1)!.body).toContain("слить нельзя");
        expect(run(root, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");

        const off = new GitHubTaskRunner({
            client: github as unknown as GitHubClient,
            git,
            sessions,
            permissions: new PermissionService({ rulesFile: path.join(root, ".justai", "p6.json"), emit: () => undefined }),
            workspaceRoot: root,
            config: { label: "justai", allowedUsers: [], profile: "coder", provider: "mock", pollMs: 60_000, allowPublic: false, token: "", merge: false },
        });
        github.comments.get(90)!.push({ id: 701, author: "me", body: "/justai merge", createdAt: "" });
        await off.check();
        expect(github.comments.get(90)!.at(-1)!.body).toContain("слияние на этом ПК выключено");
        expect(github.merged).toEqual([]);
    }, 90_000);

    it("closes issues on «/justai close #N …» and runs commands in main after the task branch is gone", async () => {
        const processes = new ProcessManager();
        const bridge = new GitHubTaskRunner({
            client: github as unknown as GitHubClient,
            git,
            sessions,
            permissions: new PermissionService({ rulesFile: path.join(root, ".justai", "p7.json"), emit: () => undefined }),
            workspaceRoot: root,
            processes,
            keepAwake: { acquire: () => { awake.held += 1; awake.total += 1; return () => { awake.held -= 1; }; } },
            config: { label: "justai", allowedUsers: [], profile: "coder", provider: "mock", pollMs: 60_000, allowPublic: false, token: "" },
        });
        const awake = { held: 0, total: 0 };

        github.issue(2, "old question", "me", { labels: [] });
        github.issue(3, "old task", "me", { labels: [] });
        github.issue(4, "Cleanup", "me", { labels: [], body: "/justai close #2, #3 #99" });
        await bridge.check();

        expect(github.closed).toEqual([2, 3, 4]);
        expect(github.comments.get(2)![0]!.body).toContain("по команде из #4");
        expect(github.comments.get(4)![0]!.body).toContain("закрыты #2, #3");
        expect(github.comments.get(4)![0]!.body).toContain("#99 — не найден");

        // Ветки задачи на GitHub нет — команда выполняется в main, а не падает.
        github.issue(70, "создай файл a.txt");
        await bridge.check();
        run(remote, "branch", "-D", "justai/issue-70");
        github.issue(71, "Run", "me", { labels: [], body: "/justai run #70 node -p \"1+1\"" });
        await bridge.check();
        expect(github.comments.get(71)![0]!.body).toContain("ветке `main`");
        expect(github.comments.get(71)![0]!.body).toContain("нет (задача слита");

        // Между задачами «Смотреть» ведёт в последнюю сессию моста.
        expect(bridge.getStatus()).toMatchObject({ state: "idle", lastIssue: 70, lastSessionId: expect.any(String) });

        // «/justai status» — мост на связи и что в очереди.
        github.issue(72, "Status", "me", { labels: [], body: "/justai status" });
        await bridge.check();
        expect(github.comments.get(72)![0]!.body).toContain("на связи");
        expect(github.comments.get(72)![0]!.body).toContain("готов PR: #70");
        expect(github.closed).toContain(72);

        // Пока шли задача и команда, компьютер держали бодрым; после — отпустили.
        expect(awake.total).toBe(2);
        expect(awake.held).toBe(0);
    }, 90_000);

    it("handles a task cut off by a restart before its session was saved: stop pauses it, otherwise it resumes", async () => {
        // Так застряла #115 в kaitos: «в работе» без сессии — ни продолжения, ни ответа на /justai stop.
        const fs = await import("node:fs/promises");
        const stateFile = path.join(root, ".justai", "github-state.json");
        await fs.mkdir(path.dirname(stateFile), { recursive: true });
        const orphan = (branch: string) => ({ sessionId: "", branch, status: "working", lastCommentId: 0, kind: "code" });
        await fs.writeFile(stateFile, JSON.stringify({ tasks: { "130": orphan("justai/issue-130"), "140": orphan("justai/issue-140") } }));

        github.issue(130, "создай файл p.txt");
        github.issue(131, "Stop", "me", { labels: [], body: "/justai stop #130" });
        await runner.check();

        expect(runner.getStatus().tasks.find(task => task.issue === 130)).toMatchObject({ status: "paused" });
        expect(github.comments.get(131)![0]!.body).toContain("остановлена");
        expect(github.closed).toContain(131);
        expect(github.issues.find(item => item.number === 130)!.labels).toContain(LABELS.paused);

        // Без команды остановки — продолжение в новой сессии.
        github.issue(140, "создай файл r.txt");
        await runner.check();
        expect(runner.getStatus().tasks.find(task => task.issue === 140)).toMatchObject({ status: "review" });
        expect(run(remote, "ls-tree", "--name-only", "justai/issue-140")).toContain("r.txt");
    }, 90_000);

    it("builds a task with «Base: #N» on top of that pull request's branch and opens its PR into it", async () => {
        // Правки к PR #113: ветка задачи — от его ветки, иначе файлов из PR в ней нет (так упала kaitos #132).
        run(root, "checkout", "-b", "arena/feature");
        await writeFile(path.join(root, "feature.txt"), "from planner");
        run(root, "add", "feature.txt");
        run(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "planner work");
        run(root, "push", "origin", "HEAD:refs/heads/arena/feature");
        run(root, "checkout", "main");
        github.foreignPulls.push({ number: 113, head: "arena/feature", sameRepo: true, state: "open" });

        github.issue(150, "создай файл fix.txt", "me", { body: "Поправить сценарий.\n\nBase: #113" });
        await runner.check();

        expect(run(remote, "ls-tree", "--name-only", "justai/issue-150")).toMatch(/feature\.txt[\s\S]*fix\.txt|fix\.txt[\s\S]*feature\.txt/);
        expect(github.pulls).toEqual([expect.objectContaining({ head: "justai/issue-150", base: "arena/feature" })]);
        // В отчёте только своё: относительно ветки PR изменился один файл.
        expect(github.comments.get(150)!.at(-1)!.body).toMatch(/всего в ветке: 1 file changed/);
        expect(run(root, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");

        // Неизвестная база — понятный отказ, а не задача на основной ветке.
        github.issue(151, "создай файл y.txt", "me", { body: "Base: #999" });
        await runner.check();
        expect(github.comments.get(151)![0]!.body).toContain("Base: #999");
        expect(runner.getStatus().tasks.find(task => task.issue === 151)).toMatchObject({ status: "failed" });
    }, 90_000);

    it("waits for a model that does not answer instead of failing the task, then continues by itself", async () => {
        const { MockProvider } = await import("../../../src/modules/agent/providers/MockProvider.js");
        const real = MockProvider.prototype.stream;
        let calls = 0;
        // Первый ход (правка файла) проходит, на втором модель перестаёт отвечать.
        MockProvider.prototype.stream = function (this: InstanceType<typeof MockProvider>, request) {
            calls += 1;
            if (calls === 1) return real.call(this, request);
            return (async function* () { throw new Error("Connection error. fetch failed"); })();
        } as typeof real;

        try {
            github.issue(160, "создай файл m.txt");
            await runner.check();

            const comments = github.comments.get(160)!;
            expect(comments.at(-1)!.body).toContain("модель не отвечает");
            expect(github.issues.find(item => item.number === 160)!.labels).not.toContain(LABELS.failed);
            expect(runner.getStatus().tasks.find(task => task.issue === 160)).toMatchObject({ status: "working" });

            // Пока модель не ответила, новые задачи не начинаются (и не проваливаются).
            github.issue(161, "создай файл n.txt");
            await runner.check();
            expect(runner.getStatus().tasks.find(task => task.issue === 161)).toBeUndefined();
        }
        finally {
            MockProvider.prototype.stream = real;
        }

        // Модель вернулась: задача продолжается сама и доходит до PR.
        (runner as unknown as { modelDownUntil: number }).modelDownUntil = 0;
        await runner.check();
        expect(runner.getStatus().tasks.find(task => task.issue === 160)).toMatchObject({ status: "review" });
        expect(github.comments.get(160)!.filter(item => item.body.includes("Задача не провалена"))).toHaveLength(1);
    }, 90_000);

    it("restarts a hung local model on a timeout and gives up after a few attempts instead of retrying all night", async () => {
        const { MockProvider } = await import("../../../src/modules/agent/providers/MockProvider.js");
        const real = MockProvider.prototype.stream;
        MockProvider.prototype.stream = function () {
            return (async function* () { throw new Error("Request timed out."); })();
        } as typeof real;

        let heals = 0;
        const bridge = new GitHubTaskRunner({
            client: github as unknown as GitHubClient,
            git,
            sessions,
            permissions: new PermissionService({ rulesFile: path.join(root, ".justai", "p-heal.json"), emit: () => undefined }),
            workspaceRoot: root,
            healModel: async () => { heals += 1; return true; },
            config: { label: "justai", allowedUsers: [], profile: "coder", provider: "mock", pollMs: 60_000, allowPublic: false, token: "" },
        });
        const retryNow = () => { (bridge as unknown as { modelDownUntil: number }).modelDownUntil = 0; };

        try {
            github.issue(165, "создай файл h.txt");

            for (let attempt = 1; attempt <= 6; attempt += 1) {
                await bridge.check();
                retryNow();
            }

            expect(heals).toBe(6);
            // Одно сообщение «⏳» на все попытки, а не по сообщению на каждую.
            expect(github.comments.get(165)!.filter(item => item.body.includes("Задача не провалена"))).toHaveLength(1);
            expect(bridge.getStatus().tasks.find(task => task.issue === 165)).toMatchObject({ status: "working" });

            // Седьмая подряд — провал с понятной причиной.
            await bridge.check();
            expect(bridge.getStatus().tasks.find(task => task.issue === 165)).toMatchObject({ status: "failed" });
            expect(github.comments.get(165)!.at(-1)!.body).toContain("Модель не отвечала 7 попыток подряд");
            expect(github.issues.find(item => item.number === 165)!.labels).toContain(LABELS.failed);
        }
        finally {
            MockProvider.prototype.stream = real;
            await bridge.stop();
        }
    }, 120_000);

    it("does not fail a task on a network error to GitHub: it continues by itself and keeps local commits", async () => {
        const realFind = github.findPullRequest.bind(github);
        let failures = 1;
        github.findPullRequest = async (head: string) => {
            if (failures-- > 0) throw new TypeError("fetch failed");
            return realFind(head);
        };

        github.issue(166, "создай файл net.txt");
        await runner.check();
        expect(runner.getStatus().tasks.find(task => task.issue === 166)).toMatchObject({ status: "working" });
        expect(github.issues.find(item => item.number === 166)!.labels).not.toContain(LABELS.failed);

        (runner as unknown as { modelDownUntil: number }).modelDownUntil = 0;
        await runner.check();
        expect(runner.getStatus().tasks.find(task => task.issue === 166)).toMatchObject({ status: "review" });
        expect(run(remote, "ls-tree", "--name-only", "justai/issue-166")).toContain("net.txt");
    }, 90_000);

    it("removes a stale «working» label left by a network failure", async () => {
        const fs = await import("node:fs/promises");
        const stateFile = path.join(root, ".justai", "github-state.json");
        await fs.mkdir(path.dirname(stateFile), { recursive: true });
        await fs.writeFile(stateFile, JSON.stringify({ tasks: { "167": { sessionId: "", branch: "justai/issue-167", status: "failed", lastCommentId: 0, kind: "code" } } }));

        github.issue(167, "Задача", "me", { labels: ["justai", LABELS.working] });
        await runner.check();

        expect(github.issues.find(item => item.number === 167)!.labels).toEqual(["justai", LABELS.failed]);
    });

    it("merges a pull request's branch into a started task when a follow-up says «Base: #N»", async () => {
        github.issue(180, "создай файл base.txt");
        await runner.check();
        expect(github.pulls[0]).toMatchObject({ head: "justai/issue-180", base: "main" });

        run(root, "checkout", "-b", "arena/feature", "main");
        await writeFile(path.join(root, "feature.txt"), "from planner");
        run(root, "add", "feature.txt");
        run(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "planner work");
        run(root, "push", "origin", "HEAD:refs/heads/arena/feature");
        run(root, "checkout", "main");
        github.foreignPulls.push({ number: 113, head: "arena/feature", sameRepo: true, state: "open" });

        github.issue(181, "Continue", "me", { labels: [], body: "/justai continue #180\nBase: #113\nсоздай файл more.txt" });
        await runner.check();

        expect(run(remote, "ls-tree", "--name-only", "justai/issue-180")).toContain("feature.txt");
        expect(github.rebased).toEqual([{ number: 100, base: "arena/feature" }]);
        expect(github.comments.get(180)!.some(item => item.body.includes("влита ветка `arena/feature`"))).toBe(true);
    }, 90_000);

    /** Агент по сценарию: первый ход — вызовы инструментов, дальше (после результатов и подсказок JustAI) — текст. */
    async function scriptedAgent(steps: Array<Array<{ name: string; input: unknown }>>, finalText = "Готово.") {
        const { MockProvider } = await import("../../../src/modules/agent/providers/MockProvider.js");
        const real = MockProvider.prototype.stream;
        let turn = 0;
        MockProvider.prototype.stream = function (request) {
            const calls = steps[turn];
            turn += 1;
            return real.call(new MockProvider([calls ? { toolCalls: calls } : { text: finalText }]), request);
        } as typeof real;
        return () => { MockProvider.prototype.stream = real; };
    }

    it("keeps dependencies and temporary files out of the pull request", async () => {
        const restore = await scriptedAgent([[
            { name: "write_file", input: { path: "a.txt", content: "a\n" } },
            { name: "write_file", input: { path: "node_modules/pkg/index.js", content: "x\n" } },
            { name: "write_file", input: { path: "README_original.tmp", content: "old\n" } },
        ]]);

        try {
            github.issue(185, "Добавь a.txt");
            await runner.check();
        }
        finally {
            restore();
        }

        const files = run(remote, "ls-tree", "-r", "--name-only", "justai/issue-185");
        expect(files).toContain("a.txt");
        expect(files).not.toContain("node_modules");
        expect(files).not.toContain("README_original.tmp");
        // node_modules даже не попадает в индекс (.git/info/exclude), временный файл — убран из коммита с пометкой.
        expect(github.comments.get(185)!.at(-1)!.body).toMatch(/Не попало в коммит[\s\S]*README_original\.tmp/);
        // Временный файл не удалён, а убран в stash.
        expect(run(root, "stash", "list")).toContain("временные файлы задачи #185");
        expect(runner.getStatus().tasks.find(task => task.issue === 185)).toMatchObject({ status: "review" });
    }, 90_000);

    it("does not call a task ready when the diff shows a truncated file or files outside the task", async () => {
        await writeFile(path.join(root, "README.md"), Array.from({ length: 40 }, (_, i) => `Раздел ${i + 1}`).join("\n") + "\n");
        run(root, "add", "README.md");
        run(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "readme");
        run(root, "push", "origin", "HEAD:main");

        const restore = await scriptedAgent([
            [{ name: "read_file", input: { path: "README.md" } }],
            [{ name: "write_file", input: { path: "README.md", content: "Новый короткий текст\n", confirm_shrink: true } }, { name: "write_file", input: { path: "other.js", content: "x\n" } }],
        ], "Обновил README.");

        try {
            github.issue(186, "Раздел «Запуск» в README", "me", { body: "Добавь в `README.md` раздел «Запуск». Не меняй другие файлы." });
            await runner.check();
        }
        finally {
            restore();
        }

        const report = github.comments.get(186)!.at(-1)!.body;
        expect(report).toContain("Проверка изменений не пройдена");
        expect(report).toMatch(/`README\.md` обрезан: было 41 строк, осталось 2/);
        expect(report).toMatch(/вне задачи: `other\.js`/);
        expect(runner.getStatus().tasks.find(task => task.issue === 186)).toMatchObject({ status: "failed" });

        // Агенту один раз вернули найденное — до решения о готовности.
        const session = (await sessions.list()).find(item => item.title.includes("#186"))!;
        const texts = (await sessions.get(session.id)).messages.flatMap(item => item.content).filter(block => block.type === "text").map(block => (block as { text: string }).text);
        expect(texts.filter(text => text.startsWith("[JustAI] Перед завершением"))).toHaveLength(1);
    }, 90_000);

    it("moves a task to a new session when its old session has another profile", async () => {
        const old = await sessions.create({ profile: "general", provider: "mock", mode: "full-auto" });
        const fs = await import("node:fs/promises");
        const stateFile = path.join(root, ".justai", "github-state.json");
        await fs.mkdir(path.dirname(stateFile), { recursive: true });
        await fs.writeFile(stateFile, JSON.stringify({ tasks: { "187": { sessionId: old.id, branch: "justai/issue-187", status: "paused", lastCommentId: 0, kind: "code" } } }));

        github.issue(187, "создай файл p.txt");
        github.comments.set(187, [{ id: 900, author: "me", body: "создай файл p.txt", createdAt: "" }]);
        await runner.check();

        const task = JSON.parse(await fs.readFile(stateFile, "utf8")).tasks["187"];
        expect(task.sessionId).not.toBe(old.id);
        expect((await sessions.get(task.sessionId)).session.profile).toBe("coder");
        expect(run(remote, "ls-tree", "--name-only", "justai/issue-187")).toContain("p.txt");
    }, 90_000);

    it("checks the format of a branch's e2e scenarios without starting anything («/justai e2e check»)", async () => {
        await import("node:fs/promises").then(fs => fs.mkdir(path.join(root, "tests", "e2e"), { recursive: true }));
        await writeFile(path.join(root, "tests", "e2e", "good.yml"), "steps:\n  - click: '#a'\n  - expectVisible: '#b'\n");
        await writeFile(path.join(root, "tests", "e2e", "bad.yml"), "steps:\n  - clik: '#a'\n");
        run(root, "add", "tests");
        run(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "scenarios");
        run(root, "push", "origin", "HEAD:main");

        github.issue(170, "Check", "me", { labels: [], body: "/justai e2e check" });
        await runner.check();

        const reply = github.comments.get(170)![0]!.body;
        expect(reply).toContain("1 из 2 сценариев разобраны");
        expect(reply).toMatch(/✓ \| `tests\/e2e\/good\.yml` \| 2 шаг/);
        expect(reply).toMatch(/✕ \| `tests\/e2e\/bad\.yml` \| Step 1: unknown action "clik"/);
        expect(github.closed).toContain(170);
    }, 60_000);

    it("tells model outages apart from task failures", () => {
        expect(isModelUnavailable("Connection error.")).toBe(true);
        expect(isModelUnavailable("429 Rate limit exceeded: free-models-per-day")).toBe(true);
        expect(isModelUnavailable("Request timed out.")).toBe(true);
        expect(isModelUnavailable("Budget exhausted: time limit reached (60 min).")).toBe(false);
        expect(isModelUnavailable("Blocked: the agent kept re-reading files")).toBe(false);
        expect(baseTarget("Цель: …\n\nBase: #113")).toBe(113);
        expect(baseTarget("- **База:** #7")).toBe(7);
        expect(baseTarget("see base #3 in the text")).toBeNull();
    });

    it("reads which files a task names and whether it restricts changes to them", () => {
        const text = "Добавь в `README.md` раздел, поправь server/index.js и сценарии в tests/e2e/. Версия 1.2.3, см. https://x.io/a.html. Не меняй другие файлы.";
        expect(mentionedFiles(text)).toEqual(["README.md", "server/index.js", "tests/e2e/"]);
        expect(restrictsFiles(text)).toBe(true);
        expect(restrictsFiles("Исправь только start.bat")).toBe(true);
        expect(restrictsFiles("Добавь страницу и тесты")).toBe(false);
        expect(isTempFile("README_original.tmp")).toBe(true);
        expect(isTempFile("src/app.js.bak")).toBe(true);
        expect(isTempFile("notes~")).toBe(true);
        expect(isTempFile("src/bold.js")).toBe(false);
        expect(isDependencyPath("web/node_modules/a/index.js")).toBe(true);
        expect(isDependencyPath("src/modules/a.js")).toBe(false);
    });

    it("runs commands on the branch of any pull request of the repository, not only bridge tasks", async () => {
        // PR #113 сделал сам планировщик в ветке arena/feature — проверить его через ПК1.
        run(root, "checkout", "-b", "arena/feature");
        await writeFile(path.join(root, "feature.txt"), "from planner");
        run(root, "add", "feature.txt");
        run(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "planner work");
        run(root, "push", "origin", "HEAD:refs/heads/arena/feature");
        run(root, "checkout", "main");
        github.foreignPulls.push({ number: 113, head: "arena/feature", sameRepo: true, state: "open" }, { number: 114, head: "x", sameRepo: false, state: "open" });

        const bridge = new GitHubTaskRunner({
            client: github as unknown as GitHubClient,
            git,
            sessions,
            permissions: new PermissionService({ rulesFile: path.join(root, ".justai", "p10.json"), emit: () => undefined }),
            workspaceRoot: root,
            processes: new ProcessManager(),
            config: { label: "justai", allowedUsers: [], profile: "coder", provider: "mock", pollMs: 60_000, allowPublic: false, token: "" },
        });

        github.issue(120, "Run", "me", { labels: [], body: "/justai run #113 node -p \"require('fs').existsSync('feature.txt')\"" });
        await bridge.check();
        expect(github.comments.get(120)![0]!.body).toContain("ветке `arena/feature`");
        expect(github.comments.get(120)![0]!.body).toMatch(/код выхода 0[\s\S]*true/);

        github.issue(121, "Run", "me", { labels: [], body: "/justai run #114 node -v" });
        await bridge.check();
        expect(github.comments.get(121)![0]!.body).toContain("из форка");

        github.issue(122, "Run", "me", { labels: [], body: "/justai run #999 node -v" });
        await bridge.check();
        expect(github.comments.get(122)![0]!.body).toContain("не задача JustAI и не pull request");
    }, 90_000);

    it("does not count a test as PASS without a verdict, actions or the screenshots it asked for", () => {
        const step = (id: string, name: string) => [
            createMessage("assistant", [{ type: "tool_use", id, name, input: {} }]),
            createMessage("user", [{ type: "tool_result", toolUseId: id, content: "ok", isError: false }]),
        ];
        const finish = (text: string) => createMessage("assistant", [{ type: "text", text }]);
        const work = [...step("a", "run_command"), ...step("b", "browser_open"), ...step("c", "browser_click")];

        expect(testEvidence([...step("a", "run_command"), finish("all good")], "check").problem).toContain("не дал вердикт");
        expect(testEvidence([...step("a", "run_command"), finish("RESULT: PASS")], "check").problem).toContain("всего 1");
        expect(testEvidence([...work, finish("RESULT: PASS")], "сделай скриншот").problem).toContain("ни одного");
        expect(testEvidence([...work, finish("RESULT: PASS")], "check")).toEqual({ actions: 3, screenshots: 0, problem: null });
        expect(testEvidence([...work, finish("RESULT: FAIL")], "check").problem).toContain("RESULT: FAIL");
        expect(closeCommand({ number: 9, title: "x", body: "/justai close #2 #3, #9", author: "me", labels: [], url: "", isPullRequest: false }, "justai")).toEqual([2, 3]);
    });

    it("starts the app, runs e2e scenarios from issues and refuses to merge when tests/e2e fail", async (test) => {
        const browser = new BrowserService();
        const probe = await browser.page("probe").then(() => true, () => false);
        await browser.close("probe");
        if (!probe) test.skip();

        await writeFile(path.join(root, "index.html"), "<!doctype html><title>Site</title><h1 id=\"title\">Привет</h1>");
        const fs = await import("node:fs/promises");
        await fs.mkdir(path.join(root, "tests", "e2e"), { recursive: true });
        await writeFile(path.join(root, "tests", "e2e", "title.yml"), "name: title\nsteps:\n  - expectText: { selector: '#title', contains: 'Пока' }\n");
        run(root, "add", "-A");
        run(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "site");
        run(root, "push", "origin", "HEAD:main");

        const processes = new ProcessManager();
        const bridge = new GitHubTaskRunner({
            client: github as unknown as GitHubClient,
            git,
            sessions,
            permissions: new PermissionService({ rulesFile: path.join(root, ".justai", "p8.json"), emit: () => undefined }),
            workspaceRoot: root,
            processes,
            e2eBrowser: browser,
            config: { label: "justai", allowedUsers: [], profile: "coder", provider: "mock", pollMs: 60_000, allowPublic: false, token: "" },
        });

        try {
            // Приложение: встроенный статический сервер из отдельной рабочей копии.
            github.issue(80, "App", "me", { labels: [], body: "/justai app start" });
            await bridge.check();
            expect(github.comments.get(80)![0]!.body).toContain("приложение запущено");
            expect(github.comments.get(80)![0]!.body).toContain("built-in static server");
            expect(existsSync(path.join(root, ".justai", "worktrees", "main", "index.html"))).toBe(true);

            // Сценарий из issue: приложение переиспользуется, вердикт ставит программа.
            github.issue(81, "E2E", "me", { labels: [], body: "Проверка\n/justai e2e\n```yaml\nname: hello\nsteps:\n  - expectText: { selector: '#title', contains: 'Привет' }\n  - screenshot: home\n```" });
            await bridge.check();
            const report = github.comments.get(81)![0]!.body;
            expect(report).toContain("✅ PASS");
            expect(report).toContain("![home (1280px)]");
            expect(github.closed).toContain(81);

            github.issue(82, "Stop", "me", { labels: [], body: "/justai app stop" });
            await bridge.check();
            expect(github.comments.get(82)![0]!.body).toContain("остановлено");
            expect(existsSync(path.join(root, ".justai", "worktrees", "main"))).toBe(false);
            // Основная папка проекта не тронута.
            expect(run(root, "status", "--porcelain", "--", ".", ":(exclude).justai").trim()).toBe("");

            // Слияние: проверки tests/e2e упали — PR не сливается.
            github.issue(83, "создай файл z.txt");
            await bridge.check();
            github.comments.get(83)!.push({ id: 800, author: "me", body: "/justai merge", createdAt: "" });
            await bridge.check();
            expect(github.merged).toEqual([]);
            expect(github.comments.get(83)!.some(comment => comment.body.includes("❌ FAIL") && comment.body.includes("title"))).toBe(true);
            expect(github.comments.get(83)!.at(-1)!.body).toContain("сценарии `tests/e2e` не прошли");
        }
        finally {
            await bridge.stop();
            await browser.closeAll();
        }
    }, 180_000);

    it("drops dependencies that are already closed from the status", () => {
        const state = { tasks: {}, waiting: { "6": [5], "7": [6], "8": [5, 7] } };
        const report = statusReport(state, new Set([6, 7, 8]), "task");

        expect(report).toContain("#7 (ждёт #6)");
        expect(report).toContain("#8 (ждёт #7)");
        expect(report).not.toContain("#6 (ждёт");
    });

    it("recognises app and e2e commands", () => {
        expect(appCommand("/justai app start #5", "justai")).toEqual({ action: "start", target: 5 });
        expect(appCommand("text\n/justai app logs\n", "justai")).toEqual({ action: "logs" });
        expect(appCommand("/justai app restart", "justai")).toBeNull();
        expect(e2eCommand("/justai e2e #7 all", "justai")).toEqual({ target: 7, files: "all" });
        expect(e2eCommand("/justai e2e", "justai")).toEqual({});
        expect(e2eCommand("/justai e2e tests/e2e/menu.yml", "justai")).toEqual({ files: "tests/e2e/menu.yml" });
    });

    it("recognises dependencies and merge commands", () => {
        const make = (body: string) => ({ number: 1, title: "x", body, author: "me", labels: [], url: "", isPullRequest: false });

        expect(dependsOn("Сделай страницу.\nDepends on #3, #4\n")).toEqual([3, 4]);
        expect(dependsOn("- **Зависит от:** #7")).toEqual([7]);
        expect(dependsOn("See #3 for context")).toEqual([]);
        expect(isMergeCommand("/justai merge", "justai")).toBe(true);
        expect(isMergeCommand("do not /justai merge yet", "justai")).toBe(false);
        expect(followUpCommand(make("/justai merge #5"), "justai")).toEqual({ target: 5, action: "merge" });
    });

    it("recognises test tasks, run commands and test verdicts", () => {
        const make = (title: string, body: string) => ({ number: 1, title, body, author: "me", labels: [], url: "", isPullRequest: false });

        expect(isTestTask(make("[justai-test] Check the page", ""), "justai")).toBe(true);
        expect(isTestTask(make("Check", "steps\n/justai test #4"), "justai")).toBe(true);
        expect(isTestTask(make("[justai] Add page", ""), "justai")).toBe(false);
        expect(isTask(make("[justai-test] Check", ""), "justai")).toBe(false);
        expect(testTarget(make("Check", "/justai test #4"), "justai")).toBe(4);
        expect(testTarget(make("Check", "/justai test"), "justai")).toBeNull();

        expect(runIssueCommand(make("Run", "/justai run #3 npm test\n"), "justai")).toEqual({ target: 3, command: "npm test" });
        expect(runIssueCommand(make("Run", "/justai run npm run build"), "justai")).toEqual({ command: "npm run build" });
        expect(runIssueCommand(make("Task", "Описание\n/justai run npm test"), "justai")).toBeNull();
        expect(runCommentCommand("/justai run npm test", "justai")).toBe("npm test");
        expect(runCommentCommand("please run npm test", "justai")).toBeNull();
        expect(followUpTarget(make("Run", "/justai run #3 npm test"), "justai")).toBeNull();

        expect(testVerdict("all good\nRESULT: PASS")).toBe("pass");
        expect(testVerdict("RESULT: PASS\n...\n**RESULT: FAIL**")).toBe("fail");
        expect(testVerdict("no verdict")).toBe("unknown");

        const report = checksReport({
            status: "failed",
            checks: [
                { cwd: ".", command: "npm run typecheck", ok: true, exitCode: 0, output: "" },
                { cwd: "web", command: "npm test", ok: false, exitCode: 1, output: "FAIL src/app.test.ts\nexpected 2" },
            ],
        });
        expect(report).toContain("❌ не прошли: 1 из 2");
        expect(report).toContain("- ✓ `npm run typecheck`");
        expect(report).toContain("- ✕ `npm test` в web — код выхода 1");
        expect(report).toContain("expected 2");
    });

    it("builds a progress report with the plan, recent actions and repeated errors", () => {
        const messages = [
            createMessage("assistant", [{ type: "tool_use", id: "p", name: "todo_write", input: { todos: [{ content: "index.html", status: "completed" }, { content: "style.css", status: "in_progress" }] } }]),
            createMessage("user", [{ type: "tool_result", toolUseId: "p", content: "ok", isError: false }]),
            ...[1, 2, 3].flatMap(n => [
                createMessage("assistant", [{ type: "tool_use", id: `e${n}`, name: "edit_file", input: { path: "css/style.css" } }]),
                createMessage("user", [{ type: "tool_result", toolUseId: `e${n}`, content: "old_string was not found in css/style.css.", isError: true }]),
            ]),
        ];

        const report = progressReport("⏳ working", messages, "justai/issue-5", 5, "justai");

        expect(report).toContain("Шагов: 4");
        expect(report).toContain("- [x] index.html");
        expect(report).toContain("- [ ] style.css ← сейчас");
        expect(report).toContain("✕ `edit_file` css/style.css — old_string was not found in css/style.css.");
        expect(report).toContain("повторяется 3 раза подряд");
        expect(report).toContain("/justai stop #5");
    });

    it("recognises stop and continue commands", () => {
        const make = (body: string) => ({ number: 1, title: "x", body, author: "me", labels: [], url: "", isPullRequest: false });

        expect(followUpCommand(make("/justai stop #5"), "justai")).toEqual({ target: 5, action: "stop" });
        expect(followUpCommand(make("/justai continue #5\nmore"), "justai")).toEqual({ target: 5, action: "continue" });
        expect(followUpCommand(make("/justai #5"), "justai")).toEqual({ target: 5, action: "continue" });
        expect(isStopCommand("please\n/justai stop\n", "justai")).toBe(true);
        expect(isStopCommand("do not /justai stop yet", "justai")).toBe(false);
    });

    it("recognises task markers and follow-ups", () => {
        const make = (title: string, body: string, labels: string[] = []) => ({ number: 1, title, body, author: "me", labels, url: "", isPullRequest: false });

        expect(isTask(make("[JustAI] Add page", ""), "justai")).toBe(true);
        expect(isTask(make("Add page", "details\n/justai\n"), "justai")).toBe(true);
        expect(isTask(make("Add page", "", ["justai"]), "justai")).toBe(true);
        expect(isTask(make("Add page", "see /justai docs"), "justai")).toBe(false);
        expect(followUpTarget(make("Fix", "/justai #3\nmake it blue"), "justai")).toBe(3);
        expect(followUpTarget(make("Fix", "/justai"), "justai")).toBeNull();
        expect(stripCommands("/justai #3\nmake it blue", "justai")).toBe("make it blue");
    });

    it("ignores tasks from other people, public repositories and dirty workspaces", async () => {
        github.issue(3, "создай файл evil.txt", "stranger");
        await runner.check();
        expect(github.comments.get(3)).toBeUndefined();

        github.isPrivateRepo = false;
        github.issue(4, "создай файл x.txt");
        await runner.check();
        expect(runner.getStatus()).toMatchObject({ state: "error", lastError: expect.stringContaining("public") });
        expect(github.comments.get(4)).toBeUndefined();

        github.isPrivateRepo = true;
        await import("node:fs/promises").then(fs => fs.writeFile(path.join(root, "user-work.txt"), "unsaved"));
        const waiting = new GitHubTaskRunner({
            client: github as unknown as GitHubClient,
            git,
            sessions,
            permissions: new PermissionService({ rulesFile: path.join(root, ".justai", "pw.json"), emit: () => undefined }),
            workspaceRoot: root,
            config: { label: "justai", allowedUsers: [], profile: "coder", provider: "mock", pollMs: 60_000, allowPublic: false, token: "", autoStash: false },
        });
        await waiting.check();
        await waiting.check();
        expect(waiting.getStatus().lastError).toContain("uncommitted changes");
        // Не молчит: один раз пишет в задачу, что ждёт чистую папку, и какие файлы мешают.
        expect(github.comments.get(4)).toHaveLength(1);
        expect(github.comments.get(4)![0]!.body).toContain("user-work.txt");
        expect(existsSync(path.join(root, "user-work.txt"))).toBe(true);
    }, 60_000);

    it("commits even when the project's .gitignore lists .justai, and tidies leftovers into git stash", async () => {
        // Так упала задача #5 в kaitos: «The following paths are ignored by one of your .gitignore files: .justai».
        await writeFile(path.join(root, ".gitignore"), ".justai/\nnode_modules/\n");
        run(root, "add", ".gitignore");
        run(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "gitignore");
        run(root, "push", "origin", "HEAD:main");

        // Следы прерванной задачи в папке: раньше мост из-за них молча переставал брать задачи.
        await writeFile(path.join(root, "leftover.json"), "{}");

        github.issue(95, "создай файл ok.txt");
        await runner.check();

        expect(run(remote, "ls-tree", "--name-only", "justai/issue-95")).toContain("ok.txt");
        expect(run(remote, "ls-tree", "--name-only", "justai/issue-95")).not.toContain("leftover.json");
        expect(github.comments.get(95)!.some(comment => comment.body.includes("git stash") && comment.body.includes("leftover.json"))).toBe(true);
        expect(run(root, "stash", "list")).toContain("JustAI");
        expect(runner.getStatus().tasks[0]).toMatchObject({ issue: 95, status: "review" });
    }, 60_000);

    it("works only in a clone of the configured repository", () => {
        expect(originMatches("https://github.com/koolo4/test_1.git", "koolo4/test_1")).toBe(true);
        expect(originMatches("https://github.com/Koolo4/Test_1", "koolo4/test_1")).toBe(true);
        expect(originMatches("git@github.com:koolo4/test_1.git", "koolo4/test_1")).toBe(true);
        expect(originMatches("https://github.com/koolo4/other.git", "koolo4/test_1")).toBe(false);
        expect(originMatches("https://gitlab.com/koolo4/test_1.git", "koolo4/test_1")).toBe(false);
        expect(originMatches("", "koolo4/test_1")).toBe(false);
        expect(originMatches("C:\\temp\\remote.git", "koolo4/test_1")).toBe(true);
    });

    it("puts the task title first in the prompt", () => {
        const prompt = taskPrompt({ number: 7, title: "Add login page", body: "Use React.", author: "me", labels: [], url: "", isPullRequest: false }, "justai/issue-7");

        expect(prompt.split("\n")[0]).toBe("Add login page");
        expect(prompt).toContain("GitHub task #7");
        expect(prompt).toContain("Do not commit or push");
    });
});
