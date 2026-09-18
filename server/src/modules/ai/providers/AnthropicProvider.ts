import type {
    AIProvider,
    AIProviderRequest,
    AIProviderResponse,
} from "../contracts/AIProvider.js";

export class AnthropicProvider implements AIProvider {

    public readonly name = "anthropic";

    constructor(
        private readonly apiKey: string,
        private readonly model: string = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
        private readonly baseUrl: string = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
    ) {}

    public async ask(
        request: AIProviderRequest,
    ): Promise<AIProviderResponse> {
        if (!this.apiKey) {
            throw new Error(
                "ANTHROPIC_API_KEY is not configured.",
            );
        }

        const tools =
            request.tools?.map(tool => ({
                name: tool.name,
                description: tool.description,
                input_schema:
                    tool.parameters ??
                    {
                        type: "object",
                        properties: {},
                    },
            }));

        const response =
            await fetch(
                `${this.baseUrl}/v1/messages`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-api-key": this.apiKey,
                        "anthropic-version": "2023-06-01",
                    },
                    body: JSON.stringify({
                        model: this.model,
                        max_tokens: Number(
                            process.env.ANTHROPIC_MAX_TOKENS ?? 4096,
                        ),
                        system: request.system,
                        messages: [
                            {
                                role: "user",
                                content: request.prompt,
                            },
                        ],
                        ...(tools && tools.length > 0
                            ? { tools }
                            : {}),
                    }),
                },
            );

        if (!response.ok) {
            throw new Error(
                `Anthropic request failed: ${response.status} ${await response.text()}`,
            );
        }

        const data =
            await response.json() as {
                content?: Array<{
                    type?: string;
                    text?: string;
                    name?: string;
                    input?: Record<string, unknown>;
                }>;
            };

        const toolUse =
            (data.content ?? []).find(
                block =>
                    block.type === "tool_use" &&
                    block.name,
            );

        if (toolUse?.name) {
            const args =
                Object.fromEntries(
                    Object.entries(
                        toolUse.input ?? {},
                    ).map(
                        ([key, value]) => [
                            key,
                            typeof value === "string"
                                ? value
                                : JSON.stringify(value),
                        ],
                    ),
                );

            return {
                content: "",
                toolCall: {
                    tool: toolUse.name,
                    arguments: args,
                },
            };
        }

        const content =
            (data.content ?? [])
                .filter(
                    block => block.type === "text",
                )
                .map(
                    block => block.text ?? "",
                )
                .join("\n")
                .trim();

        return {
            content:
                content ||
                "The model returned an empty response.",
        };
    }
}
