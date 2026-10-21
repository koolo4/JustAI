import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Message } from "@justai/shared";

import {
    extractTextToolCalls,
    OpenAICompatibleProvider,
    toChatMessages,
} from "../../../src/modules/agent/providers/OpenAICompatibleProvider.js";
import type { ModelStreamEvent, ModelTurn } from "../../../src/modules/agent/providers/ModelProvider.js";
import { ProviderRegistry } from "../../../src/modules/agent/providers/ProviderRegistry.js";

/** Сценарий ответа поддельного сервера: список chunk-объектов SSE. */
let nextChunks: unknown[] = [];
let lastBody: Record<string, unknown> = {};

function chunk(delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) {
    return { id: "c", object: "chat.completion.chunk", model: "test-model", choices: [{ index: 0, delta, finish_reason: finish }], ...extra };
}

describe("OpenAICompatibleProvider", () => {
    let server: http.Server;
    let baseURL: string;

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            let body = "";
            req.on("data", data => { body += data; });
            req.on("end", () => {
                lastBody = JSON.parse(body);
                res.writeHead(200, { "Content-Type": "text/event-stream" });

                for (const item of nextChunks) {
                    res.write(`data: ${JSON.stringify(item)}\n\n`);
                }

                res.end("data: [DONE]\n\n");
            });
        });

        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    });

    afterAll(async () => {
        await new Promise(resolve => server.close(resolve));
    });

    async function run(chunks: unknown[], tools = ["read_file", "write_file"]) {
        nextChunks = chunks;
        const provider = new OpenAICompatibleProvider({ id: "ollama", baseURL, apiKey: "", model: "test-model" });
        const events: ModelStreamEvent[] = [];

        for await (const event of provider.stream({
            system: "sys",
            messages: [{ id: "1", role: "user", createdAt: "", content: [{ type: "text", text: "hi" }] }],
            tools: tools.map(name => ({ name, description: name, inputSchema: { type: "object" } })),
            signal: new AbortController().signal,
        })) {
            events.push(event);
        }

        const done = events.at(-1);
        return { events, turn: (done as { turn: ModelTurn }).turn };
    }

    it("streams text and reasoning, sends tools and system prompt", async () => {
        const { events, turn } = await run([
            chunk({ role: "assistant", reasoning_content: "thinking…" }),
            chunk({ content: "Hel" }),
            chunk({ content: "lo" }, "stop"),
            { id: "c", object: "chat.completion.chunk", model: "test-model", choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
        ]);

        expect(events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text)).toEqual(["Hel", "lo"]);
        expect(events.some(e => e.type === "thinking_delta")).toBe(true);
        expect(turn).toMatchObject({
            content: [{ type: "text", text: "Hello" }],
            stopReason: "end_turn",
            usage: { inputTokens: 12, outputTokens: 3 },
            model: "test-model",
        });

        expect(lastBody).toMatchObject({ model: "test-model", stream: true, stream_options: { include_usage: true } });
        expect((lastBody.messages as Array<{ role: string }>)[0]).toEqual({ role: "system", content: "sys" });
        expect((lastBody.tools as unknown[]).length).toBe(2);
    });

    it("assembles tool calls split across chunks", async () => {
        const { turn } = await run([
            chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: "{\"pa" } }] }),
            chunk({ tool_calls: [{ index: 0, function: { arguments: "th\":\"a.ts\"}" } }] }),
            chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "read_file", arguments: "{\"path\":" } }] }),
            chunk({ tool_calls: [{ index: 1, function: { arguments: "\"b.ts\"}" } }] }, "tool_calls"),
        ]);

        expect(turn.stopReason).toBe("tool_use");
        expect(turn.content).toEqual([
            { type: "tool_use", id: "call_a", name: "read_file", input: { path: "a.ts" } },
            { type: "tool_use", id: "call_b", name: "read_file", input: { path: "b.ts" } },
        ]);
    });

    it("keeps invalid arguments for validation and generates missing ids", async () => {
        const { turn } = await run([
            chunk({ tool_calls: [{ index: 0, type: "function", function: { name: "read_file", arguments: "{\"path\": " } }] }, "tool_calls"),
        ]);

        expect(turn.content).toEqual([
            { type: "tool_use", id: expect.stringMatching(/^call_/), name: "read_file", input: { __invalid_json: "{\"path\": " } },
        ]);
    });

    it("recognizes tool calls written as text by small models", async () => {
        const { turn } = await run([
            chunk({ content: "I'll read it.\n<tool_call>\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"a.ts\"}}\n</tool_call>" }, "stop"),
        ]);

        expect(turn.stopReason).toBe("tool_use");
        expect(turn.content).toEqual([
            { type: "text", text: "I'll read it." },
            { type: "tool_use", id: expect.any(String), name: "read_file", input: { path: "a.ts" } },
        ]);
    });

    it("maps length to max_tokens", async () => {
        const { turn } = await run([chunk({ content: "cut" }, "length")]);
        expect(turn.stopReason).toBe("max_tokens");
    });
});

