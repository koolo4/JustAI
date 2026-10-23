import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
import { BOT_MARKER, type GitHubClient, type GitHubComment, type GitHubIssue } from "../../../src/modules/github/GitHubClient.js";
import { GitHubTaskRunner, LABELS, taskPrompt } from "../../../src/modules/github/GitHubTaskRunner.js";

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
    public async listIssues(label: string) { return this.issues.filter(issue => issue.labels.includes(label)); }
    public async listComments(number: number) { return this.comments.get(number) ?? []; }

    public async comment(number: number, body: string, asBot = true) {
        const list = this.comments.get(number) ?? [];
        list.push({ id: this.nextComment++, author: "me", body: asBot ? `${body}\n\n${BOT_MARKER}` : body, createdAt: "" });
        this.comments.set(number, list);
    }

    public async addLabels(number: number, labels: string[]) {
        const issue = this.issues.find(item => item.number === number)!;
        issue.labels = [...new Set([...issue.labels, ...labels])];
    }

    public async removeLabel(number: number, label: string) {
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

    public issue(number: number, title: string, author = "me"): GitHubIssue {
        const issue = { number, title, body: "", author, labels: ["justai"], url: `https://github.com/me/project/issues/${number}`, isPullRequest: false };
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

        const report = github.comments.get(1)![0]!.body;
        expect(report).toContain("finished this step");
        expect(report).toContain("pull/100");
        expect(report).toContain(BOT_MARKER);

        // Рабочая папка вернулась на основную ветку и чистая.
        expect(run(root, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
        expect(existsSync(path.join(root, "notes", "todo.md"))).toBe(false);
        expect(runner.getStatus().tasks).toEqual([{ issue: 1, status: "review", branch: "justai/issue-1", pullRequest: "https://github.com/me/project/pull/100" }]);
    }, 60_000);

    it("continues on the same branch when the owner comments, and ignores its own reports", async () => {
        github.issue(2, "создай файл a.txt");
        await runner.check();

        // Собственный отчёт JustAI не считается правкой.
        await runner.check();
        expect(github.comments.get(2)).toHaveLength(1);

        github.comments.get(2)!.push({ id: 50, author: "me", body: "создай файл b.txt", createdAt: "" });
        await runner.check();

        const files = run(remote, "ls-tree", "--name-only", "justai/issue-2");
        expect(files).not.toContain(".justai");
        expect(files).toContain("a.txt");
        expect(files).toContain("b.txt");
        expect(github.pulls).toHaveLength(1);
        expect(github.comments.get(2)).toHaveLength(3);
    }, 60_000);

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

    it("puts the task title first in the prompt", () => {
        const prompt = taskPrompt({ number: 7, title: "Add login page", body: "Use React.", author: "me", labels: [], url: "", isPullRequest: false }, "justai/issue-7");

        expect(prompt.split("\n")[0]).toBe("Add login page");
        expect(prompt).toContain("GitHub task #7");
        expect(prompt).toContain("Do not commit or push");
    });
});
