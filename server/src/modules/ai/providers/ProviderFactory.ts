import { MockProvider } from "./MockProvider.js";
import { OpenAIProvider } from "./OpenAIProvider.js";
import { AnthropicProvider } from "./AnthropicProvider.js";

import type {
    AIProvider,
} from "../contracts/AIProvider.js";

export interface ProviderInfo {
    id: string;
    label: string;
    configured: boolean;
    model: string;
}

export class ProviderFactory {

    public create(
        provider: string,
    ): AIProvider {
        switch (provider.toLowerCase()) {
            case "mock":
                return new MockProvider();

            case "openai":
                return new OpenAIProvider(
                    process.env.OPENAI_API_KEY ?? "",
                );

            case "anthropic":
                return new AnthropicProvider(
                    process.env.ANTHROPIC_API_KEY ?? "",
                );

            default:
                throw new Error(
                    `Unknown AI provider: ${provider}`,
                );
        }
    }

    public list(): ProviderInfo[] {
        return [
            {
                id: "mock",
                label: "Mock",
                configured: true,
                model: "local",
            },
            {
                id: "openai",
                label: "OpenAI",
                configured: Boolean(process.env.OPENAI_API_KEY),
                model:
                    process.env.OPENAI_MODEL ??
                    "gpt-5.6",
            },
            {
                id: "anthropic",
                label: "Anthropic",
                configured: Boolean(process.env.ANTHROPIC_API_KEY),
                model:
                    process.env.ANTHROPIC_MODEL ??
                    "claude-sonnet-4-6",
            },
        ];
    }
}
