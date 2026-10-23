import OpenAI from "openai";

import { findPreset, resolvePreset } from "../providers/compatiblePresets.js";
import type { Embedder } from "./CodeIndex.js";

export const DEFAULT_EMBED_PROVIDER = "ollama";
export const DEFAULT_EMBED_MODEL = "nomic-embed-text";

/**
 * Эмбеддинги через OpenAI-совместимый /embeddings. Провайдер и модель — JUSTAI_EMBED_PROVIDER / JUSTAI_EMBED_MODEL
 * (по умолчанию локальная Ollama + nomic-embed-text: бесплатно и без лимитов).
 */
export class OpenAIEmbedder implements Embedder {

    public readonly model: string;
    private readonly client: OpenAI;
    private readonly provider: string;

    constructor(env: NodeJS.ProcessEnv = process.env) {
        this.provider = env.JUSTAI_EMBED_PROVIDER || DEFAULT_EMBED_PROVIDER;
        this.model = env.JUSTAI_EMBED_MODEL || DEFAULT_EMBED_MODEL;

        if (this.provider === "openai") {
            this.client = new OpenAI({ apiKey: env.OPENAI_API_KEY ?? "", maxRetries: 2, ...(env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : {}) });
            return;
        }

        const preset = findPreset(this.provider);

        if (!preset) {
            throw new Error(`Unknown embedding provider: ${this.provider}`);
        }

        const resolved = resolvePreset(preset, env);
        this.client = new OpenAI({ baseURL: resolved.baseURL, apiKey: resolved.apiKey || "not-needed", maxRetries: 2 });
    }

    public async embed(texts: string[], signal: AbortSignal): Promise<number[][]> {
        try {
            const response = await this.client.embeddings.create({ model: this.model, input: texts }, { signal });
            return [...response.data].sort((a, b) => a.index - b.index).map(item => item.embedding);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const hint = this.provider === "ollama"
                ? ` Make sure Ollama is running and the model is installed: ollama pull ${this.model}`
                : "";
            throw new Error(`Embeddings (${this.provider}/${this.model}) failed: ${message}.${hint}`);
        }
    }
}
