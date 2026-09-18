export interface AIToolCall {

    tool: string;

    arguments: Record<string, string>;

}

export interface AIProviderRequest {

    prompt: string;

    system: string;

    context: string;

    tools?: Array<{
        name: string;
        description: string;
        parameters?: Record<string, unknown>;
    }>;

}

export interface AIProviderResponse {

    content: string;

    toolCall?: AIToolCall;

}

export interface AIProvider {

    readonly name: string;

    ask(
        request: AIProviderRequest,
    ): Promise<AIProviderResponse>;

}
