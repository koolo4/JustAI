import http from "node:http";
import type { AddressInfo } from "node:net";

import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Message } from "@justai/shared";

import {
    describesActionWithoutDoingIt,
    extractTextToolCalls,
    isMalformedToolCall,
    isRepeating,
    OpenAICompatibleProvider,
    repairJson,
    splitThinking,
    toChatMessages,
} from "../../../src/modules/agent/providers/OpenAICompatibleProvider.js";
import { ModelOutputError, type ModelStreamEvent, type ModelTurn } from "../../../src/modules/agent/providers/ModelProvider.js";
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

    it("interrupts a repeating stream with a retryable error", async () => {
        const looping = "again and again and again, the same sentence over and over. ";
        const chunks = Array.from({ length: 200 }, () => chunk({ content: looping }));

        await expect(run(chunks)).rejects.toBeInstanceOf(ModelOutputError);
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

    it("repairs the broken call from the live qwen2.5-coder run (<tool_request>, missing ])", () => {
        const text = [
            "The `mul` function is indeed missing from the `math.js` file. I'll implement it and export it.",
            "",
            "<tool_request>",
            "{\"name\": \"edit_file\", \"arguments\": {\"path\":\"math.js\",\"edits\":[{\"old_string\":\"x\",\"new_string\":\"function mul(a, b) {\\n  return a * b;\\n}\\nmodule.exports = { add, mul };}\"}}",
            "</tool_request>",
        ].join("\n");

        const result = extractTextToolCalls(text, new Set(["edit_file"]));

        expect(result.malformed).toBe(false);
        expect(result.calls).toEqual([expect.objectContaining({
            name: "edit_file",
            input: {
                path: "math.js",
                edits: [{ old_string: "x", new_string: "function mul(a, b) {\n  return a * b;\n}\nmodule.exports = { add, mul };}" }],
            },
        })]);
        expect(result.text.trim()).toBe("The `mul` function is indeed missing from the `math.js` file. I'll implement it and export it.");
    });

    it("handles unclosed tags and unclosed objects at the end of the answer", () => {
        expect(extractTextToolCalls("Reading.\n<tool_call>{\"name\":\"read_file\",\"arguments\":{\"path\":\"a\"", tools).calls)
            .toEqual([expect.objectContaining({ name: "read_file", input: { path: "a" } })]);

        expect(extractTextToolCalls("Ok {\"name\": \"read_file\", \"arguments\": {\"path\": \"b\"}", tools).calls)
            .toEqual([expect.objectContaining({ name: "read_file", input: { path: "b" } })]);
    });

    it("flags tool calls that cannot be recovered", () => {
        const result = extractTextToolCalls("<tool_call>{\"name\": \"read_file\", \"arguments\": {\"path\": oops}}</tool_call>", tools);

        expect(result.calls).toEqual([]);
        expect(result.malformed).toBe(true);
        expect(extractTextToolCalls("All done, the tests pass.", tools).malformed).toBe(false);
    });

    it("ignores unknown tools and ordinary JSON in answers", () => {
        const example = "Here is the config:\n```json\n{\"name\": \"my-app\", \"version\": \"1.0.0\"}\n```";
        const result = extractTextToolCalls(example, tools);

        expect(result.calls).toEqual([]);
        expect(result.text).toBe(example);
        expect(extractTextToolCalls("<tool_call>{\"name\":\"rm_everything\"}</tool_call>", tools).calls).toEqual([]);
    });
});

describe("isMalformedToolCall", () => {
    const apiError = (status: number | undefined, message: string) =>
        new OpenAI.APIError(status, { message }, message, undefined);

    it("treats tool call validation errors as model output errors, also mid-stream", () => {
        const groq = "Tool call validation failed: attempted to call tool 'run_command' which was not in request.tools";

        expect(isMalformedToolCall(apiError(400, groq))).toBe(true);
        expect(isMalformedToolCall(apiError(undefined, groq))).toBe(true);
    });

    it("leaves other API errors alone", () => {
        expect(isMalformedToolCall(apiError(413, "Request too large for model"))).toBe(false);
        expect(isMalformedToolCall(apiError(undefined, "Internal server error"))).toBe(false);
    });
});

