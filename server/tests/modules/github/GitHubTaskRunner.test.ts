import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
import { followUpCommand, followUpTarget, GitHubTaskRunner, isStopCommand, isTask, LABELS, originMatches, progressReport, stripCommands, taskPrompt } from "../../../src/modules/github/GitHubTaskRunner.js";

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

    public async findPullRequest(head: string) {
        const pull = this.pulls.find(item => item.head === head);
        return pull ? { number: pull.number, url: pull.url, head, state: "open" } : null;
    }

    public async createPullRequest(head: string, base: string, _title: string, body: string) {
        const pull = { number: 100 + this.pulls.length, url: `https://github.com/me/project/pull/${100 + this.pulls.length}`, head, base, body };
        this.pulls.push(pull);
        return { number: pull.number, url: pull.url, head, state: "open" };
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
        expect(report).toContain("finished this step");
        expect(report).toContain("pull/100");
        expect(report).toContain(BOT_MARKER);

        // Рабочая папка вернулась на основную ветку и чистая.
        expect(run(root, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
        expect(existsSync(path.join(root, "notes", "todo.md"))).toBe(false);
        expect(runner.getStatus().tasks).toEqual([{ issue: 1, status: "review", branch: "justai/issue-1", pullRequest: "https://github.com/me/project/pull/100" }]);
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
        expect(github.comments.get(40)!.at(-1)!.body).toContain("stopped on request");

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
        expect(prompts.map(item => (item.content[0] as { text: string }).text.split("\n")[0])).toEqual(["прочитай slow.txt", "прочитай other.txt"]);
    }, 60_000);

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
        await runner.check();
        expect(runner.getStatus().lastError).toContain("uncommitted changes");
        expect(github.comments.get(4)).toBeUndefined();
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
