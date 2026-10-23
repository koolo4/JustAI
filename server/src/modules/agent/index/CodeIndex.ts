import { promises as fs } from "node:fs";
import path from "node:path";

import { decodeText } from "../tools/AgentFileSystem.js";
import { listProjectFiles } from "../tools/searchTools.js";

/** Векторизация текстов: OpenAI-совместимый /embeddings (Ollama, OpenRouter и др.). */
export interface Embedder {
    readonly model: string;
    embed(texts: string[], signal: AbortSignal): Promise<number[][]>;
}

export interface CodeChunk {
    path: string;
    startLine: number;
    endLine: number;
    text: string;
}

export interface SearchHit extends CodeChunk {
    score: number;
}

interface StoredChunk {
    startLine: number;
    endLine: number;
    /** Float32Array в base64: в несколько раз компактнее JSON-массива чисел. */
    vector: string;
}

interface StoredFile {
    mtimeMs: number;
    size: number;
    chunks: StoredChunk[];
}

interface StoredIndex {
    version: 1;
    model: string;
    files: Record<string, StoredFile>;
}

export const CHUNK_LINES = 40;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 3_000;
const BATCH = 32;

/** Расширения текстовых файлов, которые имеет смысл искать по смыслу. */
const TEXT_EXTENSIONS = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".mdx", ".txt", ".py", ".rb", ".go", ".rs", ".java", ".kt",
    ".cs", ".cpp", ".cc", ".c", ".h", ".hpp", ".php", ".swift", ".scala", ".sql", ".sh", ".ps1", ".bat", ".yml", ".yaml",
    ".toml", ".ini", ".xml", ".html", ".htm", ".css", ".scss", ".less", ".vue", ".svelte", ".astro", ".graphql", ".proto",
]);

/** Разбить файл на куски по CHUNK_LINES строк; пустые куски пропускаются. */
export function chunkFile(filePath: string, content: string): CodeChunk[] {
    const lines = content.split(/\r?\n/);
    const chunks: CodeChunk[] = [];

    for (let start = 0; start < lines.length; start += CHUNK_LINES) {
        const slice = lines.slice(start, start + CHUNK_LINES);
        const text = slice.join("\n");

        if (text.trim()) {
            chunks.push({ path: filePath, startLine: start + 1, endLine: start + slice.length, text });
        }
    }

    return chunks;
}

export function cosine(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i += 1) {
        dot += a[i]! * b[i]!;
        normA += a[i]! * a[i]!;
        normB += b[i]! * b[i]!;
    }

    return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

function encode(vector: number[]): string {
    return Buffer.from(new Float32Array(vector).buffer).toString("base64");
}

