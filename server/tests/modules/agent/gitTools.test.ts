import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GitService } from "../../../src/infrastructure/git/GitService.js";
import { createGitTools } from "../../../src/modules/agent/tools/gitTools.js";
import { ToolError, type Tool, type ToolContext } from "../../../src/modules/agent/tools/Tool.js";
import { createTempWorkspace, type TempWorkspace } from "../../helpers/tempWorkspace.js";

const git = new GitService();

describe.skipIf(!git.available)("git tools", () => {
    let repo: TempWorkspace;
    let plain: TempWorkspace;
    let tools: Map<string, Tool>;
    const context = { sessionId: "s", signal: new AbortController().signal, emit: () => undefined } as unknown as ToolContext;

    const run = (name: string, input: unknown, set = tools) => {
        const tool = set.get(name)!;
        return tool.run(tool.inputSchema.parse(input), context) as Promise<string>;
    };

    beforeAll(async () => {
        repo = await createTempWorkspace();
        plain = await createTempWorkspace();

        const env = { cwd: repo.root };
        await git.text(["init", "--quiet", "--initial-branch=main"], env);
        await git.text(["config", "user.name", "Test"], env);
        await git.text(["config", "user.email", "test@example.com"], env);
        await git.text(["config", "commit.gpgsign", "false"], env);

        await repo.write("a.txt", "one\n");
        tools = new Map(createGitTools(git, repo.root).map(tool => [tool.name, tool]));
    });

    afterAll(async () => {
        await repo.dispose();
        await plain.dispose();
    });

    it("shows status, commits with approval flag, diff and log", async () => {
        expect(await run("git_status", {})).toContain("?? a.txt");
        expect(tools.get("git_commit")!.requiresApproval).toBe(true);

        expect(await run("git_commit", { message: "first commit" })).toContain("first commit");
        expect(await run("git_log", {})).toMatch(/[0-9a-f]{7} \d{4}-\d{2}-\d{2} Test {2}first commit/);

        await repo.write("a.txt", "two\n");
        const diff = await run("git_diff", {});
        expect(diff).toContain("-one");
        expect(diff).toContain("+two");

        await run("git_commit", { message: "second" });
        await expect(run("git_commit", { message: "empty" })).rejects.toThrow("Nothing to commit.");
        expect(await run("git_diff", {})).toBe("No changes.");
    }, 30_000);

    it("explains when the workspace is not a git repository", async () => {
        const outside = new Map(createGitTools(git, plain.root).map(tool => [tool.name, tool]));

        await expect(run("git_status", {}, outside)).rejects.toBeInstanceOf(ToolError);
        await expect(run("git_status", {}, outside)).rejects.toThrow("not a git repository");
    });
});
