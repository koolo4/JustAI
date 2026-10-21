/**
 * Внутренний формат сообщений агента (MASTER_PLAN, раздел 5.1).
 * Провайдеры переводят его в формат своего API и обратно.
 */

export type Role = "user" | "assistant";

export interface TextBlock {
    type: "text";
    text: string;
}

/** Рассуждения модели (сводка). Для повторной отправки провайдеру используется meta.providerRaw. */
export interface ThinkingBlock {
    type: "thinking";
    text: string;
}

export interface ImageBlock {
    type: "image";
    mediaType: string;
    dataBase64: string;
}

export interface ToolUseBlock {
    type: "tool_use";
    id: string;
    name: string;
    /** JSON как есть, без приведения значений к строкам. */
    input: unknown;
}

export type ToolOutput = string | Array<TextBlock | ImageBlock>;

export interface ToolResultBlock {
    type: "tool_result";
    toolUseId: string;
    content: ToolOutput;
    isError: boolean;
}

export type ContentBlock =
    | TextBlock
    | ThinkingBlock
    | ImageBlock
    | ToolUseBlock
    | ToolResultBlock;

export type StopReason =
    | "end_turn"
    | "tool_use"
    | "max_tokens"
    | "refusal"
    | "pause_turn"
    | "other";

export interface Usage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}

export interface MessageMeta {
    provider?: string;
    model?: string;
    usage?: Usage;
    stopReason?: StopReason;
    /**
     * Исходный контент ответа в формате провайдера. Отправляется тому же провайдеру
     * без изменений: часть моделей требует вернуть thinking-блоки нетронутыми.
     * Наружу (в UI) не передаётся.
     */
    providerRaw?: unknown;
}

export interface Message {
    id: string;
    role: Role;
    content: ContentBlock[];
    createdAt: string;
    meta?: MessageMeta;
}

export function emptyUsage(): Usage {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
    };
}

export function addUsage(a: Usage, b: Usage): Usage {
    return {
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
        cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    };
}
