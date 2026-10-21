import type { ProviderInfo } from "@justai/shared";

import { BadRequestError } from "../../../core/errors/BadRequestError.js";
import { ANTHROPIC_DEFAULT_MODEL, AnthropicProvider } from "./AnthropicProvider.js";
import { MockProvider } from "./MockProvider.js";
import type { ModelProvider } from "./ModelProvider.js";
import { OPENAI_DEFAULT_MODEL, OpenAIProvider } from "./OpenAIProvider.js";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider.js";
import { COMPATIBLE_PRESETS, findPreset, resolvePreset } from "./compatiblePresets.js";

const ANTHROPIC_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const OPENAI_EFFORTS = ["minimal", "low", "medium", "high"] as const;

/**
 * Создаёт провайдеров по конфигурации из env. Модель можно переопределить на сессию.
 */
export class ProviderRegistry {

    constructor(
        private readonly env: NodeJS.ProcessEnv = process.env,
    ) {}

    public get defaultProvider(): string {
        return this.env.JUSTAI_PROVIDER || "mock";
    }

    public list(): ProviderInfo[] {
        return [
            {
                id: "anthropic",
                label: "Anthropic",
                configured: Boolean(this.env.ANTHROPIC_API_KEY || this.env.ANTHROPIC_AUTH_TOKEN),
                model: this.env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL,
            },
            {
                id: "openai",
                label: "OpenAI",
                configured: Boolean(this.env.OPENAI_API_KEY),
                model: this.env.OPENAI_MODEL || OPENAI_DEFAULT_MODEL,
            },
            ...COMPATIBLE_PRESETS.map(preset => {
                const resolved = resolvePreset(preset, this.env);

                return {
                    id: preset.id,
                    label: preset.label,
                    configured: resolved.configured,
                    model: resolved.model ?? `set ${preset.prefix}_MODEL`,
                };
            }),
            {
                id: "mock",
                label: "Mock (без ключа)",
                configured: true,
                model: "mock",
            },
        ];
    }

    public create(id: string, model?: string): ModelProvider {
        switch (id) {
            case "anthropic":
                return new AnthropicProvider({
                    model: model || this.env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL,
                    ...(this.env.ANTHROPIC_BASE_URL ? { baseURL: this.env.ANTHROPIC_BASE_URL } : {}),
                    maxOutputTokens: positive(this.env.ANTHROPIC_MAX_TOKENS, 64_000),
                    effort: choice(this.env.ANTHROPIC_EFFORT, ANTHROPIC_EFFORTS, "high"),
                    fallbacks: this.env.ANTHROPIC_FALLBACKS !== "off",
                });

            case "openai":
                return new OpenAIProvider({
                    model: model || this.env.OPENAI_MODEL || OPENAI_DEFAULT_MODEL,
                    ...(this.env.OPENAI_BASE_URL ? { baseURL: this.env.OPENAI_BASE_URL } : {}),
                    maxOutputTokens: positive(this.env.OPENAI_MAX_TOKENS, 64_000),
                    reasoningEffort: choice(this.env.OPENAI_REASONING_EFFORT, OPENAI_EFFORTS, "medium"),
                });

            case "mock":
                return new MockProvider();

            default: {
                const preset = findPreset(id);

                if (!preset) {
                    throw new BadRequestError(`Unknown AI provider: ${id}`);
                }

                const resolved = resolvePreset(preset, this.env, model);

                if (!resolved.model) {
                    throw new BadRequestError(`Set ${preset.prefix}_MODEL in server/.env or pass a model for ${preset.label}.`);
                }

                return new OpenAICompatibleProvider({
                    id: preset.id,
                    baseURL: resolved.baseURL,
                    apiKey: resolved.apiKey,
                    model: resolved.model,
                    maxOutputTokens: resolved.maxOutputTokens,
                    ...(preset.streamUsage === undefined ? {} : { streamUsage: preset.streamUsage }),
                    ...(preset.headers ? { headers: preset.headers } : {}),
                });
            }
        }
    }
}

/** "" или "off" выключает параметр (null), неизвестное значение — значение по умолчанию. */
function choice<T extends string>(
    value: string | undefined,
    allowed: readonly T[],
    fallback: T,
): T | null {
    if (value === "" || value === "off") {
        return null;
    }

    return allowed.includes(value as T) ? value as T : fallback;
}

function positive(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
