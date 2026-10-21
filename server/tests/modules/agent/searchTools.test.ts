import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EventBus } from "../../../src/core/events/index.js";
import { AgentFileSystem } from "../../../src/modules/agent/tools/AgentFileSystem.js";
import { createSearchTools } from "../../../src/modules/agent/tools/searchTools.js";
import type { Tool, ToolContext } from "../../../src/modules/agent/tools/Tool.js";
import { createTempWorkspace, type TempWorkspace } from "../../helpers/tempWorkspace.js";

describe("search tools", () => {
    let workspace: TempWorkspace;
    let tools: Map<string, Tool>;
    const context = { sessionId: "s", signal: new AbortController().signal, emit: () => undefined } as unknown as ToolContext;

    const run = (name: string, input: unknown) => {
        const tool = tools.get(name)!;
        return tool.run(tool.inputSchema.parse(input), context);
    };

    beforeAll(async () => {
        workspace = await createTempWorkspace();
        await workspace.write(".gitignore", "build/\n");
        await workspace.write("src/app/UserController.ts", "export class UserController {\n  getUser() {}\n}\n");
        await workspace.write("src/app/user.test.ts", "describe('user', () => {});\n");
        await workspace.write("src/index.ts", "import { UserController } from './app/UserController';\n");
        await workspace.write("README.md", "Users guide\n");
        await workspace.write("build/out.js", "UserController\n");
        await workspace.write("node_modules/pkg/index.ts", "UserController\n");
        await workspace.write(".justai/sessions/x.jsonl", "UserController\n");

        tools = new Map(createSearchTools(new AgentFileSystem(workspace.root, new EventBus(), () => undefined)).map(t => [t.name, t]));
    });

    afterAll(async () => {
        await workspace.dispose();
    });

    it("glob finds files by pattern, respecting .gitignore and exclusions", async () => {
        expect(await run("glob", { pattern: "**/*.ts" })).toBe([
            "src/app/UserController.ts",
            "src/app/user.test.ts",
            "src/index.ts",
        ].join("\n"));

        expect(await run("glob", { pattern: "*.ts", path: "src/app" })).toBe([
            "src/app/UserController.ts",
            "src/app/user.test.ts",
        ].join("\n"));

        expect(await run("glob", { pattern: "**/*.py" })).toBe("No files found.");
    });

    it("grep lists matching files with workspace-relative paths", async () => {
        const result = await run("grep", { pattern: "UserController" }) as string;

        expect(result.split("\n").sort()).toEqual(["src/app/UserController.ts", "src/index.ts"]);
    });

    it("grep shows content with line numbers, supports glob, case and context", async () => {
        expect(await run("grep", { pattern: "getUser", output_mode: "content" }))
            .toBe("src/app/UserController.ts:2:  getUser() {}");

        expect(await run("grep", { pattern: "users", case_insensitive: true, glob: "*.md" })).toBe("README.md");

        const withContext = await run("grep", { pattern: "getUser", output_mode: "content", context: 1, path: "src/app/UserController.ts" }) as string;
        expect(withContext.split("\n")).toHaveLength(3);
    });

    it("grep counts and handles patterns starting with a dash", async () => {
        expect(await run("grep", { pattern: "User", output_mode: "count", path: "src/index.ts" })).toBe("src/index.ts:1");
        expect(await run("grep", { pattern: "-nothing-here" })).toBe("No matches found.");
    });

    it("reports invalid regular expressions as tool errors", async () => {
        await expect(run("grep", { pattern: "(unclosed" })).rejects.toThrow("Search failed");
    });

    it("does not search outside the workspace", async () => {
        await expect(run("grep", { pattern: "x", path: ".." })).rejects.toThrow();
    });
});
