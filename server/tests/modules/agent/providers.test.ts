import type { BetaContentBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ResponseOutputItem } from "openai/resources/responses/responses";
import { describe, expect, it } from "vitest";

import type { Message } from "@justai/shared";

import {
    fromAnthropicContent,
    mapStopReason,
    toAnthropicMessages,
    toAnthropicTool,
} from "../../../src/modules/agent/providers/AnthropicProvider.js";
import {
    fromOpenAIOutput,
    toOpenAIInput,
} from "../../../src/modules/agent/providers/OpenAIProvider.js";
import { ProviderRegistry } from "../../../src/modules/agent/providers/ProviderRegistry.js";

const history: Message[] = [
    {
        id: "1",
        role: "user",
        createdAt: "",
        content: [{ type: "text", text: "read a.ts" }],
    },
    {
        id: "2",
        role: "assistant",
        createdAt: "",
        content: [
            { type: "thinking", text: "need to read" },
            { type: "text", text: "Reading." },
            { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts", limit: 10 } },
            { type: "tool_use", id: "call_2", name: "read_file", input: { path: "b.ts" } },
        ],
        meta: { provider: "mock" },
    },
    {
        id: "3",
        role: "user",
        createdAt: "",
        content: [
            { type: "tool_result", toolUseId: "call_1", content: "export {}", isError: false },
            { type: "tool_result", toolUseId: "call_2", content: "ENOENT", isError: true },
        ],
    },
];

describe("Anthropic mapping", () => {
    it("maps history with tool_use ids, raw JSON input and is_error", () => {
        const messages = toAnthropicMessages(history);

        expect(messages[1]).toEqual({
            role: "assistant",
            content: [
                { type: "text", text: "Reading." },
                { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts", limit: 10 } },
                { type: "tool_use", id: "call_2", name: "read_file", input: { path: "b.ts" } },
            ],
        });

        expect(messages[2]).toEqual({
            role: "user",
            content: [
                { type: "tool_result", tool_use_id: "call_1", content: "export {}", is_error: false },
                { type: "tool_result", tool_use_id: "call_2", content: "ENOENT", is_error: true },
            ],
        });
    });

    it("replays its own assistant turns verbatim (thinking signatures preserved)", () => {
        const raw = [
            { type: "thinking", thinking: "summary", signature: "sig-123" },
            { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" } },
        ];

        const messages = toAnthropicMessages([
            { ...history[1]!, meta: { provider: "anthropic", providerRaw: raw } },
        ]);

        expect(messages[0]!.content).toBe(raw);
    });

    it("converts response content and stop reasons", () => {
        const content = [
            { type: "thinking", thinking: "plan", signature: "s" },
            { type: "text", text: "hi", citations: null },
            { type: "tool_use", id: "toolu_1", name: "list_dir", input: { path: "." } },
        ] as unknown as BetaContentBlock[];

        expect(fromAnthropicContent(content)).toEqual([
            { type: "thinking", text: "plan" },
            { type: "text", text: "hi" },
            { type: "tool_use", id: "toolu_1", name: "list_dir", input: { path: "." } },
        ]);

        expect(mapStopReason("tool_use")).toBe("tool_use");
        expect(mapStopReason("stop_sequence")).toBe("end_turn");
        expect(mapStopReason("refusal")).toBe("refusal");
        expect(mapStopReason("model_context_window_exceeded")).toBe("other");
    });

    it("enables eager input streaming on tools", () => {
        expect(toAnthropicTool({ name: "t", description: "d", inputSchema: { type: "object" } }))
            .toMatchObject({ name: "t", eager_input_streaming: true });
    });
});

describe("OpenAI mapping", () => {
    it("maps history to function_call / function_call_output items", () => {
        expect(toOpenAIInput(history)).toEqual([
            { role: "user", content: [{ type: "input_text", text: "read a.ts" }] },
            { role: "assistant", content: "Reading." },
            { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a.ts\",\"limit\":10}" },
            { type: "function_call", call_id: "call_2", name: "read_file", arguments: "{\"path\":\"b.ts\"}" },
            { type: "function_call_output", call_id: "call_1", output: "export {}" },
            { type: "function_call_output", call_id: "call_2", output: "ERROR: ENOENT" },
        ]);
    });

    it("converts output items, keeping invalid JSON for validation", () => {
        const output = [
            { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "thinking" }] },
            { type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] },
            { type: "function_call", id: "f1", call_id: "call_9", name: "read_file", arguments: "{\"path\":" },
        ] as unknown as ResponseOutputItem[];

        expect(fromOpenAIOutput(output)).toEqual([
            { type: "thinking", text: "thinking" },
            { type: "text", text: "ok" },
            { type: "tool_use", id: "call_9", name: "read_file", input: { __invalid_json: "{\"path\":" } },
        ]);
    });
});

describe("ProviderRegistry", () => {
    it("lists providers with configuration status and current default models", () => {
        const registry = new ProviderRegistry({ ANTHROPIC_API_KEY: "x" });

        expect(registry.defaultProvider).toBe("mock");
        expect(registry.list()).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "anthropic", configured: true, model: "claude-opus-5-5" }),
            expect.objectContaining({ id: "openai", configured: false }),
        ]));
    });

    it("creates providers and rejects unknown ids", () => {
        const registry = new ProviderRegistry({ ANTHROPIC_API_KEY: "x" });

        expect(registry.create("anthropic", "claude-sonnet-5-5").model).toBe("claude-sonnet-5-5");
        expect(registry.create("mock").id).toBe("mock");
        expect(() => registry.create("nope")).toThrow("Unknown AI provider");
    });
});
