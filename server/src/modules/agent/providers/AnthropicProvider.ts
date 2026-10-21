import Anthropic from "@anthropic-ai/sdk";
import type {
    BetaContentBlock,
    BetaContentBlockParam,
    BetaMessage,
    BetaMessageParam,
    BetaStopReason,
    BetaTool,
    BetaToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

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

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicProviderOptions {
    apiKey?: string;
    baseURL?: string;
    model?: string;
    maxOutputTokens?: number;
    /** Глубина рассуждений. Для агентной работы — high (у Opus 5.5 по умолчанию medium). */
    effort?: Effort | null;
    /** Серверный фолбэк на другую модель при отказе (refusal). */
    fallbacks?: boolean;
}

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class AnthropicProvider implements ModelProvider {

    public readonly id = "anthropic";

    public readonly model: string;

    private readonly client: Anthropic;

    private readonly maxOutputTokens: number;

    private readonly effort: Effort | null;

    private readonly fallbacks: boolean;

    constructor(options: AnthropicProviderOptions = {}) {
        this.model = options.model ?? ANTHROPIC_DEFAULT_MODEL;
        this.maxOutputTokens = options.maxOutputTokens ?? 64_000;
        this.effort = options.effort === undefined ? "high" : options.effort;
        this.fallbacks = options.fallbacks ?? true;

        // Без явного ключа SDK берёт ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / профиль `ant auth login`.
        this.client = new Anthropic({
            ...(options.apiKey ? { apiKey: options.apiKey } : {}),
            ...(options.baseURL ? { baseURL: options.baseURL } : {}),
            maxRetries: 4,
        });
    }

    public async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
        const stream = this.client.beta.messages.stream(
            {
                model: this.model,
                max_tokens: this.maxOutputTokens,
                // Стабильный префикс (tools → system) кэшируется явной меткой,
                // растущая история — автоматической меткой на последнем блоке.
                system: [{
                    type: "text",
                    text: request.system,
                    cache_control: { type: "ephemeral" },
                }],
                cache_control: { type: "ephemeral" },
                thinking: { type: "adaptive", display: "summarized" },
                ...(this.effort ? { output_config: { effort: this.effort } } : {}),
                ...(this.fallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
                tools: request.tools.map(toAnthropicTool),
                messages: toAnthropicMessages(request.messages, this.id),
            },
            { signal: request.signal },
        );

        let final: BetaMessage;

        try {
            for await (const event of stream) {
                if (event.type !== "content_block_delta") {
                    continue;
                }

                if (event.delta.type === "text_delta") {
                    yield { type: "text_delta", text: event.delta.text };
                }
                else if (event.delta.type === "thinking_delta") {
                    yield { type: "thinking_delta", text: event.delta.thinking };
                }
            }

            final = await stream.finalMessage();
        }
        catch (error) {
            // Ошибки API (лимиты, авторизация, 5xx после ретраев) — не повторяем в цикле.
            // Остальное — как правило, неразборчивый JSON входа инструмента при eager streaming.
            if (error instanceof Anthropic.APIError || request.signal.aborted) {
                throw error;
            }

            throw new ModelOutputError(
                `Could not parse the model response: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
            );
        }

        yield {
            type: "done",
            turn: {
                content: fromAnthropicContent(final.content),
                stopReason: mapStopReason(final.stop_reason),
                usage: mapUsage(final.usage),
                model: final.model,
                providerRaw: final.content,
            },
        };
    }
}

export function toAnthropicTool(spec: ToolSpec): BetaTool {
    return {
        name: spec.name,
        description: spec.description,
        input_schema: spec.inputSchema as BetaTool.InputSchema,
        // Большие входы (содержимое файлов) стримятся по мере генерации;
        // валидация входа — в AgentLoop (zod).
        eager_input_streaming: true,
    };
}

/**
 * Внутренняя история → сообщения Messages API.
 * Ответы этого же провайдера отправляются в исходном виде (providerRaw):
 * thinking-блоки должны возвращаться без изменений.
 */
export function toAnthropicMessages(
    messages: Message[],
    providerId = "anthropic",
): BetaMessageParam[] {
    return messages.map(message => {
        if (
            message.role === "assistant" &&
            message.meta?.provider === providerId &&
            Array.isArray(message.meta.providerRaw)
        ) {
            return {
                role: "assistant",
                content: message.meta.providerRaw as BetaContentBlockParam[],
            };
        }

        const content = message.content
            .map(block => toAnthropicBlock(block, message.role))
            .filter((block): block is BetaContentBlockParam => block !== null);

        return {
            role: message.role,
            content: content.length > 0 ? content : [{ type: "text", text: "(empty)" }],
        };
    });
}

function toAnthropicBlock(
    block: ContentBlock,
    role: Message["role"],
): BetaContentBlockParam | null {
    switch (block.type) {
        case "text":
            return { type: "text", text: block.text };

        case "image":
            return role === "user" ? imageParam(block.mediaType, block.dataBase64) : null;

        case "tool_use":
            return { type: "tool_use", id: block.id, name: block.name, input: block.input };

        case "tool_result":
            return {
                type: "tool_result",
                tool_use_id: block.toolUseId,
                content: toolResultContent(block.content),
                is_error: block.isError,
            };

        case "thinking":
            // Без подписи отправить нельзя; от другого провайдера — просто пропускаем.
            return null;
    }
}

function toolResultContent(output: ToolOutput): BetaToolResultBlockParam["content"] {
    if (typeof output === "string") {
        return output;
    }

    return output.map(block =>
        block.type === "text"
            ? { type: "text" as const, text: block.text }
            : imageParam(block.mediaType, block.dataBase64),
    );
}

function imageParam(mediaType: string, data: string) {
    return {
        type: "image" as const,
        source: {
            type: "base64" as const,
            media_type: mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
            data,
        },
    };
}

export function fromAnthropicContent(content: BetaContentBlock[]): ContentBlock[] {
    const blocks: ContentBlock[] = [];

    for (const block of content) {
        switch (block.type) {
            case "text":
                blocks.push({ type: "text", text: block.text });
                break;

            case "thinking":
                if (block.thinking) {
                    blocks.push({ type: "thinking", text: block.thinking });
                }
                break;

            case "tool_use":
                blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
                break;

            default:
                // redacted_thinking, fallback и серверные блоки остаются только в providerRaw.
                break;
        }
    }

    return blocks;
}

export function mapStopReason(reason: BetaStopReason | null): StopReason {
    switch (reason) {
        case "end_turn":
        case "stop_sequence":
            return "end_turn";
        case "tool_use":
            return "tool_use";
        case "max_tokens":
            return "max_tokens";
        case "pause_turn":
            return "pause_turn";
        case "refusal":
            return "refusal";
        default:
            return "other";
    }
}

function mapUsage(usage: BetaMessage["usage"]): Usage {
    return {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    };
}
