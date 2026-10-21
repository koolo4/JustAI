import { randomUUID } from "node:crypto";

import OpenAI from "openai";
import type {
    ChatCompletionChunk,
    ChatCompletionContentPart,
    ChatCompletionMessageParam,
    ChatCompletionTool,
} from "openai/resources/chat/completions";

import type {
    ContentBlock,
    Message,
    StopReason,
    ToolOutput,
    Usage,
} from "@justai/shared";

import {
    ModelOutputError,
    type ModelProvider,
    type ModelRequest,
    type ModelStreamEvent,
    type ToolSpec,
} from "./ModelProvider.js";

export interface OpenAICompatibleOptions {
    /** Идентификатор пресета: ollama, openrouter, groq, … */
    id: string;
    baseURL: string;
    apiKey: string;
    model: string;
    maxOutputTokens?: number;
    /** Запрашивать usage в стриме (поддерживают не все серверы). */
    streamUsage?: boolean;
    /** Дополнительные заголовки (например, для OpenRouter). */
    headers?: Record<string, string>;
    /** Окно контекста модели в токенах (для ужатия истории). */
    contextTokens?: number;
}

/**
 * Провайдер для серверов с OpenAI Chat Completions API: Ollama, LM Studio, OpenRouter,
 * Groq, Gemini (OpenAI-режим), GitHub Models, DeepSeek и другие.
 *
 * Небольшие и бесплатные модели часто ошибаются в вызове инструментов, поэтому:
 * неразборчивые аргументы передаются в цикл как { __invalid_json } (валидация вернёт модели ошибку),
 * а вызов инструмента, написанный текстом (<tool_call>{…}</tool_call>, JSON-блок), распознаётся.
 */
export class OpenAICompatibleProvider implements ModelProvider {

    public readonly id: string;

    public readonly model: string;

    public readonly contextWindow?: { tokens: number; reserveForOutput: number };

    /** Модели через OpenAI-совместимые серверы чаще всего небольшие: включаем страховки цикла. */
    public readonly smallModelGuards = true;

    private readonly client: OpenAI;

    private readonly maxOutputTokens: number;

    private readonly streamUsage: boolean;

    constructor(options: OpenAICompatibleOptions) {
        this.id = options.id;
        this.model = options.model;
        this.maxOutputTokens = options.maxOutputTokens ?? 8192;
        this.streamUsage = options.streamUsage ?? true;

        if (options.contextTokens) {
            this.contextWindow = {
                tokens: options.contextTokens,
                // Ответ модели делит окно с промптом (так у Ollama и большинства локальных серверов).
                reserveForOutput: Math.min(this.maxOutputTokens, Math.floor(options.contextTokens / 4)),
            };
        }

        this.client = new OpenAI({
            baseURL: options.baseURL,
            // Локальным серверам ключ не нужен, но SDK требует непустую строку.
            apiKey: options.apiKey || "not-needed",
            maxRetries: 4,
            ...(options.headers ? { defaultHeaders: options.headers } : {}),
        });
    }

    public async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
        const toolNames = new Set(request.tools.map(tool => tool.name));
        const calls = new Map<number, { id: string; name: string; arguments: string }>();
        let text = "";
        let checkedAt = 0;
        let finish: string | null = null;
        let usage: ChatCompletionChunk["usage"] = null;
        let model = this.model;

        // Своя отмена: сторож повторов прерывает «зациклившуюся» генерацию.
        const local = new AbortController();
        const signal = AbortSignal.any([request.signal, local.signal]);

