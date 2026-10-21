import { z } from "zod";

import type { AgentEvent, ToolOutput } from "@justai/shared";

/**
 * read — без побочных эффектов (можно выполнять параллельно);
 * write — меняет файлы workspace; execute — запускает процессы; network — ходит в сеть.
 */
export type ToolKind = "read" | "write" | "execute" | "network";

export interface ToolContext {
    sessionId: string;
    toolUseId: string;
    workspaceRoot: string;
    signal: AbortSignal;
    emit(event: AgentEvent): void;
}

export interface Tool<Schema extends z.ZodType = z.ZodType> {
    readonly name: string;
    /** Для модели: что делает, когда использовать, ограничения. */
    readonly description: string;
    readonly inputSchema: Schema;
    readonly kind: ToolKind;
    run(input: z.infer<Schema>, context: ToolContext): Promise<ToolOutput>;
}

/**
 * Ожидаемая ошибка инструмента: сообщение уходит модели как tool_result с isError.
 */
export class ToolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ToolError";
    }
}

/**
 * Помогает TypeScript вывести тип input из схемы.
 */
export function defineTool<Schema extends z.ZodType>(
    tool: Tool<Schema>,
): Tool<Schema> {
    return tool;
}
