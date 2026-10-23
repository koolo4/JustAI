import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CHUNK_LINES, chunkFile, CodeIndex, cosine, type Embedder } from "../../../../src/modules/agent/index/CodeIndex.js";
import { createCodeSearchTool } from "../../../../src/modules/agent/tools/codeSearchTool.js";
import { createTempWorkspace, type TempWorkspace } from "../../../helpers/tempWorkspace.js";

const TOPICS = ["token", "session", "button", "database"];

/** Детерминированные «эмбеддинги»: вектор частот ключевых слов. */
class KeywordEmbedder implements Embedder {
    public readonly model = "keywords";
    public calls = 0;
    public texts = 0;

    public async embed(texts: string[]): Promise<number[][]> {
        this.calls += 1;
        this.texts += texts.length;
        return texts.map(text => TOPICS.map(topic => (text.toLowerCase().match(new RegExp(topic, "g")) ?? []).length + 0.01));
    }
}

describe("CodeIndex", () => {
    let workspace: TempWorkspace;
    const signal = new AbortController().signal;

    beforeEach(async () => {
        workspace = await createTempWorkspace();
        await workspace.write("src/auth.ts", "export function checkToken(token: string) {\n  return token === 'ok'; // token check\n}\n");
        await workspace.write("src/store.ts", "export function saveSession(session: object) {\n  // session is written to disk\n}\n");
        await workspace.write("src/ui.tsx", "export const Button = () => <button>button</button>;\n");
        await workspace.write("node_modules/lib/index.js", "token token token");
        await workspace.write("logo.png", "\u0000binary");
    });

    afterEach(async () => {
        await workspace.dispose();
    });

    it("splits files into line chunks", () => {
        const content = Array.from({ length: CHUNK_LINES + 5 }, (_, i) => `line ${i + 1}`).join("\n");
        const chunks = chunkFile("a.ts", content);

        expect(chunks.map(chunk => [chunk.startLine, chunk.endLine])).toEqual([[1, CHUNK_LINES], [CHUNK_LINES + 1, CHUNK_LINES + 5]]);
        expect(cosine(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBeCloseTo(1);
        expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
    });

    it("finds code by meaning and skips ignored and binary files", async () => {
        const index = new CodeIndex(workspace.root, new KeywordEmbedder());
        const result = await index.search("where is the session saved", 2, signal);

        expect(result.indexed).toBe(3);
        expect(result.hits[0]).toMatchObject({ path: "src/store.ts", startLine: 1 });
        expect(result.hits[0]!.text).toContain("saveSession");
        expect(existsSync(path.join(workspace.root, ".justai", "index", "code.json"))).toBe(true);
    });

    it("re-embeds only changed files and forgets deleted ones", async () => {
        const embedder = new KeywordEmbedder();
        const index = new CodeIndex(workspace.root, embedder);
        await index.sync(signal);
        const firstTexts = embedder.texts;

        expect(await new CodeIndex(workspace.root, embedder).sync(signal)).toBe(0);
        expect(embedder.texts).toBe(firstTexts);

        await writeFile(path.join(workspace.root, "src/auth.ts"), "export const database = 'token';\n// database\n", "utf8");
        await rm(path.join(workspace.root, "src/ui.tsx"));

        expect(await index.sync(signal)).toBe(1);
        const result = await index.search("database", 5, signal);
        expect(result.indexed).toBe(2);
        expect(result.hits[0]!.path).toBe("src/auth.ts");
    });

    it("search_code formats hits and reports embedding errors with a fallback hint", async () => {
        const tool = createCodeSearchTool(() => new CodeIndex(workspace.root, new KeywordEmbedder()));
        const context = { sessionId: "s", toolUseId: "t", workspaceRoot: workspace.root, signal, emit: () => undefined };
        const output = await tool.run({ query: "token check", limit: 1 }, context);

        expect(output).toContain("src/auth.ts:1-");
        expect(output).toContain("checkToken");

        const broken = createCodeSearchTool(() => new CodeIndex(workspace.root, {
            model: "x",
            embed: async () => {
                throw new Error("Embeddings (ollama/nomic-embed-text) failed: connect ECONNREFUSED.");
            },
        }));
        await expect(broken.run({ query: "token check", limit: 1 }, context)).rejects.toThrow(/Use grep or glob instead/);
    });
});
