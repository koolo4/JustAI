import { promises as fs } from "node:fs";
import path from "node:path";

import type { ContentBlock } from "@justai/shared";

import { resolveSafePath } from "../../../infrastructure/filesystem/safePath.js";
import { decodeText } from "../tools/AgentFileSystem.js";

const MAX_MENTIONS = 8;
const MAX_FILE_CHARS = 20_000;
const MAX_TOTAL_CHARS = 60_000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_DIR_ENTRIES = 200;

/** `@src/app.ts`, `@"docs/My file.md"`; e-mail вида a@b.c не считается упоминанием. */
const MENTION = /(?:^|[\s(])@("([^"]+)"|[^\s@"'`,;()]+)/g;

export function parseMentions(text: string): string[] {
    const found = new Set<string>();

    for (const match of text.matchAll(MENTION)) {
        const raw = (match[2] ?? match[1] ?? "").replace(/[.,:;!?)\]]+$/, "");

        if (raw) {
            found.add(raw);
        }
    }

    return [...found].slice(0, MAX_MENTIONS);
}

/**
 * @-упоминания файлов и папок: содержимое файла или список папки добавляется к сообщению,
 * чтобы модель не тратила шаги (и лимиты) на чтение. Доступ — по тем же правилам, что у инструментов.
 */
export async function expandMentions(
    text: string,
    root: string,
    shouldIgnore: (name: string) => boolean,
): Promise<ContentBlock[]> {
    const blocks: ContentBlock[] = [];
    let total = 0;

    for (const mention of parseMentions(text)) {
        if (total >= MAX_TOTAL_CHARS) {
            blocks.push({ type: "text", text: `[@${mention}: not attached — the attachment limit for one message was reached.]` });
            continue;
        }

        const attached = await attach(mention, root, shouldIgnore, MAX_TOTAL_CHARS - total);

        if (attached) {
            total += attached.length;
            blocks.push({ type: "text", text: attached });
        }
    }

    return blocks;
}

async function attach(
    mention: string,
    root: string,
    shouldIgnore: (name: string) => boolean,
    budget: number,
): Promise<string | null> {
    let absolute: string;

    try {
        absolute = await resolveSafePath(root, mention, "read");
    }
    catch {
        // Похоже на путь, но вне проекта или запрещён — скажем об этом; иначе это просто «@кто-то».
        return looksLikePath(mention) ? `[@${mention}: not attached — the path is outside the project or not accessible.]` : null;
    }

    const display = path.relative(root, absolute).split(path.sep).join("/") || ".";
    let stat;

    try {
        stat = await fs.stat(absolute);
    }
    catch {
        return looksLikePath(mention) ? `[@${mention}: not found in the project.]` : null;
    }

    if (stat.isDirectory()) {
        const entries = (await fs.readdir(absolute, { withFileTypes: true }))
            .filter(entry => !shouldIgnore(entry.name))
            .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
            .map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name);

        const shown = entries.slice(0, MAX_DIR_ENTRIES);
        const more = entries.length > shown.length ? `\n… ${entries.length - shown.length} more` : "";

        return clip(`[Attached by @mention: folder ${display}/]\n${shown.join("\n")}${more}`, budget);
    }

    if (stat.size > MAX_FILE_BYTES) {
        return `[@${display}: not attached — the file is larger than ${MAX_FILE_BYTES / 1024} KB. Read the needed part with read_file.]`;
    }

    const content = decodeText(await fs.readFile(absolute)).replace(/^﻿/, "");

    if (content.includes("\0")) {
        return `[@${display}: not attached — binary file.]`;
    }

    const limit = Math.min(MAX_FILE_CHARS, budget);
    const body = content.length > limit
        ? `${content.slice(0, limit)}\n… [truncated: ${content.length - limit} more characters; use read_file with offset for the rest]`
        : content;

    return `[Attached by @mention: ${display}]\n\`\`\`\n${body}\n\`\`\``;
}

function looksLikePath(mention: string): boolean {
    return /[\\/.]/.test(mention);
}

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}\n… [truncated]` : text;
}
