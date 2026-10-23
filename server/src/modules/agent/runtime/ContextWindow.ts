import type { ContentBlock, Message, ToolOutput } from "@justai/shared";

import type { ToolSpec } from "../providers/ModelProvider.js";

/** Грубая оценка: ~3.5 символа на токен для кода и английского, кириллица дороже — берём с запасом. */
const CHARS_PER_TOKEN = 3;
const IMAGE_TOKENS = 1_500;

/** Последние сообщения не сжимаются: в них текущая работа. */
const KEEP_RECENT = 6;

const CLEARED_OUTPUT = "[Earlier output of this tool was removed to fit the context window. Call the tool again if you need it.]";

export interface ContextWindowOptions {
    /** Размер окна модели в токенах. */
    window: number;
    /** Сколько токенов оставить под ответ модели. */
    reserveForOutput: number;
    system: string;
    tools: ToolSpec[];
}

export interface CompactionResult {
    messages: Message[];
    /** Что было сделано (для логов/UI); пусто, если ничего. */
    actions: string[];
    estimatedTokens: number;
    /** Сколько старых сообщений выброшено (0 — только очистка или ничего). */
    dropped: number;
}

export function estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function outputTokens(output: ToolOutput): number {
    if (typeof output === "string") {
        return estimateTokens(output);
    }

    return output.reduce((sum, block) => sum + (block.type === "text" ? estimateTokens(block.text) : IMAGE_TOKENS), 0);
}

function blockTokens(block: ContentBlock): number {
    switch (block.type) {
        case "text":
        case "thinking":
            return estimateTokens(block.text);
        case "image":
            return IMAGE_TOKENS;
        case "tool_use":
            return estimateTokens(block.name) + estimateTokens(JSON.stringify(block.input ?? {})) + 10;
        case "tool_result":
            return outputTokens(block.content) + 10;
    }
}

export function messageTokens(message: Message): number {
    return message.content.reduce((sum, block) => sum + blockTokens(block), 4);
}

/**
 * Возвращает копию истории, которая помещается в окно модели. Сохранённая история не меняется.
 * 1) старые большие результаты инструментов заменяются пометкой;
 * 2) если не хватает — выбрасываются самые старые ходы (первое сообщение с задачей остаётся).
 */
/** Сколько токенов истории помещается в окно после системного промпта, инструментов и резерва под ответ. */
export function contextBudget(options: ContextWindowOptions): number {
    const overhead = estimateTokens(options.system) + estimateTokens(JSON.stringify(options.tools));
    return Math.floor((options.window - options.reserveForOutput - overhead) * 0.9);
}

export function fitToContextWindow(messages: Message[], options: ContextWindowOptions): CompactionResult {
    const overhead = estimateTokens(options.system) + estimateTokens(JSON.stringify(options.tools));
    const budget = contextBudget(options);

    const sizes = messages.map(messageTokens);
    let total = sizes.reduce((sum, size) => sum + size, 0);
    const actions: string[] = [];

    if (total <= budget) {
        return { messages, actions, estimatedTokens: total + overhead, dropped: 0 };
    }

    // 1. Очистка старых результатов инструментов.
    const result = messages.slice();
    const recentFrom = Math.max(1, messages.length - KEEP_RECENT);
    let cleared = 0;

    for (let i = 0; i < recentFrom && total > budget; i += 1) {
        const message = result[i]!;
        let changed = false;

        const content = message.content.map(block => {
            if (block.type !== "tool_result" || outputTokens(block.content) < 100) {
                return block;
            }

            changed = true;
            cleared += 1;
            return { ...block, content: CLEARED_OUTPUT };
        });

        if (changed) {
            const replaced = { ...message, content };
            total -= sizes[i]! - messageTokens(replaced);
            sizes[i] = messageTokens(replaced);
            result[i] = replaced;
        }
    }

    if (cleared > 0) {
        actions.push(`cleared ${cleared} old tool output(s)`);
    }

    if (total <= budget) {
        return { messages: result, actions, estimatedTokens: total + overhead, dropped: 0 };
    }

    // 2. Удаление самых старых ходов. Обрезаем перед сообщением ассистента,
    // чтобы пары tool_use/tool_result не разрывались.
    const first = result[0]!;
    let tail = total - sizes[0]!;
    let cut = -1;

    for (let i = 1; i < result.length; i += 1) {
        if (result[i]!.role === "assistant" && sizes[0]! + tail <= budget) {
            cut = i;
            break;
        }

        tail -= sizes[i]!;
    }

    if (cut === -1) {
        // Даже последний ход не помещается: оставляем задачу и последний ход ассистента с ответом на него.
        cut = lastAssistantIndex(result);
    }

    if (cut <= 1) {
        return { messages: result, actions, estimatedTokens: total + overhead, dropped: 0 };
    }

    const removed = cut - 1;
    const dropped = result.slice(1, cut);
    const changedFiles = filesChangedIn(dropped);
    const plan = latestPlan(dropped);
    const steps = stepsIn(dropped);

    const note: ContentBlock = {
        type: "text",
        text: [
            `[Note: ${removed} earlier message(s) of this session were removed to fit the context window. Do not repeat the steps below; re-read a file only if you need its exact current lines.]`,
            changedFiles.length > 0 ? `Files you already changed: ${changedFiles.join(", ")}` : "",
            steps.length > 0 ? `Steps already done (oldest first):\n${steps.join("\n")}` : "",
            plan ? `Your plan at that point:\n${plan}` : "",
        ].filter(Boolean).join("\n"),
    };

    const compacted = [{ ...first, content: [...first.content, note] }, ...result.slice(cut)];
    actions.push(`dropped ${removed} oldest message(s)`);

    return {
        messages: compacted,
        actions,
        dropped: removed,
        estimatedTokens: compacted.reduce((sum, message) => sum + messageTokens(message), 0) + overhead,
    };
}

