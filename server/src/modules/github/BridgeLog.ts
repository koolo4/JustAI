import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Событие ленты моста: что пришло с GitHub и что сделал этот ПК. */
export interface BridgeEvent {
    id: string;
    time: string;
    kind:
        | "task" | "feedback" | "start" | "done" | "failed" | "paused" | "stop-request"
        | "merged" | "command" | "waiting" | "error" | "gap" | "note";
    issue?: number;
    title?: string;
    text: string;
    /** Сессия агента — открыть полный ход работы. */
    sessionId?: string;
    /** Ссылка на GitHub (issue, PR). */
    url?: string;
}

const KEEP_IN_MEMORY = 500;
/** Сколько строк оставлять в файле при сжатии. */
const KEEP_ON_DISK = 2_000;

/**
 * Лента моста: одна хронология всех задач вместо отдельной сессии на каждую.
 * Хранится в .justai/bridge-log.jsonl (переживает перезапуск); последние события — в памяти для интерфейса.
 */
export class BridgeLog {

    private events: BridgeEvent[] = [];
    private loaded?: Promise<void>;
    private writes = Promise.resolve();
    private appended = 0;

    constructor(private readonly file: string) {}

    public static inWorkspace(workspaceRoot: string): BridgeLog {
        return new BridgeLog(path.join(workspaceRoot, ".justai", "bridge-log.jsonl"));
    }

    public add(event: Omit<BridgeEvent, "id" | "time">): BridgeEvent {
        const full: BridgeEvent = { id: randomUUID(), time: new Date().toISOString(), ...event };

        this.events.push(full);
        if (this.events.length > KEEP_IN_MEMORY) this.events.splice(0, this.events.length - KEEP_IN_MEMORY);

        this.writes = this.writes
            .then(async () => {
                await mkdir(path.dirname(this.file), { recursive: true });
                await appendFile(this.file, `${JSON.stringify(full)}\n`, "utf8");
                this.appended += 1;
                if (this.appended % 200 === 0) await this.compact();
            })
            .catch(() => undefined);

        return full;
    }

    /** События после after (id) или последние limit — по времени, старые первыми. */
    public async list(options: { after?: string; limit?: number } = {}): Promise<BridgeEvent[]> {
        await this.load();

        const limit = Math.min(Math.max(options.limit ?? 200, 1), KEEP_IN_MEMORY);
        const start = options.after ? this.events.findIndex(event => event.id === options.after) + 1 : 0;
        const items = start > 0 ? this.events.slice(start) : this.events;

        return items.slice(-limit);
    }

    public async flush(): Promise<void> {
        await this.writes;
    }

    private load(): Promise<void> {
        // Сначала дождаться своих записей: иначе можно прочитать строку, которую в этот момент дописывают.
        this.loaded ??= this.writes
            .then(() => readFile(this.file, "utf8"))
            .then(text => {
                const fromDisk = text.split("\n").filter(Boolean).flatMap(line => {
                    try {
                        return [JSON.parse(line) as BridgeEvent];
                    }
                    catch {
                        return [];
                    }
                });
                const known = new Set(this.events.map(event => event.id));
                this.events = [...fromDisk.filter(event => !known.has(event.id)), ...this.events].slice(-KEEP_IN_MEMORY);
            })
            .catch(() => undefined);

        return this.loaded;
    }

    private async compact(): Promise<void> {
        const lines = (await readFile(this.file, "utf8").catch(() => "")).split("\n").filter(Boolean);
        if (lines.length > KEEP_ON_DISK) await writeFile(this.file, `${lines.slice(-KEEP_ON_DISK).join("\n")}\n`, "utf8");
    }
}
