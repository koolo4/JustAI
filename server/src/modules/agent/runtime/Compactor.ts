import type { ContentBlock, Message, Usage } from "@justai/shared";

import type { ModelProvider } from "../providers/ModelProvider.js";
import { estimateTokens, messageTokens } from "./ContextWindow.js";

/**
 * Пересказ начала сессии: сообщения до `afterId` (включительно) заменяются текстом `text`.
 * Хранится в файле сессии, поэтому пересказ делается один раз, а не на каждом шаге.
 */
export interface Compaction {
    afterId: string;
    text: string;
}

const SUMMARY_SYSTEM = [
    "You compress the history of a coding agent session so the agent can continue the work with a small context window.",
    "Write a dense summary in English, at most 400 words, with these sections:",
    "Goal — what the user asked for.",
    "Done — what was done: files created or changed (with their purpose and current state), commands run and their results.",
    "Decisions — important choices and facts learned about the project.",
    "Problems — errors that are still open.",
    "Next — what remains to do.",
    "Mention exact file paths, names and commands. Do not invent anything that is not in the history.",
].join("\n");

const MAX_TEXT_CHARS = 1_500;
const MAX_INPUT_CHARS = 300;
const MAX_RESULT_CHARS = 400;

/** История с применённым пересказом: задача, заметка с пересказом, затем сообщения после него. */
export function applyCompaction(messages: Message[], compaction: Compaction | undefined): Message[] {
    if (!compaction || messages.length === 0) {
        return messages;
    }

    const index = messages.findIndex(message => message.id === compaction.afterId);

    if (index < 1) {
        return messages;
    }

    const first = messages[0]!;
    const note: ContentBlock = {
        type: "text",
        text: `[Summary of the earlier part of this session (${index} message(s) were compressed to fit the context window). Do not repeat work listed as done.]\n${compaction.text}`,
    };

    return [{ ...first, content: [...first.content, note] }, ...messages.slice(index + 1)];
}

/**
 * Индекс, с которого хвост истории помещается в `budget` токенов. Режем только перед сообщением ассистента,
 * чтобы пары tool_use/tool_result не разрывались. -1 — пересказывать нечего.
 */
export function chooseCut(messages: Message[], budget: number): number {
    let tail = 0;
    let cut = -1;

    for (let i = messages.length - 1; i >= 2; i -= 1) {
        tail += messageTokens(messages[i]!);

        if (tail > budget) {
            break;
        }

        if (messages[i]!.role === "assistant") {
            cut = i;
        }
    }

    // Хвост пуст (последний ход сам больше бюджета) — оставляем хотя бы последний ход ассистента.
    if (cut === -1) {
        for (let i = messages.length - 1; i >= 2; i -= 1) {
            if (messages[i]!.role === "assistant") {
                return i;
            }
        }
    }

    return cut;
}

/** Текстовая расшифровка сообщений для пересказа: большие входы и результаты обрезаются. */
export function renderTranscript(messages: Message[]): string {
    const lines: string[] = [];

    for (const message of messages) {
        for (const block of message.content) {
            switch (block.type) {
                case "text":
                    if (block.text.trim()) {
                        lines.push(`${message.role === "user" ? "User" : "Agent"}: ${clip(block.text, MAX_TEXT_CHARS)}`);
                    }
                    break;
                case "tool_use":
                    lines.push(`Agent called ${block.name}(${clip(JSON.stringify(block.input ?? {}), MAX_INPUT_CHARS)})`);
                    break;
                case "tool_result": {
                    const text = typeof block.content === "string"
                        ? block.content
                        : block.content.map(part => part.type === "text" ? part.text : "[image]").join(" ");
                    lines.push(`${block.isError ? "Tool error" : "Tool result"}: ${clip(text, MAX_RESULT_CHARS)}`);
                    break;
                }
                default:
                    break;
            }
        }
    }

    return lines.join("\n");
}

/**
 * Пересказать `messages` (и предыдущий пересказ) той же моделью. Расшифровка ужимается под окно модели.
 */
export async function summarizeHistory(
    provider: ModelProvider,
    messages: Message[],
    previous: string | undefined,
    signal: AbortSignal,
): Promise<{ text: string; usage: Usage }> {
    const window = provider.contextWindow;
    const maxChars = window
        ? Math.max(2_000, (window.tokens - window.reserveForOutput - estimateTokens(SUMMARY_SYSTEM) - 300) * 3)
        : 200_000;

    let transcript = renderTranscript(messages);

    if (previous) {
        transcript = `Earlier summary:\n${previous}\n\nLater history:\n${transcript}`;
    }

    if (transcript.length > maxChars) {
        // Конец важнее: там текущее состояние работы.
        transcript = `[…beginning omitted…]\n${transcript.slice(-maxChars)}`;
    }

    let result: { text: string; usage: Usage } | undefined;

    for await (const event of provider.stream({
        system: SUMMARY_SYSTEM,
        messages: [{
            id: "compaction-request",
            role: "user",
            createdAt: new Date().toISOString(),
            content: [{ type: "text", text: `Summarize this session history:\n\n${transcript}` }],
        }],
        tools: [],
        signal,
    })) {
        if (event.type === "done") {
            const text = event.turn.content
                .map(block => block.type === "text" ? block.text : "")
                .join("")
                .trim();
            result = { text, usage: event.turn.usage };
        }
    }

    if (!result?.text) {
        throw new Error("The model returned an empty summary.");
    }

    return result;
}

function clip(text: string, max: number): string {
    const single = text.replace(/\s+/g, " ").trim();
    return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}
