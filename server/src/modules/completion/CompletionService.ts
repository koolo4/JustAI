import { findPreset, resolvePreset } from "../agent/providers/compatiblePresets.js";

export const DEFAULT_COMPLETION_MODEL = "qwen2.5-coder:7b";

const MAX_PREFIX = 4_000;
const MAX_SUFFIX = 1_500;
const MAX_COMPLETION_CHARS = 600;

export interface CompletionRequest {
    path: string;
    prefix: string;
    suffix: string;
}

/**
 * Автодополнение в редакторе: fill-in-the-middle локальной моделью Ollama (`/api/generate` c `suffix`).
 * JUSTAI_COMPLETION_MODEL задаёт модель; "off" выключает. Без Ollama подсказок просто нет.
 */
export class CompletionService {

    constructor(
        private readonly env: NodeJS.ProcessEnv = process.env,
        private readonly fetchImpl: typeof fetch = fetch,
    ) {}

    public get model(): string | null {
        const value = this.env.JUSTAI_COMPLETION_MODEL?.trim();
        if (value === "off") return null;
        return value || DEFAULT_COMPLETION_MODEL;
    }

    /** Корень нативного API Ollama: OLLAMA_BASE_URL указывает на OpenAI-совместимый /v1. */
    public get baseUrl(): string {
        const resolved = resolvePreset(findPreset("ollama")!, this.env);
        return resolved.baseURL.replace(/\/v1\/?$/, "").replace(/\/$/, "");
    }

    public async complete(request: CompletionRequest, signal: AbortSignal): Promise<string> {
        const model = this.model;

        if (!model) {
            return "";
        }

        const response = await this.fetchImpl(`${this.baseUrl}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal,
            body: JSON.stringify({
                model,
                prompt: request.prefix.slice(-MAX_PREFIX),
                suffix: request.suffix.slice(0, MAX_SUFFIX),
                stream: false,
                // Модель держится в памяти 10 минут: подсказки нужны сразу, без повторной загрузки.
                keep_alive: "10m",
                options: { temperature: 0.2, num_predict: 96, stop: ["\n\n\n"] },
            }),
        });

        if (!response.ok) {
            throw new Error(`Ollama completion failed: ${response.status} ${await response.text().catch(() => "")}`.slice(0, 300));
        }

        const body = await response.json() as { response?: string };
        return cleanCompletion(body.response ?? "", request.suffix);
    }
}

/**
 * Убрать то, что модель повторила из уже написанного после курсора, и ограничить длину.
 */
export function cleanCompletion(text: string, suffix: string): string {
    let completion = text.replace(/<\|[a-z_]+\|>/g, "");
    const nextLine = suffix.split("\n").map(line => line.trim()).find(Boolean);

    if (nextLine && nextLine.length > 2) {
        const at = completion.indexOf(nextLine);

        if (at > 0) {
            completion = completion.slice(0, at);
        }
    }

    if (completion.length > MAX_COMPLETION_CHARS) {
        const cut = completion.lastIndexOf("\n", MAX_COMPLETION_CHARS);
        completion = completion.slice(0, cut > 0 ? cut : MAX_COMPLETION_CHARS);
    }

    return completion.replace(/\s+$/, completion.endsWith("\n") ? "\n" : "");
}
