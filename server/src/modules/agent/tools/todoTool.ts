import { z } from "zod";

import type { Message, Todo } from "@justai/shared";

import { defineTool, ToolError, type Tool } from "./Tool.js";

export const TODO_TOOL = "todo_write";

const todoSchema = z.object({
    content: z.string().min(1).describe("What needs to be done, imperative form."),
    status: z.enum(["pending", "in_progress", "completed"]),
});

/**
 * План задачи, видимый пользователю. Каждый вызов заменяет весь список.
 */
export function createTodoTool(): Tool {
    return defineTool({
        name: TODO_TOOL,
        description: [
            "Creates or updates your task plan, shown to the user. Use it for tasks with 3 or more steps.",
            "Send the whole list every time. Keep exactly one item in_progress while working,",
            "mark items completed as soon as they are done, and add items when you discover new work.",
        ].join(" "),
        inputSchema: z.object({
            todos: z.array(todoSchema).max(50),
        }),
        kind: "read",
        run: async ({ todos }, context) => {
            const inProgress = todos.filter(todo => todo.status === "in_progress").length;

            if (inProgress > 1) {
                throw new ToolError("Only one item can be in_progress at a time.");
            }

            context.emit({ type: "todo.updated", sessionId: context.sessionId, todos });

            const done = todos.filter(todo => todo.status === "completed").length;
            return `Plan updated: ${done}/${todos.length} completed.`;
        },
    });
}

/**
 * Текущий план — вход последнего успешного вызова todo_write в истории.
 */
export function latestTodos(messages: Message[]): Todo[] {
    const failed = new Set<string>();

    for (const message of messages) {
        for (const block of message.content) {
            if (block.type === "tool_result" && block.isError) {
                failed.add(block.toolUseId);
            }
        }
    }

    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const blocks = messages[i]!.content;

        for (let j = blocks.length - 1; j >= 0; j -= 1) {
            const block = blocks[j]!;

            if (block.type === "tool_use" && block.name === TODO_TOOL && !failed.has(block.id)) {
                const parsed = z.object({ todos: z.array(todoSchema) }).safeParse(block.input);

                if (parsed.success) {
                    return parsed.data.todos;
                }
            }
        }
    }

    return [];
}
