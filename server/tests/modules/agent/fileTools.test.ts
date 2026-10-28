import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentEvent } from "@justai/shared";

import { EventBus, FileCreatedEvent, FileSavedEvent } from "../../../src/core/events/index.js";
import { AgentFileSystem } from "../../../src/modules/agent/tools/AgentFileSystem.js";
import { createFileTools, normalizeEditInput, normalizeFileInput } from "../../../src/modules/agent/tools/fileTools.js";
import { ToolError, type Tool, type ToolContext } from "../../../src/modules/agent/tools/Tool.js";
import { createTempWorkspace, type TempWorkspace } from "../../helpers/tempWorkspace.js";

describe("file tools", () => {
    let workspace: TempWorkspace;
    let tools: Map<string, Tool>;
    let events: AgentEvent[];
    let busEvents: string[];

    const context = (sessionId = "s1") => ({
        sessionId,
        signal: new AbortController().signal,
        emit: () => undefined,
    }) as unknown as ToolContext;

    const run = (name: string, input: unknown, sessionId = "s1") => {
        const tool = tools.get(name)!;
        return tool.run(tool.inputSchema.parse(input), context(sessionId));
    };

    const disk = (file: string) => readFile(path.join(workspace.root, file), "utf8");

    beforeEach(async () => {
        workspace = await createTempWorkspace();
        await workspace.write("src/a.ts", "line1\r\nline2\r\nline3\r\n");
        await workspace.write("bom.md", "﻿# Title\n");
        await workspace.write("node_modules/x/index.js", "");

        events = [];
        busEvents = [];

        const bus = new EventBus();
        bus.subscribe(FileSavedEvent, { handle: async event => { busEvents.push(`saved:${event.path}`); } });
        bus.subscribe(FileCreatedEvent, { handle: async event => { busEvents.push(`created:${event.path}`); } });

        const files = new AgentFileSystem(workspace.root, bus, event => events.push(event));
        tools = new Map(createFileTools(files, name => name === "node_modules").map(tool => [tool.name, tool]));
    });

    afterEach(async () => {
        await workspace.dispose();
    });

    it("reads files with line numbers and paging, without BOM", async () => {
        expect(await run("read_file", { path: "src/a.ts", offset: 2, limit: 1 }))
            .toBe("2\tline2\n\n[2 more lines; continue with offset=3]");
        expect(await run("read_file", { path: "bom.md" })).toBe("1\t# Title\n2\t");
    });

    it("lists directories without ignored entries", async () => {
        expect(await run("list_dir", {})).toBe("src/\nbom.md");
    });

    it("refuses to edit or overwrite a file that was not read in this session", async () => {
        await expect(run("edit_file", { path: "src/a.ts", edits: [{ old_string: "line2", new_string: "x" }] }))
            .rejects.toThrow("Read src/a.ts with read_file");
        await expect(run("write_file", { path: "src/a.ts", content: "x" }))
            .rejects.toThrow("Read src/a.ts with read_file");

        // Чтение в другой сессии не считается.
        await run("read_file", { path: "src/a.ts" }, "other");
        await expect(run("edit_file", { path: "src/a.ts", edits: [{ old_string: "line2", new_string: "x" }] }))
            .rejects.toBeInstanceOf(ToolError);
    });

    it("refuses to edit a file the user changed after it was read", async () => {
        await run("read_file", { path: "src/a.ts" });
        await writeFile(path.join(workspace.root, "src/a.ts"), "user change\n", "utf8");

        await expect(run("edit_file", { path: "src/a.ts", edits: [{ old_string: "user", new_string: "x" }] }))
            .rejects.toThrow("was modified since you last read it");
        expect(await disk("src/a.ts")).toBe("user change\n");
    });

    it("applies several edits atomically and preserves CRLF", async () => {
        await run("read_file", { path: "src/a.ts" });

        await expect(run("edit_file", {
            path: "src/a.ts",
            edits: [
                { old_string: "line1", new_string: "first" },
                { old_string: "missing", new_string: "x" },
            ],
        })).rejects.toThrow(/Edit #2.*Nothing was written/);
        expect(await disk("src/a.ts")).toBe("line1\r\nline2\r\nline3\r\n");

        const result = await run("edit_file", {
            path: "src/a.ts",
            edits: [
                { old_string: "line1\nline2", new_string: "first\nsecond" },
                { old_string: "line3", new_string: "third" },
            ],
        });

        expect(await disk("src/a.ts")).toBe("first\r\nsecond\r\nthird\r\n");
        expect(result).toContain("-line1");
        expect(result).toContain("+first");

        // После своей записи агент может править дальше без повторного чтения.
        await run("edit_file", { path: "src/a.ts", edits: [{ old_string: "third", new_string: "3" }] });
        expect(await disk("src/a.ts")).toBe("first\r\nsecond\r\n3\r\n");
    });

    it("recovers old_string with literal \\n sequences (small-model escaping error)", async () => {
        await run("read_file", { path: "src/a.ts" });

        const result = await run("edit_file", {
            path: "src/a.ts",
            edits: [{ old_string: "line1\\nline2", new_string: "first\\nsecond" }],
        });

        expect(result).toContain("treated as line breaks");
        expect(await disk("src/a.ts")).toBe("first\r\nsecond\r\nline3\r\n");

        await expect(run("edit_file", { path: "src/a.ts", edits: [{ old_string: "nope\\nnothing", new_string: "x" }] }))
            .rejects.toThrow("must be a real newline");
    });

    it("applies an edit whose old_string lost line breaks and indentation (collapsed HTML from a small model)", async () => {
        await workspace.write("index.html", [
            "<div class=\"modes-grid\">",
            "    <button class=\"mode-card\" data-mode=\"build\">",
            "        <div class=\"mode-card__title\">Угадай сборку</div>",
            "        <div class=\"mode-card и\" data-mode=\"build\">Определи героя по набору предметов</div>",
            "    </button>",
            "</div>",
            "",
        ].join("\n"));
        await run("read_file", { path: "index.html" });

        const result = await run("edit_file", {
            path: "index.html",
            edits: [{
                old_string: "<div class=\"mode-card__title\">Угадай сборку</div><div class=\"mode-card и\" data-mode=\"build\">Определи героя по набору предметов</div>",
                new_string: "<div class=\"mode-card__title\">Угадай сборку</div>\n<div class=\"mode-card__description\">Определи героя по набору предметов</div>",
            }],
        });

        expect(result).toContain("ignoring whitespace");
        expect(await disk("index.html")).toBe([
            "<div class=\"modes-grid\">",
            "    <button class=\"mode-card\" data-mode=\"build\">",
            "        <div class=\"mode-card__title\">Угадай сборку</div>",
            "        <div class=\"mode-card__description\">Определи героя по набору предметов</div>",
            "    </button>",
            "</div>",
            "",
        ].join("\n"));
    });

    it("does not guess when the whitespace-insensitive match is ambiguous", async () => {
        await workspace.write("twice.txt", "a  b\nc\na b\n");
        await run("read_file", { path: "twice.txt" });

        await expect(run("edit_file", { path: "twice.txt", edits: [{ old_string: "a\nb", new_string: "x" }] }))
            .rejects.toThrow(/was not found/);
    });

    it("refuses ambiguous edits unless replace_all with the expected count, keeps $ literal", async () => {
        await run("read_file", { path: "src/a.ts" });

        await expect(run("edit_file", { path: "src/a.ts", edits: [{ old_string: "line", new_string: "x" }] }))
            .rejects.toThrow(/occurs 3 times/);
        // replace_all без подтверждённого числа — отказ: так модель меняла «display: flex» во всём файле.
        await expect(run("edit_file", { path: "src/a.ts", edits: [{ old_string: "line", new_string: "x", replace_all: true }] }))
            .rejects.toThrow(/expected_count=3/);

        await run("edit_file", { path: "src/a.ts", edits: [{ old_string: "line", new_string: "$&-", replace_all: true, expected_count: 3 }] });
        expect(await disk("src/a.ts")).toBe("$&-1\r\n$&-2\r\n$&-3\r\n");
    });

    it("refuses to apply an edit twice and shows the closest real text when old_string is wrong", async () => {
        await workspace.write("page.css", "#stub {\n    display: flex;\n    padding: 2rem;\n}\n\n#other {\n    color: red;\n}\n");
        await run("read_file", { path: "page.css" });

        const wrapped = "#stub {\n    display: none;\n    padding: 2rem;\n}\n\n#stub.on {\n    display: flex;\n}";
        await run("edit_file", { path: "page.css", edits: [{ old_string: "#stub {\n    display: flex;\n    padding: 2rem;\n}", new_string: wrapped }] });

        // Та же правка ещё раз: new_string уже в файле — ничего не пишется.
        await expect(run("edit_file", { path: "page.css", edits: [{ old_string: "#stub {\n    display: flex;\n    padding: 2rem;\n}", new_string: wrapped }] }))
            .rejects.toThrow(/already/);

        // Выдуманное правило: показывается настоящий текст вокруг «#other {».
        await expect(run("edit_file", { path: "page.css", edits: [{ old_string: "#other {\n    color: blue;\n}", new_string: "#other {}" }] }))
            .rejects.toThrow(/closest text[\s\S]*\d+\t {4}color: red;/);
    });

    it("appends with write_file and refuses to shrink a long file by accident", async () => {
        const long = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
        await workspace.write("long.txt", `${long}\n`);
        await run("read_file", { path: "long.txt" });

        await expect(run("write_file", { path: "long.txt", content: "tail\n" })).rejects.toThrow(/append=true/);
        expect(await disk("long.txt")).toBe(`${long}\n`);

        await run("write_file", { path: "long.txt", content: "tail\n", append: true });
        expect(await disk("long.txt")).toBe(`${long}\ntail\n`);

        await run("read_file", { path: "long.txt" });
        await run("write_file", { path: "long.txt", content: "short\n", confirm_shrink: true });
        expect(await disk("long.txt")).toBe("short\n");
    });

    it("preserves BOM on overwrite", async () => {
        await run("read_file", { path: "bom.md" });
        await run("write_file", { path: "bom.md", content: "# New\n" });

        expect(await disk("bom.md")).toBe("﻿# New\n");
    });

    it("creates new files without a prior read and publishes events", async () => {
        expect(await run("write_file", { path: "docs/new/readme.md", content: "# hi" })).toContain("Created");
        expect(await disk("docs/new/readme.md")).toBe("# hi");

        expect(busEvents).toEqual(["created:docs/new/readme.md"]);
        expect(events).toEqual([
            expect.objectContaining({ type: "file.changed", sessionId: "s1", path: "docs/new/readme.md", diff: expect.stringContaining("+# hi") }),
        ]);
    });

    it("turns path and fs problems into ToolErrors", async () => {
        await expect(run("read_file", { path: "../outside.txt" })).rejects.toBeInstanceOf(ToolError);
        await expect(run("write_file", { path: ".justai/x", content: "" })).rejects.toBeInstanceOf(ToolError);
        await expect(run("read_file", { path: "missing.ts" })).rejects.toThrow("does not exist");
        await expect(run("read_file", { path: "src" })).rejects.toThrow("is a directory");
        await expect(run("write_file", { path: "src", content: "" })).rejects.toThrow("is a directory");
    });
});

describe("tool input forms of small models", () => {
    it("turns a flat edit_file call, edits as a JSON string or a single object into the edits list", () => {
        expect(normalizeEditInput({ path: "a.js", old_string: "x", new_string: "y" })).toEqual({ path: "a.js", edits: [{ old_string: "x", new_string: "y" }] });
        expect(normalizeEditInput({ path: "a.js", edits: '[{"old_string":"x","new_string":"y"}]' })).toEqual({ path: "a.js", edits: [{ old_string: "x", new_string: "y" }] });
        expect(normalizeEditInput({ file_path: "a.js", edits: { old_text: "x", new_text: "y" } })).toEqual({ path: "a.js", edits: [{ old_string: "x", new_string: "y" }] });
        // Уже правильная форма не меняется; непонятное остаётся как есть — схема вернёт модели ошибку.
        expect(normalizeEditInput({ path: "a.js", edits: [{ old_string: "x", new_string: "y", replace_all: false }] })).toEqual({ path: "a.js", edits: [{ old_string: "x", new_string: "y", replace_all: false }] });
        expect(normalizeEditInput(42)).toBe(42);
    });

    it("accepts file_path / filename / text / contents for read_file and write_file", () => {
        expect(normalizeFileInput({ file_path: "a.md", text: "hi" })).toEqual({ path: "a.md", content: "hi" });
        expect(normalizeFileInput('{"filename":"b.md","contents":"x"}')).toEqual({ path: "b.md", content: "x" });
        expect(normalizeFileInput({ path: "c.md", content: "keep", text: "other" })).toEqual({ path: "c.md", content: "keep", text: "other" });
    });
});
