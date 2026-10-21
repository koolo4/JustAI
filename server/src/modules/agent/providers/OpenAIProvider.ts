import OpenAI from "openai";
import type {
    FunctionTool,
    Response,
    ResponseInputContent,
    ResponseInputItem,
    ResponseOutputItem,
} from "openai/resources/responses/responses";

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

export const OPENAI_DEFAULT_MODEL = "gpt-5.6";

type ReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface OpenAIProviderOptions {
    apiKey?: string;
    baseURL?: string;
    model?: string;
    maxOutputTokens?: number;
    /** null — модель без reasoning (параметр не отправляется). */
    reasoningEffort?: ReasoningEffort | null;
}

/**
 * Responses API без хранения на стороне OpenAI (store: false):
 * reasoning-элементы возвращаются в зашифрованном виде и отправляются обратно как есть.
 */
export class OpenAIProvider implements ModelProvider {

    public readonly id = "openai";

    public readonly model: string;

    private readonly client: OpenAI;

    private readonly maxOutputTokens: number;

    private readonly reasoningEffort: ReasoningEffort | null;

    constructor(options: OpenAIProviderOptions = {}) {
        this.model = options.model ?? OPENAI_DEFAULT_MODEL;
        this.maxOutputTokens = options.maxOutputTokens ?? 64_000;
        this.reasoningEffort = options.reasoningEffort === undefined ? "medium" : options.reasoningEffort;

        this.client = new OpenAI({
            ...(options.apiKey ? { apiKey: options.apiKey } : {}),
            ...(options.baseURL ? { baseURL: options.baseURL } : {}),
            maxRetries: 4,
        });
    }

    public async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
        const stream = this.client.responses.stream(
            {
                model: this.model,
                instructions: request.system,
                input: toOpenAIInput(request.messages, this.id),
                tools: request.tools.map(toOpenAITool),
                max_output_tokens: this.maxOutputTokens,
                store: false,
                ...(this.reasoningEffort
                    ? {
                        reasoning: { effort: this.reasoningEffort, summary: "auto" as const },
                        include: ["reasoning.encrypted_content" as const],
                    }
                    : {}),
            },
            { signal: request.signal },
        );

        let response: Response;

        try {
            for await (const event of stream) {
                if (event.type === "response.output_text.delta") {
                    yield { type: "text_delta", text: event.delta };
                }
                else if (event.type === "response.reasoning_summary_text.delta") {
                    yield { type: "thinking_delta", text: event.delta };
                }
            }

            response = await stream.finalResponse();
        }
        catch (error) {
            if (error instanceof OpenAI.APIError || request.signal.aborted) {
                throw error;
            }

            throw new ModelOutputError(
                `Could not parse the model response: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
            );
        }

        const content = fromOpenAIOutput(response.output);

        yield {
            type: "done",
            turn: {
                content,
                stopReason: mapStatus(response, content),
                usage: mapUsage(response),
                model: response.model,
                providerRaw: response.output,
            },
        };
    }
}

export function toOpenAITool(spec: ToolSpec): FunctionTool {
    return {
        type: "function",
        name: spec.name,
        description: spec.description,
        parameters: spec.inputSchema,
        // Строгий режим требует, чтобы все поля были обязательными; вход проверяет AgentLoop.
        strict: false,
    };
}

export function toOpenAIInput(
    messages: Message[],
    providerId = "openai",
): ResponseInputItem[] {
    const items: ResponseInputItem[] = [];

    for (const message of messages) {
        if (
            message.role === "assistant" &&
            message.meta?.provider === providerId &&
            Array.isArray(message.meta.providerRaw)
        ) {
            items.push(...message.meta.providerRaw as ResponseInputItem[]);
            continue;
        }

        if (message.role === "assistant") {
            const text = message.content
                .filter(block => block.type === "text")
                .map(block => block.type === "text" ? block.text : "")
                .join("\n");

            if (text) {
                items.push({ role: "assistant", content: text });
            }

            for (const block of message.content) {
                if (block.type === "tool_use") {
                    items.push({
                        type: "function_call",
                        call_id: block.id,
                        name: block.name,
                        arguments: JSON.stringify(block.input ?? {}),
                    });
                }
            }

            continue;
        }

        const parts: ResponseInputContent[] = [];

        for (const block of message.content) {
            if (block.type === "tool_result") {
                items.push({
                    type: "function_call_output",
                    call_id: block.toolUseId,
                    output: toolOutputText(block.content, block.isError),
                });
            }
            else if (block.type === "text") {
                parts.push({ type: "input_text", text: block.text });
            }
            else if (block.type === "image") {
                parts.push({
                    type: "input_image",
                    image_url: `data:${block.mediaType};base64,${block.dataBase64}`,
                    detail: "auto",
                });
            }
        }

        if (parts.length > 0) {
            items.push({ role: "user", content: parts });
        }
    }

    return items;
}

function toolOutputText(output: ToolOutput, isError: boolean): string {
    const text = typeof output === "string"
        ? output
        : output.map(block => block.type === "text" ? block.text : "[image omitted]").join("\n");

    return isError ? `ERROR: ${text}` : text;
}

export function fromOpenAIOutput(output: ResponseOutputItem[]): ContentBlock[] {
    const blocks: ContentBlock[] = [];

    for (const item of output) {
        if (item.type === "reasoning") {
            const summary = item.summary.map(part => part.text).join("\n");

            if (summary) {
                blocks.push({ type: "thinking", text: summary });
            }
        }
        else if (item.type === "message") {
            for (const part of item.content) {
                if (part.type === "output_text") {
                    blocks.push({ type: "text", text: part.text });
                }
                else if (part.type === "refusal") {
                    blocks.push({ type: "text", text: part.refusal });
                }
            }
        }
        else if (item.type === "function_call") {
            blocks.push({
                type: "tool_use",
                id: item.call_id,
                name: item.name,
                input: parseArguments(item.arguments),
            });
        }
    }

    return blocks;
}

/**
 * Неразборчивые аргументы не роняют цикл: валидация в AgentLoop вернёт модели ошибку.
 */
function parseArguments(raw: string): unknown {
    try {
        return JSON.parse(raw || "{}");
    }
    catch {
        return { __invalid_json: raw };
    }
}

function mapStatus(response: Response, content: ContentBlock[]): StopReason {
    const refused = response.output.some(item =>
        item.type === "message" && item.content.some(part => part.type === "refusal"),
    );

    if (refused || response.incomplete_details?.reason === "content_filter") {
        return "refusal";
    }

    if (response.incomplete_details?.reason === "max_output_tokens") {
        return "max_tokens";
    }

    if (content.some(block => block.type === "tool_use")) {
        return "tool_use";
    }

    return response.status === "completed" ? "end_turn" : "other";
}

function mapUsage(response: Response): Usage {
    const cached = response.usage?.input_tokens_details?.cached_tokens ?? 0;

    return {
        inputTokens: (response.usage?.input_tokens ?? 0) - cached,
        outputTokens: response.usage?.output_tokens ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
    };
}
