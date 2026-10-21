import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFileTools } from "../../../src/modules/agent/tools/fileTools.js";
import { ToolError, type Tool, type ToolContext } from "../../../src/modules/agent/tools/Tool.js";
import { createTempWorkspace, type TempWorkspace } from "../../helpers/tempWorkspace.js";

describe("file tools", () => {
    let workspace: TempWorkspace;
    let tools: Map<string, Tool>;
    const context = { signal: new AbortController().signal, emit: () => undefined } as unknown as ToolContext;

    const run = (name: string, input: unknown) => {
        const tool = tools.get(name)!;
        return tool.run(tool.inputSchema.parse(input), context);
    };

    beforeEach(async () => {
        workspace = await createTempWorkspace();
        await workspace.write("src/a.ts", "line1\r\nline2\r\nline3\r\n");
        await workspace.write("node_modules/x/index.js", "");
        tools = new Map(createFileTools(workspace.root, name => name === "node_modules").map(tool => [tool.name, tool]));
    });

    afterEach(async () => {
        await workspace.dispose();
    });

    it("reads files with line numbers and paging", async () => {
        expect(await run("read_file", { path: "src/a.ts", offset: 2, limit: 1 }))
            .toBe("2\tline2\n\n[2 more lines; continue with offset=3]");
    });

    it("lists directories without ignored entries", async () => {
        expect(await run("list_dir", {})).toBe("src/");
    });

    it("edits a unique fragment and refuses ambiguous edits", async () => {
        await run("edit_file", { path: "src/a.ts", old_string: "line2", new_string: "LINE2" });
        expect(await readFile(path.join(workspace.root, "src/a.ts"), "utf8")).toBe("line1\r\nLINE2\r\nline3\r\n");

        await expect(run("edit_file", { path: "src/a.ts", old_string: "line", new_string: "x" }))
            .rejects.toThrow(/occurs 2 times/);

        await run("edit_file", { path: "src/a.ts", old_string: "line", new_string: "row", replace_all: true });
        expect(await readFile(path.join(workspace.root, "src/a.ts"), "utf8")).toBe("row1\r\nLINE2\r\nrow3\r\n");
    });

    it("keeps $ patterns in replacement text literal", async () => {
        await run("edit_file", { path: "src/a.ts", old_string: "line1", new_string: "cost $& $1" });
        expect(await readFile(path.join(workspace.root, "src/a.ts"), "utf8")).toContain("cost $& $1");
    });

    it("creates new files in new folders", async () => {
        expect(await run("write_file", { path: "docs/new/readme.md", content: "# hi" })).toContain("Created");
        expect(await readFile(path.join(workspace.root, "docs/new/readme.md"), "utf8")).toBe("# hi");
    });

    it("turns path and fs problems into ToolErrors", async () => {
        await expect(run("read_file", { path: "../outside.txt" })).rejects.toBeInstanceOf(ToolError);
        await expect(run("write_file", { path: ".justai/x", content: "" })).rejects.toBeInstanceOf(ToolError);
        await expect(run("read_file", { path: "missing.ts" })).rejects.toThrow("does not exist");
        await expect(run("read_file", { path: "src" })).rejects.toThrow("is a directory");
    });
});
