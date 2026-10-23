import { describe, expect, it } from "vitest";

import { cleanCompletion, CompletionService, DEFAULT_COMPLETION_MODEL } from "../../../src/modules/completion/CompletionService.js";

describe("CompletionService", () => {
    it("asks Ollama's native API for fill-in-the-middle and returns the cleaned text", async () => {
        const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
        const fakeFetch = (async (url: string, init: RequestInit) => {
            calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
            return new Response(JSON.stringify({ response: "a * b;\n}" }), { status: 200 });
        }) as unknown as typeof fetch;

        const service = new CompletionService({ OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1" }, fakeFetch);
        const text = await service.complete({ path: "math.js", prefix: "function mul(a, b) {\n  return ", suffix: "\n}\n" }, new AbortController().signal);

        expect(text).toBe("a * b;\n}");
        expect(calls[0]!.url).toBe("http://127.0.0.1:11434/api/generate");
        expect(calls[0]!.body).toMatchObject({ model: DEFAULT_COMPLETION_MODEL, suffix: "\n}\n", stream: false });
    });

    it("can be switched off", async () => {
        const service = new CompletionService({ JUSTAI_COMPLETION_MODEL: "off" }, (() => { throw new Error("must not call"); }) as never);

        expect(service.model).toBeNull();
        expect(await service.complete({ path: "a", prefix: "x", suffix: "" }, new AbortController().signal)).toBe("");
    });

    it("drops text the model repeated from after the cursor and limits the length", () => {
        expect(cleanCompletion("return a * b;\n}\n\nmodule.exports = { mul };", "\nmodule.exports = { mul };\n")).toBe("return a * b;\n}\n");
        expect(cleanCompletion("x".repeat(2_000), "").length).toBe(600);
        expect(cleanCompletion("value<|endoftext|>", "")).toBe("value");
    });
});
