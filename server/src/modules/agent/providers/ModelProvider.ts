import type {
    ContentBlock,
    Message,
    StopReason,
    Usage,
} from "@justai/shared";

/**
 * Описание инструмента для модели: JSON Schema входа.
 */
export interface ToolSpec {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
    /** Системный промпт. Должен быть стабильным в течение сессии (кэширование). */
    system: string;
    messages: Message[];
    tools: ToolSpec[];
    signal: AbortSignal;
}

export interface ModelTurn {
    content: ContentBlock[];
    stopReason: StopReason;
    usage: Usage;
    model: string;
    /** Исходный контент ответа провайдера, см. MessageMeta.providerRaw. */
    providerRaw?: unknown;
    /**
     * Модель пыталась вызвать инструмент, но вызов не разобран. Цикл сообщит ей об ошибке,
     * а не завершит работу так, будто она закончила.
     */
    formatError?: string;
}

export type ModelStreamEvent =
    | { type: "text_delta"; text: string }
    | { type: "thinking_delta"; text: string }
    | { type: "done"; turn: ModelTurn };

export interface ModelProvider {
    readonly id: string;
    readonly model: string;

    /**
     * Окно контекста, если историю нужно ужимать на стороне клиента (локальные и бесплатные модели).
     * Не задано — история отправляется целиком (у Anthropic правка прошлых сообщений ломает thinking-блоки).
     */
    readonly contextWindow?: { tokens: number; reserveForOutput: number };

    /**
     * Включить страховки для небольших моделей: например, проверку ответа «я изменил файл»,
     * когда ни одной правки не было.
     */
    readonly smallModelGuards?: boolean;

    /**
     * Стримит один ответ модели. Последнее событие — всегда "done".
     * Ошибки API пробрасываются как исключения; ModelOutputError — повторяемая ошибка формата ответа.
     */
    stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}

/**
 * Модель вернула ответ, который нельзя разобрать (например, обрезанный JSON входа инструмента).
 * Цикл агента может повторить запрос.
 */
export class ModelOutputError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "ModelOutputError";
    }
}