describe("extractTextToolCalls", () => {
    const tools = new Set(["read_file", "run_command"]);

    it("handles fenced JSON, bare JSON, arrays and string arguments", () => {
        expect(extractTextToolCalls("```json\n{\"name\":\"run_command\",\"parameters\":{\"command\":\"npm test\"}}\n```", tools).calls)
            .toEqual([expect.objectContaining({ name: "run_command", input: { command: "npm test" } })]);

        expect(extractTextToolCalls("{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"x\\\"}\"}", tools).calls)
            .toEqual([expect.objectContaining({ name: "read_file", input: { path: "x" } })]);

        expect(extractTextToolCalls("[{\"name\":\"read_file\",\"arguments\":{\"path\":\"a\"}},{\"name\":\"read_file\",\"arguments\":{\"path\":\"b\"}}]", tools).calls)
            .toHaveLength(2);
    });

    it("handles several JSON calls in a row inside prose (qwen2.5-coder via Ollama)", () => {
        const text = [
            "I'll create the file and run it.",
            "",
            "{",
            "  \"name\": \"read_file\",",
            "  \"arguments\": { \"path\": \"a {weird} \\\"name\\\".js\" }",
            "}",
            "",
            "{\"name\": \"run_command\", \"arguments\": {\"command\": \"node -e \\\"console.log(1)\\\"\"}}",
        ].join("\n");

        const result = extractTextToolCalls(text, tools);

        expect(result.calls.map(call => [call.name, call.input])).toEqual([
            ["read_file", { path: "a {weird} \"name\".js" }],
            ["run_command", { command: "node -e \"console.log(1)\"" }],
        ]);
        expect(result.text.trim()).toBe("I'll create the file and run it.");
    });

    it("ignores unknown tools and ordinary JSON in answers", () => {
        const example = "Here is the config:\n```json\n{\"name\": \"my-app\", \"version\": \"1.0.0\"}\n```";
        const result = extractTextToolCalls(example, tools);

        expect(result.calls).toEqual([]);
        expect(result.text).toBe(example);
        expect(extractTextToolCalls("<tool_call>{\"name\":\"rm_everything\"}</tool_call>", tools).calls).toEqual([]);
    });
});

describe("toChatMessages", () => {
    it("puts tool results into role=tool messages right after the assistant call", () => {
        const history: Message[] = [
            { id: "1", role: "user", createdAt: "", content: [{ type: "text", text: "read" }] },
            {
                id: "2", role: "assistant", createdAt: "", content: [
                    { type: "thinking", text: "hidden" },
                    { type: "tool_use", id: "c1", name: "read_file", input: { path: "a" } },
                ],
            },
            {
                id: "3", role: "user", createdAt: "", content: [
                    { type: "tool_result", toolUseId: "c1", content: "boom", isError: true },
                    { type: "text", text: "and continue" },
                ],
            },
        ];

        expect(toChatMessages("sys", history)).toEqual([
            { role: "system", content: "sys" },
            { role: "user", content: "read" },
            { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }] },
            { role: "tool", tool_call_id: "c1", content: "ERROR: boom" },
            { role: "user", content: "and continue" },
        ]);
    });
});

describe("ProviderRegistry presets", () => {
    it("lists presets with configuration status", () => {
        const registry = new ProviderRegistry({ GROQ_API_KEY: "k", OPENROUTER_API_KEY: "k" });
        const byId = Object.fromEntries(registry.list().map(info => [info.id, info]));

        expect(byId.ollama).toMatchObject({ configured: true, model: "qwen2.5-coder:7b" });
        expect(byId.groq).toMatchObject({ configured: true });
        expect(byId.gemini).toMatchObject({ configured: false });
        // OpenRouter без модели — не настроен.
        expect(byId.openrouter).toMatchObject({ configured: false, model: "set OPENROUTER_MODEL" });
    });

    it("creates compatible providers and requires a model", () => {
        const registry = new ProviderRegistry({ OLLAMA_MODEL: "llama3.1:8b" });

        expect(registry.create("ollama")).toMatchObject({ id: "ollama", model: "llama3.1:8b" });
        expect(registry.create("ollama", "qwen3:8b").model).toBe("qwen3:8b");
        expect(() => registry.create("openrouter")).toThrow("OPENROUTER_MODEL");
    });
});
