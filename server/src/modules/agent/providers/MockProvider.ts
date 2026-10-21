import { randomUUID } from "node:crypto";

import {
    emptyUsage,
    type ContentBlock,
    type Message,
    type StopReason,
} from "@justai/shared";

import type {
    ModelProvider,
    ModelRequest,
    ModelStreamEvent,
} from "./ModelProvider.js";

export interface MockToolCall {
    name: string;
    input: unknown;
}

export interface MockTurnScript {
    text?: string;
    thinking?: string;
    toolCalls?: MockToolCall[];
    stopReason?: StopReason;
    /** Бросить исключение вместо ответа. */
    error?: Error;
    /** Задержка перед ответом (для тестов отмены). */
    delayMs?: number;
}

export type MockScript =
    | MockTurnScript[]
    | ((request: ModelRequest, turnIndex: number) => MockTurnScript);

/**
 * Провайдер без сети. Используется в тестах (сценарии) и в UI как демо без API-ключа.
 */
export class MockProvider implements ModelProvider {

    public readonly id = "mock";

    public readonly model = "mock";

    /** Запросы, полученные провайдером (для проверок в тестах). */
    public readonly requests: ModelRequest[] = [];

    private turn = 0;

    constructor(
        private readonly script: MockScript = defaultMockScript,
    ) {}

    public async *stream(
        request: ModelRequest,
    ): AsyncIterable<ModelStreamEvent> {
        this.requests.push({
            ...request,
            messages: structuredClone(request.messages),
        });

        const index = this.turn++;
        const step = typeof this.script === "function"
            ? this.script(request, index)
            : this.script[index];

        if (!step) {
            throw new Error(`MockProvider: no scripted turn #${index}.`);
        }

        if (step.delayMs) {
            await sleep(step.delayMs, request.signal);
        }

        if (step.error) {
            throw step.error;
        }

        const content: ContentBlock[] = [];

        if (step.thinking) {
            yield { type: "thinking_delta", text: step.thinking };
            content.push({ type: "thinking", text: step.thinking });
        }

        if (step.text) {
            for (const chunk of chunks(step.text)) {
                yield { type: "text_delta", text: chunk };
            }
            content.push({ type: "text", text: step.text });
        }

        for (const call of step.toolCalls ?? []) {
            content.push({
                type: "tool_use",
                id: `toolu_mock_${randomUUID()}`,
                name: call.name,
                input: call.input,
            });
        }

        yield {
            type: "done",
            turn: {
                content,
                stopReason: step.stopReason ??
                    (step.toolCalls?.length ? "tool_use" : "end_turn"),
                usage: {
                    ...emptyUsage(),
                    inputTokens: 10,
                    outputTokens: 5,
                },
                model: this.model,
            },
        };
    }
}

/**
 * Демо-поведение: «прочитай <путь>» / «read <path>» вызывает read_file, остальное — эхо.
 */
function defaultMockScript(request: ModelRequest): MockTurnScript {
    const last = request.messages.at(-1);

    const toolResult = last?.content.find(block => block.type === "tool_result");

    if (toolResult && toolResult.type === "tool_result") {
        const text = typeof toolResult.content === "string"
            ? toolResult.content
            : toolResult.content
                .map(block => block.type === "text" ? block.text : "[image]")
                .join("\n");

        return {
            text: toolResult.isError
                ? `Mock: инструмент вернул ошибку:\n${text}`
                : `Mock: результат инструмента (первые 500 символов):\n\n${text.slice(0, 500)}`,
        };
    }

    const prompt = lastUserText(last);
    const read = prompt.match(/^(?:прочитай|открой|read|open)\s+(?:файл\s+)?(\S+)/i);

    if (read?.[1]) {
        return {
            text: `Читаю ${read[1]}.`,
            toolCalls: [{ name: "read_file", input: { path: read[1] } }],
        };
    }

    const run = prompt.match(/^(?:запусти|выполни|run)\s+([\s\S]+)/i);

    if (run?.[1]) {
        return {
            text: "Запускаю команду.",
            toolCalls: [{ name: "run_command", input: { command: run[1].trim() } }],
        };
    }

    const create = prompt.match(/^(?:создай|create)\s+(?:файл\s+)?(\S+)/i);

    if (create?.[1]) {
        return {
            text: `Создаю ${create[1]}.`,
            toolCalls: [{ name: "write_file", input: { path: create[1], content: "Created by the JustAI mock agent.\n" } }],
        };
    }

    return {
        text: `Mock-провайдер (без API-ключа). Вы написали: ${prompt}\n\nПопробуйте: «прочитай AGENTS.md», «запусти npm --version», «создай файл tmp/demo.txt».`,
    };
}

function lastUserText(message: Message | undefined): string {
    if (!message || message.role !== "user") {
        return "";
    }

    return message.content
        .filter(block => block.type === "text")
        .map(block => block.type === "text" ? block.text : "")
        .join("\n")
        .trim();
}

function* chunks(text: string, size = 24): Generator<string> {
    for (let i = 0; i < text.length; i += size) {
        yield text.slice(i, i + size);
    }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }

        const timer = setTimeout(resolve, ms);

        signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason);
        }, { once: true });
    });
}
