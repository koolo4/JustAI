import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { expandMentions, parseMentions } from "../../../src/modules/agent/runtime/Mentions.js";
import { createTempWorkspace, type TempWorkspace } from "../../helpers/tempWorkspace.js";

describe("Mentions", () => {
    let workspace: TempWorkspace;
    const ignore = (name: string) => name === "node_modules";

    beforeEach(async () => {
        workspace = await createTempWorkspace();
        await workspace.write("src/app.ts", "export const answer = 42;\n");
        await workspace.write("src/util.ts", "export {};\n");
        await workspace.write("docs/My notes.md", "# Notes\n");
        await workspace.write("node_modules/pkg/index.js", "x");
        await workspace.write(".justai/runtime.json", '{"token":"secret"}');
    });

    afterEach(async () => {
        await workspace.dispose();
    });

    it("parses paths, quoted paths and ignores e-mails and trailing punctuation", () => {
        expect(parseMentions('fix @src/app.ts, then read @"docs/My notes.md". mail me at a@b.com')).toEqual([
            "src/app.ts",
            "docs/My notes.md",
        ]);
    });

    it("attaches file contents and folder listings", async () => {
        const blocks = await expandMentions("explain @src/app.ts and @src", workspace.root, ignore);
        const texts = blocks.map(block => (block as { text: string }).text);

        expect(texts[0]).toContain("[Attached by @mention: src/app.ts]");
        expect(texts[0]).toContain("export const answer = 42;");
        expect(texts[1]).toContain("folder src/");
        expect(texts[1]).toContain("app.ts\nutil.ts");
    });

    it("never attaches JustAI state or paths outside the project", async () => {
        const blocks = await expandMentions("@.justai/runtime.json @../secret.txt @someone", workspace.root, ignore);
        const all = blocks.map(block => (block as { text: string }).text).join("\n");

        expect(all).not.toContain("secret\"");
        expect(all).toContain("@.justai/runtime.json: not attached");
        expect(all).toContain("@../secret.txt: not attached");
        // «@someone» — не путь: молча пропускаем.
        expect(blocks).toHaveLength(2);
    });

    it("reports missing files", async () => {
        const blocks = await expandMentions("look at @src/missing.ts", workspace.root, ignore);
        expect(blocks).toEqual([{ type: "text", text: "[@src/missing.ts: not found in the project.]" }]);
    });
});