const WRITE_TOOLS = new Set(["write_file", "edit_file"]);

function filesChangedIn(messages: Message[]): string[] {
    const files = new Set<string>();

    for (const message of messages) {
        for (const block of message.content) {
            if (block.type === "tool_use" && WRITE_TOOLS.has(block.name)) {
                const path = (block.input as { path?: unknown } | null)?.path;

                if (typeof path === "string") {
                    files.add(path);
                }
            }
        }
    }

    return [...files];
}

const MAX_STEPS = 30;

/**
 * Короткий журнал выброшенных шагов: «read_file index.html → ok», «delegate_task: … → <первая строка ответа>».
 * Без него модель с маленьким окном забывает сделанное и повторяет шаги по кругу.
 */
export function stepsIn(messages: Message[]): string[] {
    const results = new Map<string, { isError: boolean; first: string }>();

    for (const message of messages) {
        for (const block of message.content) {
            if (block.type === "tool_result") {
                const text = typeof block.content === "string"
                    ? block.content
                    : block.content.map(part => part.type === "text" ? part.text : "[image]").join(" ");
                results.set(block.toolUseId, { isError: block.isError === true, first: firstLine(text) });
            }
        }
    }

    const steps: string[] = [];

    for (const message of messages) {
        for (const block of message.content) {
            if (block.type !== "tool_use" || block.name === "todo_write") {
                continue;
            }

            const result = results.get(block.id);
            const outcome = !result ? "no result" : result.isError ? `failed: ${result.first}` : block.name === "read_file" ? "ok" : result.first;
            steps.push(`- ${block.name} ${describeInput(block.input)} → ${outcome}`);
        }
    }

    return steps.length > MAX_STEPS
        ? [`- … ${steps.length - MAX_STEPS} earlier step(s)`, ...steps.slice(-MAX_STEPS)]
        : steps;
}

function describeInput(input: unknown): string {
    const value = input as { path?: unknown; command?: unknown; task?: unknown; pattern?: unknown } | null;
    const main = value?.path ?? value?.command ?? value?.task ?? value?.pattern;
    return typeof main === "string" ? clip(main.replace(/\s+/g, " "), 100) : "";
}

function firstLine(text: string): string {
    return clip(text.trim().split("\n").find(line => line.trim() !== "")?.trim() ?? "", 120);
}

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function latestPlan(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        for (const block of messages[i]!.content) {
            if (block.type === "tool_use" && block.name === "todo_write") {
                const todos = (block.input as { todos?: Array<{ content?: unknown; status?: unknown }> } | null)?.todos;

                if (Array.isArray(todos)) {
                    return todos
                        .map(todo => `- [${String(todo.status)}] ${String(todo.content)}`)
                        .join("\n");
                }
            }
        }
    }

    return "";
}

function lastAssistantIndex(messages: Message[]): number {
    for (let i = messages.length - 1; i > 0; i -= 1) {
        if (messages[i]!.role === "assistant") {
            return i;
        }
    }

    return -1;
}
