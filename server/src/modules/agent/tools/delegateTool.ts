import { z } from "zod";

import { defineTool, type Tool, type ToolContext } from "./Tool.js";

export const DELEGATE_TOOL = "delegate_task";

export interface DelegateInput {
    task: string;
}

/** Выполняет задачу исполнителем в рамках сессии планировщика; возвращает отчёт. */
export type Delegate = (input: DelegateInput, context: ToolContext) => Promise<string>;

/**
 * Инструмент планировщика: передать один шаг исполнителю (локальной модели).
 * Сам по себе ничего не меняет — действия исполнителя проходят обычные разрешения.
 */
export function createDelegateTool(delegate: () => Delegate): Tool {
    return defineTool({
        name: DELEGATE_TOOL,
        description: [
            "Gives one concrete, self-contained step to the executor (a local model that can edit files and run commands) and waits for its report.",
            "The executor does not see this conversation: include file paths, the exact change, relevant code, and the command that verifies the step.",
            "Returns the executor's report and the list of actions it actually performed.",
        ].join(" "),
        inputSchema: z.object({
            task: z.string().min(20).describe("Complete instructions for the executor."),
        }),
        // execute: выполняется последовательно и создаёт точку отката до первых изменений.
        kind: "execute",
        run: (input, context) => delegate()(input, context),
    });
}
