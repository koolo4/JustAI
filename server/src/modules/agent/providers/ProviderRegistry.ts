import type { ProviderInfo } from "@justai/shared";

import { BadRequestError } from "../../../core/errors/BadRequestError.js";
import { ANTHROPIC_DEFAULT_MODEL, AnthropicProvider } from "./AnthropicProvider.js";
import { MockProvider } from "./MockProvider.js";
import type { ModelProvider } from "./ModelProvider.js";
import { OPENAI_DEFAULT_MODEL, OpenAIProvider } from "./OpenAIProvider.js";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider.js";
import { COMPATIBLE_PRESETS, findPreset, RESERVE_IDS, resolvePreset } from "./compatiblePresets.js";
import { FallbackProvider } from "./FallbackProvider.js";

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

    /**
     * Создаёт провайдера; если настроены резервы (RESERVE1_*…RESERVE3_*) или последний резерв (локальная модель),
     * оборачивает его так, чтобы при исчерпании токенов, лимита или сбое ход уходил дальше по цепочке.
     */
    public create(id: string, model?: string): ModelProvider {
        const primary = this.createSingle(id, model);
        const lastResort = this.lastResort();
        const reserves = [...this.configuredReserves(), ...(lastResort ? [lastResort] : [])]
            .filter((reserve, index, list) => reserve !== id && list.indexOf(reserve) === index);

        if (id === "mock" || RESERVE_IDS.includes(id as typeof RESERVE_IDS[number]) || reserves.length === 0) {
            return primary;
        }

        return new FallbackProvider({
            primary,
            reserves: reserves.map(reserve => () => this.createSingle(reserve)),
            cooldownMs: positive(this.env.JUSTAI_RESERVE_COOLDOWN_SEC, 120) * 1000,
            onSwitch: (from, to, reason) =>
                console.warn(`[reserve] ${from.id}/${from.model} → ${to.id}/${to.model}: ${reason.slice(0, 200)}`),
        });
    }

    /**
     * Последнее звено цепочки: локальная модель без лимитов (по умолчанию Ollama).
     * JUSTAI_LAST_RESORT — id провайдера (ollama, lmstudio…) или "off".
     */
    public lastResort(): string | null {
        const id = this.env.JUSTAI_LAST_RESORT?.trim() || "ollama";

        if (id === "off" || id === "mock") {
            return null;
        }

        const preset = findPreset(id);
        return preset && resolvePreset(preset, this.env).configured ? id : null;
    }

    /** Резервы, у которых заданы адрес и модель. */
    public configuredReserves(): string[] {
        return RESERVE_IDS.filter(id => resolvePreset(findPreset(id)!, this.env).configured);
    }

    private createSingle(id: string, model?: string): ModelProvider {
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

                if (!resolved.baseURL) {
                    throw new BadRequestError(`Set ${preset.prefix}_BASE_URL in server/.env for ${preset.label}.`);
                }

                return new OpenAICompatibleProvider({
                    id: preset.id,
                    baseURL: resolved.baseURL,
                    apiKey: resolved.apiKey,
                    model: resolved.model,
                    maxOutputTokens: resolved.maxOutputTokens,
                    contextTokens: resolved.contextTokens,
                    ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}),
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
