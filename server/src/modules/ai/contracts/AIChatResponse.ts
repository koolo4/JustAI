export interface AIChatResponse {

    answer: string;

    toolCall?: {

        tool: string;

        arguments: Record<string, string>;

    };

}