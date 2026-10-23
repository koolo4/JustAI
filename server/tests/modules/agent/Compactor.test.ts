import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { Message } from "@justai/shared";

import { MockProvider } from "../../../src/modules/agent/providers/MockProvider.js";
import { AgentLoop, createMessage } from "../../../src/modules/agent/runtime/AgentLoop.js";
import { DEFAULT_BUDGET } from "../../../src/modules/agent/runtime/Budget.js";
import { applyCompaction, chooseCut, renderTranscript, type Compaction } from "../../../src/modules/agent/runtime/Compactor.js";
import { defineTool } from "../../../src/modules/agent/tools/Tool.js";

const echo = defineTool({
    name: "echo",
    description: "Echo text back.",
    inputSchema: z.object({ text: z.string() }),
    kind: "read",
    run: async ({ text }) => `echo:${text}`,
});

function session(): Message[] {
    return [
        createMessage("user", [{ type: "text", text: "Build the site." }]),
        createMessage("assistant", [{ type: "tool_use", id: "a", name: "read_file", input: { path: "index.html" } }]),
        createMessage("user", [{ type: "tool_result", toolUseId: "a", content: "x".repeat(3_000), isError: false }]),
        createMessage("assistant", [{ type: "tool_use", id: "b", name: "write_file", input: { path: "app.js", content: "y" } }]),
        createMessage("user", [{ type: "tool_result", toolUseId: "b", content: "Created app.js", isError: false }]),
    ];
}

describe("Compactor", () => {
    it("replaces compacted messages with the summary note and keeps the task", () => {
        const messages = session();
        const compaction: Compaction = { afterId: messages[2]!.id, text: "Read index.html." };
        const view = applyCompaction(messages, compaction);

        expect(view).toHaveLength(3);
        expect(view[0]!.content).toEqual([
            { type: "text", text: "Build the site." },
            { type: "text", text: expect.stringContaining("Read index.html.") },
        ]);
        expect(view.slice(1)).toEqual(messages.slice(3));
        // Неизвестный afterId (например, история из другой ветки) — история без изменений.
        expect(applyCompaction(messages, { afterId: "missing", text: "x" })).toBe(messages);
    });

    it("cuts before an assistant message so tool pairs stay together", () => {
        const messages = session();
        // Хвост из последнего хода (assistant + результат) больше 100 токенов не помещается — оставляем хотя бы его.
        expect(chooseCut(messages, 100)).toBe(3);
        // Вызывается, только когда пересказ нужен: первый ход ассистента пересказывается всегда.
        expect(chooseCut(messages, 100_000)).toBe(3);
    });

    it("renders a compact transcript with clipped tool results", () => {
        const transcript = renderTranscript(session());

        expect(transcript).toContain('Agent called read_file({"path":"index.html"})');
        expect(transcript).toContain("Tool result: Created app.js");
        expect(transcript.length).toBeLessThan(1_000);
    });

    it("summarizes old turns once instead of dropping them when the window is full", async () => {
        const provider = Object.assign(new MockProvider([
            { toolCalls: [{ name: "echo", input: { text: "a".repeat(1_500) } }] },
            { toolCalls: [{ name: "echo", input: { text: "b".repeat(1_500) } }] },
            { text: "Goal: test. Done: echoed a." },
            { text: "done" },
        ]), { contextWindow: { tokens: 1_200, reserveForOutput: 100 } });

        const saved: Message[] = [];
        const compactions: Compaction[] = [];

        const loop = new AgentLoop({
            sessionId: "s1",
            workspaceRoot: process.cwd(),
            provider,
            tools: [echo],
            system: "test system",
            limits: DEFAULT_BUDGET,
            signal: new AbortController().signal,
            emit: () => undefined,
            onMessage: async message => {
                saved.push(message);
            },
            onCompaction: async compaction => {
                compactions.push(compaction);
            },
        });

        const result = await loop.run([createMessage("user", [{ type: "text", text: "go" }])]);

        expect(result.status).toBe("completed");
        expect(provider.requests).toHaveLength(4);
        expect(provider.requests[2]!.system).toMatch(/^You compress/);
        expect(provider.requests[2]!.tools).toEqual([]);
        expect(compactions).toEqual([{ afterId: saved[1]!.id, text: "Goal: test. Done: echoed a." }]);

        const firstMessage = provider.requests[3]!.messages[0]!;
        expect(firstMessage.content.at(-1)).toMatchObject({ type: "text", text: expect.stringContaining("Done: echoed a.") });
        // Пересказ не попадает в сохранённую историю как сообщение.
        expect(saved.map(message => message.role)).toEqual(["assistant", "user", "assistant", "user", "assistant"]);
    });
});
