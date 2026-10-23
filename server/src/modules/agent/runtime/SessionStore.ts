import { promises as fs } from "node:fs";
import path from "node:path";

import type { Message, SessionSummary } from "@justai/shared";

import type { Compaction } from "./Compactor.js";

export interface StoredSession {
    summary: SessionSummary;
    /** Системный промпт, зафиксированный при создании сессии. */
    system: string;
    messages: Message[];
    /** Последний пересказ начала сессии (для моделей с маленьким окном). */
    compaction?: Compaction;
}

type Record =
    | { kind: "header"; summary: SessionSummary; system: string }
    | { kind: "message"; message: Message }
    | { kind: "summary"; summary: SessionSummary }
    | { kind: "compaction"; compaction: Compaction };

const ID_PATTERN = /^[a-zA-Z0-9-]+$/;

/**
 * Сессия = один JSONL-файл в .justai/sessions: заголовок, затем сообщения и обновления сводки.
 * Только дозапись: файл переживает падение процесса посреди шага.
 */
export class SessionStore {

    /** Последовательная запись в каждый файл. */
    private readonly queues = new Map<string, Promise<void>>();

    constructor(
        private readonly directory: string,
    ) {}

    public async create(session: StoredSession): Promise<void> {
        await fs.mkdir(this.directory, { recursive: true });
        await this.append(session.summary.id, { kind: "header", summary: session.summary, system: session.system });

        for (const message of session.messages) {
            await this.append(session.summary.id, { kind: "message", message });
        }
    }

    public appendMessage(id: string, message: Message): Promise<void> {
        return this.append(id, { kind: "message", message });
    }

    public appendCompaction(id: string, compaction: Compaction): Promise<void> {
        return this.append(id, { kind: "compaction", compaction });
    }

    public updateSummary(summary: SessionSummary): Promise<void> {
        return this.append(summary.id, { kind: "summary", summary });
    }

    public async load(id: string): Promise<StoredSession | null> {
        if (!ID_PATTERN.test(id)) {
            return null;
        }

        await this.queues.get(id);

        let text: string;

        try {
            text = await fs.readFile(this.file(id), "utf8");
        }
        catch {
            return null;
        }

        return fold(text);
    }

    /** Удалить файл сессии. false — такой сессии нет. */
    public async delete(id: string): Promise<boolean> {
        if (!ID_PATTERN.test(id)) {
            return false;
        }

        await this.queues.get(id)?.catch(() => undefined);
        this.queues.delete(id);

        try {
            await fs.rm(this.file(id));
            return true;
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return false;
            }

            throw error;
        }
    }

    public async list(): Promise<SessionSummary[]> {
        let files: string[];

        try {
            files = await fs.readdir(this.directory);
        }
        catch {
            return [];
        }

        const sessions = await Promise.all(
            files
                .filter(file => file.endsWith(".jsonl"))
                .map(file => this.load(file.slice(0, -".jsonl".length))),
        );

        return sessions
            .filter((session): session is StoredSession => session !== null)
            .map(session => session.summary)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    private append(id: string, record: Record): Promise<void> {
        const previous = this.queues.get(id) ?? Promise.resolve();
        const next = previous
            .catch(() => undefined)
            .then(() => fs.appendFile(this.file(id), `${JSON.stringify(record)}\n`, "utf8"));

        this.queues.set(id, next);
        return next;
    }

    private file(id: string): string {
        return path.join(this.directory, `${id}.jsonl`);
    }
}

function fold(text: string): StoredSession | null {
    let session: StoredSession | null = null;

    for (const line of text.split("\n")) {
        if (!line.trim()) {
            continue;
        }

        let record: Record;

        try {
            record = JSON.parse(line) as Record;
        }
        catch {
            // недописанная последняя строка после падения процесса
            continue;
        }

        if (record.kind === "header") {
            session = { summary: record.summary, system: record.system, messages: [] };
        }
        else if (session && record.kind === "message") {
            session.messages.push(record.message);
        }
        else if (session && record.kind === "summary") {
            session.summary = record.summary;
        }
        else if (session && record.kind === "compaction") {
            session.compaction = record.compaction;
        }
    }

    return session;
}