        try {
            const stream = await this.client.chat.completions.create(
                {
                    model: this.model,
                    messages: toChatMessages(request.system, request.messages),
                    ...(request.tools.length > 0 ? { tools: request.tools.map(toChatTool) } : {}),
                    max_tokens: this.maxOutputTokens,
                    stream: true,
                    ...(this.streamUsage ? { stream_options: { include_usage: true } } : {}),
                },
                { signal },
            );

            for await (const chunk of stream) {
                model = chunk.model || model;
                usage = chunk.usage ?? usage;

                const choice = chunk.choices[0];

                if (!choice) {
                    continue;
                }

                const delta = choice.delta as typeof choice.delta & {
                    reasoning?: string | null;
                    reasoning_content?: string | null;
                };

                const reasoning = delta.reasoning_content ?? delta.reasoning;

                if (reasoning) {
                    yield { type: "thinking_delta", text: reasoning };
                }

                if (delta.content) {
                    text += delta.content;
                    yield { type: "text_delta", text: delta.content };

                    // Проверка не на каждом чанке: раз в ~250 новых символов.
                    if (text.length - checkedAt >= 250 && (checkedAt = text.length) && isRepeating(text)) {
                        local.abort();
                        throw new ModelOutputError("The model got stuck repeating the same text; the request was interrupted.");
                    }
                }

                for (const call of delta.tool_calls ?? []) {
                    const current = calls.get(call.index) ?? { id: "", name: "", arguments: "" };

                    current.id ||= call.id ?? "";
                    current.name += call.function?.name ?? "";
                    current.arguments += call.function?.arguments ?? "";

                    calls.set(call.index, current);
                }

                finish = choice.finish_reason ?? finish;
            }
        }
        catch (error) {
            // Некоторые серверы (Ollama) сами разбирают вызов инструмента и отвечают 400,
            // если модель сгенерировала битый JSON: это ошибка формата ответа, её стоит повторить.
            if (error instanceof OpenAI.APIError && isMalformedToolCall(error)) {
                throw new ModelOutputError(`The model produced a malformed tool call: ${error.message}`, { cause: error });
            }

            if (error instanceof ModelOutputError || error instanceof OpenAI.APIError || request.signal.aborted) {
                throw error;
            }

            throw new ModelOutputError(
                `Could not read the model stream: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
            );
        }

        const content: ContentBlock[] = [];
        let remainingText = text;

        let toolUses = [...calls.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, call]) => ({
                type: "tool_use" as const,
                id: call.id || `call_${randomUUID()}`,
                name: call.name,
                input: parseArguments(call.arguments),
            }));

        let formatError: string | undefined;

        if (toolUses.length === 0 && text) {
            const extracted = extractTextToolCalls(text, toolNames);
            toolUses = extracted.calls;
            remainingText = extracted.text;

            if (extracted.malformed) {
                formatError = "Your last message contains a tool call written as text that could not be parsed, so nothing was executed. "
                    + "Call the tool again through the tool-calling interface with valid JSON arguments.";
            }
            else if (toolUses.length === 0 && describesActionWithoutDoingIt(remainingText) && toolNames.size > 0) {
                formatError = "You described an action instead of performing it, so nothing was changed. "
                    + "Do it yourself now by calling the right tool (for example edit_file, write_file or run_command). "
                    + "If the task is already complete, answer with a short summary of what was done.";
            }
        }

        if (remainingText.trim()) {
            content.push({ type: "text", text: remainingText.trim() });
        }

        content.push(...toolUses);

        yield {
            type: "done",
            turn: {
                content,
                stopReason: mapFinishReason(finish, toolUses.length > 0),
                usage: mapUsage(usage),
                model,
                ...(formatError ? { formatError } : {}),
            },
        };
    }
}

function isMalformedToolCall(error: InstanceType<typeof OpenAI.APIError>): boolean {
    return error.status === 400 &&
        /tool[ _]?call|function[ _]?call|parse|invalid .*argument/i.test(error.message);
}

export function toChatTool(spec: ToolSpec): ChatCompletionTool {
    return {
        type: "function",
        function: {
            name: spec.name,
            description: spec.description,
            parameters: spec.inputSchema,
        },
    };
}

export function toChatMessages(system: string, messages: Message[]): ChatCompletionMessageParam[] {
    const result: ChatCompletionMessageParam[] = [{ role: "system", content: system }];

    for (const message of messages) {
        if (message.role === "assistant") {
            const text = message.content
                .filter(block => block.type === "text")
                .map(block => block.type === "text" ? block.text : "")
                .join("\n");

            const toolCalls = message.content
                .filter(block => block.type === "tool_use")
                .map(block => block.type === "tool_use"
                    ? {
                        id: block.id,
                        type: "function" as const,
                        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
                    }
                    : null)
                .filter(call => call !== null);

            result.push({
                role: "assistant",
                content: text || null,
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            });

            continue;
        }

        // Результаты инструментов идут отдельными сообщениями role=tool сразу после вызова.
        for (const block of message.content) {
            if (block.type === "tool_result") {
                result.push({
                    role: "tool",
                    tool_call_id: block.toolUseId,
                    content: toolOutputText(block.content, block.isError),
                });
            }
        }

        const parts: ChatCompletionContentPart[] = [];

        for (const block of message.content) {
            if (block.type === "text") {
                parts.push({ type: "text", text: block.text });
            }
            else if (block.type === "image") {
                parts.push({ type: "image_url", image_url: { url: `data:${block.mediaType};base64,${block.dataBase64}` } });
            }
        }

        if (parts.length > 0) {
            const onlyText = parts.every(part => part.type === "text");

            result.push({
                role: "user",
                content: onlyText
                    ? parts.map(part => part.type === "text" ? part.text : "").join("\n")
                    : parts,
            });
        }
    }

    return result;
}

function toolOutputText(output: ToolOutput, isError: boolean): string {
    const text = typeof output === "string"
        ? output
        : output.map(block => block.type === "text" ? block.text : "[image omitted]").join("\n");

    return isError ? `ERROR: ${text}` : text;
}

function parseArguments(raw: string): unknown {
    if (!raw.trim()) {
        return {};
    }

    try {
        return JSON.parse(raw);
    }
    catch {
        return { __invalid_json: raw };
    }
}

interface TextToolCalls {
    calls: Array<{ type: "tool_use"; id: string; name: string; input: unknown }>;
    text: string;
    /** В тексте явно была попытка вызова инструмента, но разобрать её не удалось. */
    malformed: boolean;
}

const TOOL_TAGS = "tool_call|tool_request|function_call|tool_use|tool";

/**
 * Модели без нативного вызова инструментов (или с плохой поддержкой) пишут вызов текстом:
 * <tool_call>{"name": …, "arguments": …}</tool_call> (и похожие теги), ```json {…}```, JSON прямо в тексте.
 * Битый JSON (незакрытые скобки) чинится. Распознаются только имена из списка инструментов.
 */
export function extractTextToolCalls(text: string, toolNames: Set<string>): TextToolCalls {
    const calls: TextToolCalls["calls"] = [];
    let remaining = text;

    const take = (candidate: string): boolean => {
        let parsed: unknown;

        try {
            parsed = JSON.parse(candidate);
        }
        catch {
            const repaired = repairJson(candidate);

            try {
                parsed = repaired === null ? undefined : JSON.parse(repaired);
            }
            catch {
                return false;
            }

            if (parsed === undefined) {
                return false;
            }
        }

        const items = Array.isArray(parsed) ? parsed : [parsed];
        const found: TextToolCalls["calls"] = [];

        for (const item of items) {
            if (!item || typeof item !== "object") {
                return false;
            }

            const record = item as { name?: unknown; arguments?: unknown; parameters?: unknown };

            if (typeof record.name !== "string" || !toolNames.has(record.name)) {
                return false;
            }

            const raw: unknown = record.arguments ?? record.parameters ?? {};
            const input = typeof raw === "string" ? parseArguments(raw) : raw;

            found.push({ type: "tool_use", id: `call_${randomUUID()}`, name: record.name, input });
        }

        calls.push(...found);
        return found.length > 0;
    };

    const patterns = [
        new RegExp(`<(${TOOL_TAGS})>\\s*([\\s\\S]*?)\\s*<\\/\\1>`, "g"),
        // Тег открыт, но не закрыт до конца ответа.
        new RegExp(`<(${TOOL_TAGS})>\\s*([\\s\\S]*)$`, "g"),
    ];

    for (const pattern of patterns) {
        remaining = remaining.replace(pattern, (match, _tag: string, body: string) => take(body) ? "" : match);
    }

    remaining = remaining.replace(/```(?:json)?\s*([\[{][\s\S]*?[\]}])\s*```/g, (match, body: string) => take(body) ? "" : match);

    if (calls.length === 0) {
        // Один или несколько JSON-объектов прямо в тексте (часто — несколько подряд без массива).
        const kept: string[] = [];
        let last = 0;

        for (const { start, end } of topLevelJsonSpans(remaining)) {
            if (take(remaining.slice(start, end))) {
                kept.push(remaining.slice(last, start));
                last = end;
            }
        }

        if (calls.length > 0) {
            kept.push(remaining.slice(last));
            remaining = kept.join("").replace(/\n{3,}/g, "\n\n");
        }
    }

    if (calls.length === 0) {
        // Незакрытый объект вызова до конца текста: {"name": "edit_file", "arguments": {…
        const start = remaining.search(/\{\s*"name"\s*:/);

        if (start >= 0 && take(remaining.slice(start))) {
            remaining = remaining.slice(0, start);
        }
    }

    const names = [...toolNames].map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const attempted = calls.length === 0 && names.length > 0 && (
        new RegExp(`<(${TOOL_TAGS})>`).test(remaining) ||
        new RegExp(`"name"\\s*:\\s*"(${names})"`).test(remaining)
    );

    return { calls, text: remaining, malformed: attempted };
}

/**
 * Признак зацикливания: последние 200 символов встречаются в последних 4000 не меньше 4 раз.
 * Проверяется только на длинном тексте, чтобы не мешать коротким повторяющимся структурам.
 */
export function isRepeating(text: string): boolean {
    if (text.length < 2_000) {
        return false;
    }

    const window = text.slice(-4_000);
    const tail = window.slice(-200);

    if (tail.trim().length < 20) {
        return false;
    }

    let count = 0;
    let index = window.indexOf(tail);

    while (index !== -1) {
        count += 1;

        if (count >= 4) {
            return true;
        }

        index = window.indexOf(tail, index + 1);
    }

    return false;
}

/**
 * Маленькие модели часто описывают правку («I will add…», «Please apply the following edit…»)
 * вместо вызова инструмента. Признак: намерение или просьба к пользователю, и нет признаков завершённой работы.
 */
export function describesActionWithoutDoingIt(text: string): boolean {
    const intent = /\b(I will|I'll|let me|let's|let us|I am going to|I'm going to|next,? I|we will|we'll|we need to)\s+(now\s+)?(add|edit|update|create|modify|implement|write|run|fix|change|insert|apply|proceed|read|check|try|look)\b/i;
    const askUser = /\b(please|you (can|should|need to|could))\s+(apply|add|run|edit|insert|replace|update|create)\b|apply the following|###\s*tool call/i;

    return intent.test(text) || askUser.test(text);
}

/**
 * Дописывает незакрытые кавычки и скобки и исправляет перепутанные закрывающие скобки
 * (частая ошибка маленьких моделей). null — если текст не похож на JSON.
 */
export function repairJson(text: string): string | null {
    const source = text.trim();

    if (!source.startsWith("{") && !source.startsWith("[")) {
        return null;
    }

    const stack: string[] = [];
    let output = "";
    let inString = false;
    let escaped = false;

    for (const char of source) {
        if (inString) {
            output += char;

            if (escaped) {
                escaped = false;
            }
            else if (char === "\\") {
                escaped = true;
            }
            else if (char === "\"") {
                inString = false;
            }

            continue;
        }

        if (char === "\"") {
            inString = true;
            output += char;
            continue;
        }

        if (char === "{" || char === "[") {
            stack.push(char === "{" ? "}" : "]");
            output += char;
            continue;
        }

        if (char === "}" || char === "]") {
            // Закрывающая скобка не того типа: сначала закрываем то, что открыто внутри.
            while (stack.length > 0 && stack.at(-1) !== char) {
                output += stack.pop();
            }

            if (stack.length === 0) {
                // Лишняя закрывающая скобка — конец JSON.
                break;
            }

            stack.pop();
            output += char;

            if (stack.length === 0) {
                break;
            }

            continue;
        }

        output += char;
    }

    if (inString) {
        output += "\"";
    }

    output = output.replace(/,\s*$/, "");

    while (stack.length > 0) {
        output += stack.pop();
    }

    return output;
}

/**
 * Позиции JSON-объектов и массивов верхнего уровня в тексте (баланс скобок с учётом строк).
 */
function topLevelJsonSpans(text: string): Array<{ start: number; end: number }> {
    const spans: Array<{ start: number; end: number }> = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i += 1) {
        const char = text[i]!;

        if (inString) {
            if (escaped) {
                escaped = false;
            }
            else if (char === "\\") {
                escaped = true;
            }
            else if (char === "\"") {
                inString = false;
            }
            continue;
        }

        if (char === "\"" && depth > 0) {
            inString = true;
        }
        else if (char === "{" || char === "[") {
            if (depth === 0) {
                start = i;
            }
            depth += 1;
        }
        else if ((char === "}" || char === "]") && depth > 0) {
            depth -= 1;

            if (depth === 0 && start >= 0) {
                spans.push({ start, end: i + 1 });
                start = -1;
            }
        }
    }

    return spans;
}

function mapFinishReason(reason: string | null, hasToolCalls: boolean): StopReason {
    if (reason === "length") {
        return "max_tokens";
    }

    if (reason === "content_filter") {
        return "refusal";
    }

    if (hasToolCalls) {
        return "tool_use";
    }

    return "end_turn";
}

function mapUsage(usage: ChatCompletionChunk["usage"]): Usage {
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;

    return {
        inputTokens: (usage?.prompt_tokens ?? 0) - cached,
        outputTokens: usage?.completion_tokens ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
    };
}
