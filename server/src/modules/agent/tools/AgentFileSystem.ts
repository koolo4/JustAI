import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { createTwoFilesPatch } from "diff";

import type { AgentEvent } from "@justai/shared";

import { ForbiddenError } from "../../../core/errors/ForbiddenError.js";
import {
    EventBus,
    FileCreatedEvent,
    FileSavedEvent,
} from "../../../core/events/index.js";
import { resolveSafePath, type PathAccess } from "../../../infrastructure/filesystem/safePath.js";
import { ToolError } from "./Tool.js";

export interface FileState {
    /** Содержимое как на диске (с BOM и исходными переводами строк). */
    raw: string;
    /** Для модели: без BOM. */
    text: string;
    eol: "\r\n" | "\n";
    bom: boolean;
}

export interface WriteResult {
    created: boolean;
    diff: string;
}

/**
 * Файловый доступ агента:
 * - все пути через resolveSafePath;
 * - запись существующего файла только после чтения в этой сессии и только если файл
 *   с тех пор не менялся (не затираем правки пользователя);
 * - сохраняются BOM и стиль переводов строк;
 * - публикуются события workspace (UI обновляет дерево и открытый файл) и file.changed с диффом.
 */
export class AgentFileSystem {

    /** sessionId → абсолютный путь → хеш содержимого, которое видел агент. */
    private readonly seen = new Map<string, Map<string, string>>();

    constructor(
        public readonly workspaceRoot: string,
        private readonly eventBus: EventBus,
        private readonly emit: (event: AgentEvent) => void,
    ) {}

    public async resolve(target: string, access: PathAccess): Promise<string> {
        try {
            return await resolveSafePath(this.workspaceRoot, target, access);
        }
        catch (error) {
            if (error instanceof ForbiddenError) {
                throw new ToolError(`${error.message} (path: ${target})`);
            }
            throw error;
        }
    }

    public relative(absolute: string): string {
        return path.relative(this.workspaceRoot, absolute).split(path.sep).join("/");
    }

    /**
     * Читает файл и запоминает его версию для сессии.
     */
    public async read(sessionId: string, target: string): Promise<FileState> {
        const absolute = await this.resolve(target, "read");
        const raw = await readRaw(absolute, target);

        this.remember(sessionId, absolute, raw);

        return parse(raw);
    }

    /**
     * Читает файл для правки: требует, чтобы агент уже видел именно эту версию.
     */
    public async readForEdit(sessionId: string, target: string): Promise<{ absolute: string; state: FileState }> {
        const absolute = await this.resolve(target, "write");
        const raw = await readRaw(absolute, target);

        this.assertUnchanged(sessionId, absolute, raw, target);

        return { absolute, state: parse(raw) };
    }

    /**
     * Записывает текст (в формате модели: \n, без BOM), приводя его к стилю существующего файла.
     */
    public async write(sessionId: string, target: string, text: string): Promise<WriteResult> {
        const absolute = await this.resolve(target, "write");

        let previous: string | null = null;

        try {
            previous = await fs.readFile(absolute, "utf8");
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EISDIR") {
                throw new ToolError(`${target} is a directory.`);
            }
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }

        if (previous !== null) {
            this.assertUnchanged(sessionId, absolute, previous, target);
        }

        const raw = previous === null
            ? text
            : format(text, parse(previous));

        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, raw, "utf8");

        this.remember(sessionId, absolute, raw);

        const relative = this.relative(absolute);
        const diff = createTwoFilesPatch(
            `a/${relative}`,
            `b/${relative}`,
            previous === null ? "" : parse(previous).text,
            parse(raw).text,
            undefined,
            undefined,
            { context: 3 },
        );

        await this.eventBus.publish(
            previous === null
                ? new FileCreatedEvent(relative)
                : new FileSavedEvent(relative),
        );

        this.emit({ type: "file.changed", sessionId, path: relative, diff });

        return { created: previous === null, diff };
    }

    private remember(sessionId: string, absolute: string, raw: string): void {
        let files = this.seen.get(sessionId);

        if (!files) {
            files = new Map();
            this.seen.set(sessionId, files);
        }

        files.set(normalizeKey(absolute), hash(raw));
    }

    private assertUnchanged(sessionId: string, absolute: string, raw: string, display: string): void {
        const known = this.seen.get(sessionId)?.get(normalizeKey(absolute));

        if (known === undefined) {
            throw new ToolError(`Read ${display} with read_file before changing it.`);
        }

        if (known !== hash(raw)) {
            throw new ToolError(`${display} was modified since you last read it (possibly by the user). Read it again before changing it.`);
        }
    }
}

/** Текст модели → формат файла: BOM и переводы строк как в исходнике. */
export function format(text: string, like: Pick<FileState, "eol" | "bom">): string {
    const normalized = text.replace(/\r\n/g, "\n");
    const withEol = like.eol === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized;

    return like.bom ? `﻿${withEol}` : withEol;
}

export function parse(raw: string): FileState {
    const bom = raw.startsWith("﻿");
    const body = bom ? raw.slice(1) : raw;
    const eol = body.includes("\r\n") ? "\r\n" : "\n";

    return {
        raw,
        text: body.replace(/\r\n/g, "\n"),
        eol,
        bom,
    };
}

async function readRaw(absolute: string, display: string): Promise<string> {
    let raw: string;

    try {
        raw = decodeText(await fs.readFile(absolute));
    }
    catch (error) {
        throw new ToolError(fsErrorMessage(error, display));
    }

    if (raw.includes("\0")) {
        throw new ToolError(`${display} looks like a binary file.`);
    }

    return raw;
}

/**
 * UTF-8, а файлы с BOM UTF-16 (так пишет `echo > file` в Windows PowerShell 5.1) — тоже как текст.
 * BOM остаётся первым символом; при правке такой файл сохраняется в UTF-8 с BOM.
 */
export function decodeText(buffer: Buffer): string {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
        return buffer.toString("utf16le");
    }

    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
        // swap16 требует чётную длину.
        const swapped = Buffer.from(buffer.subarray(0, buffer.length - (buffer.length % 2)));
        swapped.swap16();
        return swapped.toString("utf16le");
    }

    return buffer.toString("utf8");
}

export function fsErrorMessage(error: unknown, display: string): string {
    switch ((error as NodeJS.ErrnoException).code) {
        case "ENOENT":
            return `${display} does not exist.`;
        case "EISDIR":
            return `${display} is a directory; use list_dir.`;
        case "ENOTDIR":
            return `${display} is not a directory.`;
        default:
            return `Cannot access ${display}: ${error instanceof Error ? error.message : String(error)}`;
    }
}

function hash(raw: string): string {
    return createHash("sha1").update(raw).digest("hex");
}

function normalizeKey(absolute: string): string {
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
