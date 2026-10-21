/**
 * Пресеты OpenAI-совместимых серверов. Всё переопределяется через env:
 * <PREFIX>_BASE_URL, <PREFIX>_MODEL, <PREFIX>_MAX_TOKENS и ключ из keyEnv.
 *
 * Модели по умолчанию — разумная отправная точка на дату написания; списки бесплатных
 * моделей у поставщиков меняются, актуальные имена смотрите на их сайтах.
 */
export interface CompatiblePreset {
    id: string;
    label: string;
    /** Префикс переменных окружения. */
    prefix: string;
    baseURL: string;
    /** Переменные с ключом (первая найденная). Нет — ключ не нужен (локальный сервер). */
    keyEnv: string[];
    defaultModel?: string;
    local: boolean;
    /** Окно контекста по умолчанию (переопределяется <PREFIX>_CONTEXT). */
    contextTokens: number;
    streamUsage?: boolean;
    headers?: Record<string, string>;
}

export const COMPATIBLE_PRESETS: CompatiblePreset[] = [
    {
        id: "ollama",
        label: "Ollama (local)",
        prefix: "OLLAMA",
        baseURL: "http://127.0.0.1:11434/v1",
        keyEnv: [],
        defaultModel: "qwen2.5-coder:7b",
        local: true,
        contextTokens: 32_768,
    },
    {
        id: "lmstudio",
        label: "LM Studio (local)",
        prefix: "LMSTUDIO",
        baseURL: "http://127.0.0.1:1234/v1",
        keyEnv: [],
        local: true,
        contextTokens: 32_768,
    },
    {
        id: "openrouter",
        label: "OpenRouter",
        prefix: "OPENROUTER",
        baseURL: "https://openrouter.ai/api/v1",
        keyEnv: ["OPENROUTER_API_KEY"],
        local: false,
        contextTokens: 128_000,
        headers: { "X-Title": "JustAI" },
    },
    {
        id: "groq",
        label: "Groq",
        prefix: "GROQ",
        baseURL: "https://api.groq.com/openai/v1",
        keyEnv: ["GROQ_API_KEY"],
        defaultModel: "openai/gpt-oss-120b",
        local: false,
        contextTokens: 128_000,
    },
    {
        id: "gemini",
        label: "Google Gemini",
        prefix: "GEMINI",
        baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
        keyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        defaultModel: "gemini-2.5-flash",
        local: false,
        contextTokens: 128_000,
    },
    {
        id: "github",
        label: "GitHub Models",
        prefix: "GITHUB_MODELS",
        baseURL: "https://models.github.ai/inference",
        keyEnv: ["GITHUB_MODELS_TOKEN", "GITHUB_TOKEN"],
        defaultModel: "openai/gpt-4.1",
        local: false,
        contextTokens: 128_000,
    },
    {
        id: "deepseek",
        label: "DeepSeek",
        prefix: "DEEPSEEK",
        baseURL: "https://api.deepseek.com/v1",
        keyEnv: ["DEEPSEEK_API_KEY"],
        defaultModel: "deepseek-chat",
        local: false,
        contextTokens: 128_000,
    },
];

export function findPreset(id: string): CompatiblePreset | undefined {
    return COMPATIBLE_PRESETS.find(preset => preset.id === id);
}

export interface ResolvedPreset {
    preset: CompatiblePreset;
    baseURL: string;
    apiKey: string;
    model: string | undefined;
    maxOutputTokens: number;
    contextTokens: number;
    reasoningEffort: string | undefined;
    configured: boolean;
}

export function resolvePreset(preset: CompatiblePreset, env: NodeJS.ProcessEnv, model?: string): ResolvedPreset {
    const apiKey = preset.keyEnv.map(name => env[name]).find(Boolean) ?? "";
    const resolvedModel = model || env[`${preset.prefix}_MODEL`] || preset.defaultModel;
    const maxTokens = Number(env[`${preset.prefix}_MAX_TOKENS`]);
    const context = Number(env[`${preset.prefix}_CONTEXT`]);

    return {
        preset,
        baseURL: env[`${preset.prefix}_BASE_URL`] || preset.baseURL,
        apiKey,
        model: resolvedModel,
        // Локальные модели медленные: длинный ответ — чаще всего зацикливание.
        maxOutputTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : (preset.local ? 4096 : 8192),
        contextTokens: Number.isFinite(context) && context > 0 ? context : preset.contextTokens,
        reasoningEffort: env[`${preset.prefix}_REASONING_EFFORT`] || undefined,
        configured: Boolean(resolvedModel) && (preset.local || Boolean(apiKey)),
    };
}