function decode(base64: string): Float32Array {
    const buffer = Buffer.from(base64, "base64");
    return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

/**
 * Семантический индекс проекта в `.justai/index/code.json`. Обновляется лениво перед поиском:
 * пересчитываются только изменённые файлы (по времени изменения и размеру).
 */
export class CodeIndex {

    private readonly file: string;
    private syncing?: Promise<void>;
    private cache?: StoredIndex;

    constructor(
        private readonly root: string,
        private readonly embedder: Embedder,
    ) {
        this.file = path.join(root, ".justai", "index", "code.json");
    }

    public async search(query: string, limit: number, signal: AbortSignal): Promise<{ hits: SearchHit[]; indexed: number; updated: number }> {
        const updated = await this.sync(signal);
        const index = this.cache!;
        const [queryVector] = await this.embedder.embed([`search_query: ${query}`], signal);
        const target = new Float32Array(queryVector!);
        const scored: Array<{ path: string; chunk: StoredChunk; score: number }> = [];

        for (const [filePath, stored] of Object.entries(index.files)) {
            for (const chunk of stored.chunks) {
                scored.push({ path: filePath, chunk, score: cosine(target, decode(chunk.vector)) });
            }
        }

        scored.sort((a, b) => b.score - a.score);

        const hits: SearchHit[] = [];

        for (const entry of scored.slice(0, limit)) {
            const text = await this.readLines(entry.path, entry.chunk.startLine, entry.chunk.endLine);
            hits.push({ path: entry.path, startLine: entry.chunk.startLine, endLine: entry.chunk.endLine, text, score: entry.score });
        }

        return { hits, indexed: Object.keys(index.files).length, updated };
    }

    /** Обновить индекс; возвращает число переиндексированных файлов. Параллельные вызовы ждут один проход. */
    public async sync(signal: AbortSignal): Promise<number> {
        let updated = 0;

        const run = async () => {
            updated = await this.syncOnce(signal);
        };

        if (this.syncing) {
            await this.syncing;
            return 0;
        }

        this.syncing = run().finally(() => {
            this.syncing = undefined;
        });

        await this.syncing;
        return updated;
    }

    private async syncOnce(signal: AbortSignal): Promise<number> {
        const index = await this.load();
        const files = (await listProjectFiles(this.root, signal))
            .filter(file => TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()))
            .slice(0, MAX_FILES);

        const present = new Set(files);
        let changed = false;

        for (const known of Object.keys(index.files)) {
            if (!present.has(known)) {
                delete index.files[known];
                changed = true;
            }
        }

        const pending: Array<{ file: string; stat: { mtimeMs: number; size: number }; chunks: CodeChunk[] }> = [];

        for (const file of files) {
            const absolute = path.join(this.root, ...file.split("/"));
            let stat;

            try {
                stat = await fs.stat(absolute);
            }
            catch {
                continue;
            }

            const known = index.files[file];

            if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
                continue;
            }

            if (stat.size > MAX_FILE_BYTES) {
                delete index.files[file];
                changed = true;
                continue;
            }

            const content = decodeText(await fs.readFile(absolute)).replace(/^﻿/, "");

            if (content.includes("\0")) {
                continue;
            }

            pending.push({ file, stat: { mtimeMs: stat.mtimeMs, size: stat.size }, chunks: chunkFile(file, content) });
        }

        const chunks = pending.flatMap(entry => entry.chunks.map(chunk => ({ entry, chunk })));
        const vectors: number[][] = [];

        for (let i = 0; i < chunks.length; i += BATCH) {
            if (signal.aborted) {
                throw new Error("Indexing was cancelled.");
            }

            const batch = chunks.slice(i, i + BATCH);
            vectors.push(...await this.embedder.embed(batch.map(({ chunk }) => `search_document: ${chunk.path}\n${chunk.text}`), signal));
        }

        let cursor = 0;

        for (const entry of pending) {
            index.files[entry.file] = {
                mtimeMs: entry.stat.mtimeMs,
                size: entry.stat.size,
                chunks: entry.chunks.map(chunk => ({
                    startLine: chunk.startLine,
                    endLine: chunk.endLine,
                    vector: encode(vectors[cursor++]!),
                })),
            };
            changed = true;
        }

        if (changed) {
            await fs.mkdir(path.dirname(this.file), { recursive: true });
            await fs.writeFile(this.file, JSON.stringify(index), "utf8");
        }

        return pending.length;
    }

    private async load(): Promise<StoredIndex> {
        if (this.cache && this.cache.model === this.embedder.model) {
            return this.cache;
        }

        try {
            const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as StoredIndex;

            // Другая модель — другие векторы: индекс строится заново.
            this.cache = parsed.version === 1 && parsed.model === this.embedder.model
                ? parsed
                : { version: 1, model: this.embedder.model, files: {} };
        }
        catch {
            this.cache = { version: 1, model: this.embedder.model, files: {} };
        }

        return this.cache;
    }

    private async readLines(filePath: string, start: number, end: number): Promise<string> {
        try {
            const content = decodeText(await fs.readFile(path.join(this.root, ...filePath.split("/"))));
            return content.split(/\r?\n/).slice(start - 1, end).join("\n");
        }
        catch {
            return "";
        }
    }
}
