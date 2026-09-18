import type {
    AIProvider,
    AIProviderRequest,
    AIProviderResponse,
} from "../contracts/AIProvider.js";

export class OpenAIProvider implements AIProvider {

    public readonly name = "openai";

    constructor(
        private readonly apiKey: string,
        private readonly model: string = process.env.OPENAI_MODEL || "gpt-5.6",
        private readonly baseUrl: string = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    ) {}

    public async ask(
        request: AIProviderRequest,
    ): Promise<AIProviderResponse> {
        if (!this.apiKey) {
            throw new Error(
                "OPENAI_API_KEY is not configured.",
            );
        }

        const tools =
            request.tools?.map(tool => ({
                type: "function" as const,
                name: tool.name,
                description: tool.description,
                parameters:
                    tool.parameters ??
                    {
                        type: "object",
                        properties: {},
                    },
            }));

        const response =
            await fetch(
                `${this.baseUrl}/responses`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${this.apiKey}`,
                    },
                    body: JSON.stringify({
                        model: this.model,
                        instructions: request.system,
                        input: [
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
                `OpenAI request failed: ${response.status} ${await response.text()}`,
            );
        }

        const data =
            await response.json() as {
                output?: Array<{
                    type?: string;
                    name?: string;
                    arguments?: string;
                    content?: Array<{
                        type?: string;
                        text?: string;
                    }>;
                }>;
            };

        const output =
            data.output ?? [];

        const functionCall =
            output.find(
                item =>
                    item.type === "function_call" &&
                    item.name,
            );

        if (functionCall?.name) {
            let args: Record<string, string> = {};

            if (functionCall.arguments) {
                try {
                    const parsed =
                        JSON.parse(
                            functionCall.arguments,
                        ) as Record<string, unknown>;

                    args = Object.fromEntries(
                        Object.entries(parsed).map(
                            ([key, value]) => [
                                key,
                                typeof value === "string"
                                    ? value
                                    : JSON.stringify(value),
                            ],
                        ),
                    );
                }
                catch {
                    throw new Error(
                        "OpenAI returned invalid tool arguments.",
                    );
                }
            }

            return {
                content: "",
                toolCall: {
                    tool: functionCall.name,
                    arguments: args,
                },
            };
        }

        const content =
            output
                .filter(
                    item => item.type === "message",
                )
                .flatMap(
                    item => item.content ?? [],
                )
                .filter(
                    item => item.type === "output_text",
                )
                .map(
                    item => item.text ?? "",
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
