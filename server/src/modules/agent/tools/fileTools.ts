import { promises as fs } from "node:fs";

import { z } from "zod";

import { fsErrorMessage, type AgentFileSystem } from "./AgentFileSystem.js";
import { defineTool, ToolError, type Tool } from "./Tool.js";

const DEFAULT_READ_LIMIT = 2000;

/**
 * Файловые инструменты агента поверх AgentFileSystem.
 */
export function createFileTools(
    files: AgentFileSystem,
    shouldIgnore: (name: string) => boolean,
): Tool[] {
    const readFile = defineTool({
        name: "read_file",
        description: [
            "Reads a UTF-8 text file from the workspace. Returns lines prefixed with their 1-based line number and a tab.",
            `Reads up to ${DEFAULT_READ_LIMIT} lines by default; use offset/limit for large files.`,
            "You must read a file before editing or overwriting it.",
        ].join(" "),
        inputSchema: z.object({
            path: z.string().describe("Workspace-relative file path."),
            offset: z.number().int().min(1).optional().describe("1-based line to start from."),
            limit: z.number().int().min(1).optional().describe("Number of lines to read."),
        }),
        kind: "read",
        run: async ({ path: file, offset = 1, limit = DEFAULT_READ_LIMIT }, context) => {
            const { text } = await files.read(context.sessionId, file);
            const lines = text.split("\n");
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
            const absolute = await files.resolve(directory, "read");

            let entries;

            try {
                entries = await fs.readdir(absolute, { withFileTypes: true });
            }
            catch (error) {
                throw new ToolError(fsErrorMessage(error, directory));
            }

            const lines = entries
                .filter(entry => !shouldIgnore(entry.name) && entry.name !== ".justai")
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
            "Applies one or more exact text replacements to a workspace file. Edits are applied in order and atomically: if any edit fails, nothing is written.",
            "Each old_string must match the current text exactly (including indentation) and be unique unless replace_all is true.",
            "Do not include the line-number prefixes from read_file. Line endings and encoding of the file are preserved automatically.",
            "The file must have been read with read_file first.",
        ].join(" "),
        inputSchema: z.object({
            path: z.string().describe("Workspace-relative file path."),
            edits: z.array(z.object({
                old_string: z.string().min(1).describe("Exact text to replace."),
                new_string: z.string().describe("Replacement text."),
                replace_all: z.boolean().default(false).describe("Replace every occurrence."),
            })).min(1),
        }),
        kind: "write",
        run: async ({ path: file, edits }, context) => {
            const { state } = await files.readForEdit(context.sessionId, file);
            let text = state.text;
            let replacements = 0;

            const notes: string[] = [];

            edits.forEach((edit, index) => {
                let oldText = edit.old_string.replace(/\r\n/g, "\n");
                let newText = edit.new_string.replace(/\r\n/g, "\n");
                const label = edits.length > 1 ? `Edit #${index + 1}: ` : "";

                if (oldText === newText) {
                    throw new ToolError(`${label}old_string and new_string are identical.`);
                }

                let occurrences = text.split(oldText).length - 1;

                // Частая ошибка небольших моделей: перевод строки передан как два символа «\n».
                if (occurrences === 0 && /\\[nt]/.test(oldText)) {
                    const unescapedOld = unescapeWhitespace(oldText);
                    const found = text.split(unescapedOld).length - 1;

                    if (found > 0) {
                        oldText = unescapedOld;
                        newText = unescapeWhitespace(newText);
                        occurrences = found;
                        notes.push(`${label}old_string contained literal "\\n" sequences; they were treated as line breaks. Use real newlines next time.`);
                    }
                }

                if (occurrences === 0) {
                    const hint = /\\[nt]/.test(edit.old_string)
                        ? " Note: old_string contains the two characters \\n; a line break must be a real newline (\"\\n\" in JSON)."
                        : "";
                    throw new ToolError(`${label}old_string was not found in ${file}. Read the file again and copy the text exactly.${hint} Nothing was written.`);
                }

                if (occurrences > 1 && !edit.replace_all) {
                    throw new ToolError(`${label}old_string occurs ${occurrences} times in ${file}. Add surrounding context to make it unique, or set replace_all. Nothing was written.`);
                }

                text = edit.replace_all
                    ? text.split(oldText).join(newText)
                    : text.replace(oldText, () => newText);

                replacements += edit.replace_all ? occurrences : 1;
            });

            const result = await files.write(context.sessionId, file, text);

            return [`Updated ${file}: ${replacements} replacement(s).`, ...notes, "", result.diff].join("\n");
        },
    });

    const writeFile = defineTool({
        name: "write_file",
        description: "Creates a new file or replaces the whole content of an existing one (an existing file must be read first). Prefer edit_file for changes to existing files.",
        inputSchema: z.object({
            path: z.string().describe("Workspace-relative file path."),
            content: z.string().describe("Full file content."),
        }),
        kind: "write",
        run: async ({ path: file, content }, context) => {
            const result = await files.write(context.sessionId, file, content);

            return result.created
                ? `Created ${file} (${content.split("\n").length} lines).`
                : `Overwrote ${file}.\n\n${result.diff}`;
        },
    });

    return [readFile, listDir, editFile, writeFile];
}

function unescapeWhitespace(text: string): string {
    return text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}
