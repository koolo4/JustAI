import { describe, expect, it } from "vitest";

import type { Message } from "@justai/shared";

import { createMessage } from "../../../src/modules/agent/runtime/AgentLoop.js";
import { estimateTokens, fitToContextWindow, messageTokens } from "../../../src/modules/agent/runtime/ContextWindow.js";

const options = { window: 32_768, reserveForOutput: 8_192, system: "s".repeat(6_000), tools: [] };

/** Синтетическая сессия: задача, затем N шагов «вызов инструмента → большой результат». */
function longSession(steps: number, outputChars = 4_000): Message[] {
    const messages: Message[] = [createMessage("user", [{ type: "text", text: "Refactor the project." }])];

    for (let i = 0; i < steps; i += 1) {
        const name = i % 50 === 0 ? "todo_write" : i % 3 === 0 ? "edit_file" : "read_file";
        const input = name === "todo_write"
            ? { todos: [{ content: `phase ${i}`, status: "in_progress" }, { content: "write tests", status: "pending" }] }
            : { path: `src/file${i}.ts` };

        messages.push(createMessage("assistant", [{ type: "tool_use", id: `t${i}`, name, input }]));
        messages.push(createMessage("user", [{ type: "tool_result", toolUseId: `t${i}`, content: "x".repeat(outputChars), isError: false }]));
    }

    return messages;
}

function total(messages: Message[]): number {
    return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}

function assertValidPairs(messages: Message[]): void {
    const open = new Set<string>();

    for (const message of messages) {
        for (const block of message.content) {
            if (block.type === "tool_use") {
                open.add(block.id);
            }
            if (block.type === "tool_result") {
                expect(open.has(block.toolUseId)).toBe(true);
                open.delete(block.toolUseId);
            }
        }
    }
}

describe("fitToContextWindow", () => {
    it("returns the history unchanged when it fits", () => {
        const messages = longSession(3, 200);
        const result = fitToContextWindow(messages, options);

        expect(result.messages).toBe(messages);
        expect(result.actions).toEqual([]);
    });

    it("first clears old tool outputs, keeping recent messages intact", () => {
        const messages = longSession(12, 6_000);
        const result = fitToContextWindow(messages, options);

        expect(result.actions[0]).toMatch(/cleared \d+ old tool output/);
        expect(result.messages).toHaveLength(messages.length);
        // Последние 6 сообщений не тронуты.
        expect(result.messages.slice(-6)).toEqual(messages.slice(-6));
        expect(JSON.stringify(result.messages[2])).toContain("removed to fit the context window");
        // Сохранённая история не изменилась.
        expect(JSON.stringify(messages[2])).not.toContain("removed to fit");
    });

    it("keeps a 300-step session within the window with valid tool pairs and a useful note", () => {
        const messages = longSession(300);
        const budget = options.window - options.reserveForOutput - estimateTokens(options.system);

        const result = fitToContextWindow(messages, options);

        expect(total(result.messages)).toBeLessThan(budget);
        expect(result.actions.some(action => action.startsWith("dropped"))).toBe(true);
        expect(result.messages[0]!.role).toBe("user");
        expect(result.messages[1]!.role).toBe("assistant");
        assertValidPairs(result.messages);

        const note = result.messages[0]!.content.at(-1);
        expect(note).toMatchObject({ type: "text" });
        const text = (note as { text: string }).text;
        expect(text).toContain("earlier message(s) of this session were removed");
        expect(text).toContain("Files you already changed: src/file3.ts");
        expect(text).toContain("- [in_progress] phase");
        expect(result.messages[0]!.content[0]).toEqual({ type: "text", text: "Refactor the project." });
    });
});
