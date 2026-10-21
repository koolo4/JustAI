import { describe, expect, it } from "vitest";

import type { AgentEvent, Message } from "@justai/shared";

import { createMessage } from "../../../src/modules/agent/runtime/AgentLoop.js";
import { createTodoTool, latestTodos } from "../../../src/modules/agent/tools/todoTool.js";
import type { ToolContext } from "../../../src/modules/agent/tools/Tool.js";

describe("todo_write", () => {
    const tool = createTodoTool();

    it("emits the plan and reports progress", async () => {
        const events: AgentEvent[] = [];
        const context = { sessionId: "s", emit: (event: AgentEvent) => events.push(event) } as unknown as ToolContext;

        const todos = [
            { content: "Read the code", status: "completed" as const },
            { content: "Fix the bug", status: "in_progress" as const },
            { content: "Run tests", status: "pending" as const },
        ];

        expect(await tool.run(tool.inputSchema.parse({ todos }), context)).toBe("Plan updated: 1/3 completed.");
        expect(events).toEqual([{ type: "todo.updated", sessionId: "s", todos }]);

        await expect(tool.run(tool.inputSchema.parse({
            todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }],
        }), context)).rejects.toThrow("Only one item");
    });

    it("restores the latest successful plan from history", () => {
        const call = (id: string, todos: unknown): Message =>
            createMessage("assistant", [{ type: "tool_use", id, name: "todo_write", input: { todos } }]);
        const result = (id: string, isError: boolean): Message =>
            createMessage("user", [{ type: "tool_result", toolUseId: id, content: "", isError }]);

        const first = [{ content: "one", status: "pending" }];
        const second = [{ content: "one", status: "completed" }];

        expect(latestTodos([])).toEqual([]);
        expect(latestTodos([call("a", first), result("a", false), call("b", second), result("b", false)])).toEqual(second);
        // Неудачный вызов не считается.
        expect(latestTodos([call("a", first), result("a", false), call("b", second), result("b", true)])).toEqual(first);
    });
});
