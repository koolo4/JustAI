import { promises as fs } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { ForbiddenError } from "../../../core/errors/ForbiddenError.js";
import { resolveSafePath, type PathAccess } from "../../../infrastructure/filesystem/safePath.js";
import { defineTool, ToolError, type Tool } from "./Tool.js";

const DEFAULT_READ_LIMIT = 2000;

/**
 * Файловые инструменты агента. Все пути проходят через resolveSafePath.
 * Полная версия (запись через WorkspaceService, проверка «прочитан и не изменён») — задача P2-01.
 */
export function createFileTools(
    workspaceRoot: string,
    shouldIgnore: (name: string) => boolean,
): Tool[] {
    const resolve = async (target: string, access: PathAccess) => {
        try {
            return await resolveSafePath(workspaceRoot, target, access);
        }
        catch (error) {
            if (error instanceof ForbiddenError) {
                throw new ToolError(`${error.message} (path: ${target})`);
            }
            throw error;
        }
    };

    const readFile = defineTool({
        name: "read_file",
        description: [
            "Reads a UTF-8 text file from the workspace. Returns lines prefixed with their 1-based line numbers and a tab.",
            `Reads up to ${DEFAULT_READ_LIMIT} lines by default; use offset/limit for large files.`,
            "Read a file before editing it.",
        ].join(" "),
        inputSchema: z.object({
            path: z.string().describe("Workspace-relative file path."),
            offset: z.number().int().min(1).optional().describe("1-based line to start from."),
            limit: z.number().int().min(1).optional().describe("Number of lines to read."),
        }),
        kind: "read",
        run: async ({ path: file, offset = 1, limit = DEFAULT_READ_LIMIT }) => {
            const absolute = await resolve(file, "read");
            const content = await readText(absolute, file);
            const lines = content.split(/\r?\n/);
            const slice = lines.slice(offset - 1, offset - 1 + limit);

            if (slice.length === 0) {
                return `(no lines: the file has ${lines.length} lines)`;
            }

            const numbered = slice
                .map((line, index) => `${offset + index}\t${line}`)
                .join("\n");

            const rest = lines.length - (offset - 1 + slice.length);

            return rest > 0
                ? `${numbered}\n\n[${rest} more lines; continue with offset=${offset + slice.length}]`
                : numbered;
        },
    });

    const listDir = defineTool({
        name: "list_dir",
        description: "Lists files and folders in a workspace directory (non-recursive). Ignored folders such as node_modules and .git are hidden.",
        inputSchema: z.object({
            path: z.string().default(".").describe("Workspace-relative directory path. Defaults to the workspace root."),
        }),
        kind: "read",
        run: async ({ path: directory }) => {
            const absolute = await resolve(directory, "read");

            let entries;

            try {
                entries = await fs.readdir(absolute, { withFileTypes: true });
            }
            catch (error) {
                throw new ToolError(fsErrorMessage(error, directory));
            }

            const lines = entries
                .filter(entry => !shouldIgnore(entry.name))
                .sort((a, b) =>
                    a.isDirectory() !== b.isDirectory()
                        ? (a.isDirectory() ? -1 : 1)
                        : a.name.localeCompare(b.name),
                )
                .map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name);

            return lines.length > 0 ? lines.join("\n") : "(empty directory)";
        },
    });

    const editFile = defineTool({
        name: "edit_file",
        description: [
            "Replaces an exact text fragment in a workspace file.",
            "old_string must match the file exactly (including indentation) and be unique unless replace_all is true.",
            "Do not include the line-number prefixes from read_file in old_string.",
        ].join(" "),
        inputSchema: z.object({
            path: z.string().describe("Workspace-relative file path."),
            old_string: z.string().min(1).describe("Exact text to replace."),
            new_string: z.string().describe("Replacement text."),
            replace_all: z.boolean().default(false).describe("Replace every occurrence."),
        }),
        kind: "write",
        run: async ({ path: file, old_string, new_string, replace_all }) => {
            if (old_string === new_string) {
                throw new ToolError("old_string and new_string are identical; nothing to change.");
            }

            const absolute = await resolve(file, "write");
            const current = await readText(absolute, file);
            const occurrences = current.split(old_string).length - 1;

            if (occurrences === 0) {
                throw new ToolError(`old_string was not found in ${file}. Read the file again and copy the text exactly.`);
            }

            if (occurrences > 1 && !replace_all) {
                throw new ToolError(`old_string occurs ${occurrences} times in ${file}. Add surrounding context to make it unique, or set replace_all.`);
            }

            const updated = replace_all
                ? current.split(old_string).join(new_string)
                : current.replace(old_string, () => new_string);

            await fs.writeFile(absolute, updated, "utf8");

            return `Updated ${file}: ${replace_all ? occurrences : 1} replacement(s).`;
        },
    });

    const writeFile = defineTool({
        name: "write_file",
        description: "Creates a new file or overwrites an existing one with the given content. Prefer edit_file for changes to existing files.",
        inputSchema: z.object({
            path: z.string().describe("Workspace-relative file path."),
            content: z.string().describe("Full file content."),
        }),
        kind: "write",
        run: async ({ path: file, content }) => {
            const absolute = await resolve(file, "write");
            const existed = await fs.stat(absolute).then(() => true, () => false);

            await fs.mkdir(path.dirname(absolute), { recursive: true });
            await fs.writeFile(absolute, content, "utf8");

            return `${existed ? "Overwrote" : "Created"} ${file} (${content.length} characters).`;
        },
    });

    return [readFile, listDir, editFile, writeFile];
}

async function readText(absolute: string, display: string): Promise<string> {
    let content: string;

    try {
        content = await fs.readFile(absolute, "utf8");
    }
    catch (error) {
        throw new ToolError(fsErrorMessage(error, display));
    }

    if (content.includes("\0")) {
        throw new ToolError(`${display} looks like a binary file.`);
    }

    return content;
}

function fsErrorMessage(error: unknown, display: string): string {
    const code = (error as NodeJS.ErrnoException).code;

    switch (code) {
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