describe("splitThinking", () => {
    it("moves <think> blocks out of the visible answer", () => {
        expect(splitThinking("<think>\nNeed to read the file {\"name\":\"read_file\"}\n</think>\n\nReading now.")).toEqual({
            thinking: "Need to read the file {\"name\":\"read_file\"}",
            text: "Reading now.",
        });
        expect(splitThinking("Answer only.")).toEqual({ thinking: "", text: "Answer only." });
        expect(splitThinking("<think>cut off mid-thought")).toEqual({ thinking: "cut off mid-thought", text: "" });
    });
});

describe("isRepeating", () => {
    it("detects a model stuck in a loop, but not long normal text or code", () => {
        const loop = `Let me fix the test. ${"I will now run the tests again to check the result. ".repeat(80)}`;
        expect(isRepeating(loop)).toBe(true);

        const prose = Array.from({ length: 120 }, (_, i) => `Line ${i}: the value of item ${i * 7} is ${i * i}.`).join("\n");
        expect(isRepeating(prose)).toBe(false);
        expect(isRepeating("short ".repeat(100))).toBe(false);
    });
});

describe("describesActionWithoutDoingIt", () => {
    it("detects intentions and requests to the user from the live run", () => {
        expect(describesActionWithoutDoingIt("To fulfill the test requirement for `mul`, I will add this function to the existing module.\n\n### Tool Call: Edit File\n\nPlease apply the following edit to `math.js`:")).toBe(true);
        expect(describesActionWithoutDoingIt("Let me update the config.")).toBe(true);
        expect(describesActionWithoutDoingIt("You can run the command yourself: node x.js")).toBe(true);
        expect(describesActionWithoutDoingIt("Let's update `math.js` with the `mul` function and export it properly.")).toBe(true);
        expect(describesActionWithoutDoingIt("Let's proceed with reading the file and then attempting the edits again.")).toBe(true);
    });

    it("does not flag final summaries", () => {
        expect(describesActionWithoutDoingIt("I added mul(a, b) to math.js and exported it. Tests pass.")).toBe(false);
        expect(describesActionWithoutDoingIt("The function is defined in src/auth.ts:12.")).toBe(false);
    });
});

describe("repairJson", () => {
    it("closes brackets in the right order, respecting strings", () => {
        expect(repairJson("{\"a\":[{\"b\":\"}]\"}}")).toBe("{\"a\":[{\"b\":\"}]\"}]}");
        expect(repairJson("{\"a\":\"unterminated")).toBe("{\"a\":\"unterminated\"}");
        expect(repairJson("{\"a\":1,")).toBe("{\"a\":1}");
        expect(repairJson("{\"a\":1}} trailing")).toBe("{\"a\":1}");
        expect(repairJson("not json")).toBeNull();
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

    it("drops empty assistant replies: Ollama rejects content null without tool calls", () => {
        const history: Message[] = [
            { id: "1", role: "user", createdAt: "", content: [{ type: "text", text: "do it" }] },
            { id: "2", role: "assistant", createdAt: "", content: [] },
            { id: "3", role: "user", createdAt: "", content: [{ type: "text", text: "Your reply was empty" }] },
        ];

        expect(toChatMessages("sys", history)).toEqual([
            { role: "system", content: "sys" },
            { role: "user", content: "do it" },
            { role: "user", content: "Your reply was empty" },
        ]);
    });
});

describe("ProviderRegistry presets", () => {
    it("lists presets with configuration status", () => {
        const registry = new ProviderRegistry({ GROQ_API_KEY: "k", OPENROUTER_API_KEY: "k" });
        const byId = Object.fromEntries(registry.list().map(info => [info.id, info]));

        expect(byId.ollama).toMatchObject({ configured: true, model: "qwen3:8b" });
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
