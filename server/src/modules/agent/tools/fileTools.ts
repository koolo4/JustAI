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
            "Each old_string must match the current text exactly (including indentation) and be unique.",
            "To insert text, include the neighbouring line in old_string and keep it in new_string. To add text at the end of a file, use write_file with append=true.",
            "Do not include the line-number prefixes from read_file. Line endings and encoding of the file are preserved automatically.",
            "The file must have been read with read_file first.",
        ].join(" "),
        inputSchema: z.object({
            path: z.string().describe("Workspace-relative file path."),
            edits: z.array(z.object({
                old_string: z.string().min(1).describe("Exact text to replace."),
                new_string: z.string().describe("Replacement text."),
                replace_all: z.boolean().default(false).describe("Replace every occurrence. Rarely needed: only together with expected_count."),
                expected_count: z.number().int().min(2).optional()
                    .describe("With replace_all: how many occurrences you expect to change. Required when old_string occurs more than once."),
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

                // Повтор уже сделанной правки (модель не заметила, что она применена): второй раз она портит файл —
                // дублирует блок или удаляет соседний код.
                if (isSubstantial(newText) && !newText.includes(oldText.trim())) {
                    const present = text.includes(newText) || looseMatches(text, newText).length > 0;

                    if (present) {
                        throw new ToolError(occurrences === 0
                            ? `${label}new_string is already in ${file} — this edit looks applied already. Nothing was written. Read the file to see its current state.`
                            : `${label}new_string is already in ${file}; replacing old_string with it would duplicate that text and delete old_string. If you meant to insert, keep old_string inside new_string. Nothing was written.`);
                    }
                }

                // Ещё чаще: модель «склеила» строки или поменяла отступы. Сопоставляем без учёта пробелов,
                // но только однозначно (одно место или replace_all с подтверждённым числом).
                if (occurrences === 0) {
                    const loose = looseMatches(text, oldText);

                    if (loose.length > 1 && edit.replace_all && edit.expected_count !== loose.length) {
                        throw new ToolError(`${label}old_string matches ${loose.length} places in ${file} (ignoring whitespace). Add surrounding context to change one place. Nothing was written.`);
                    }

                    if (loose.length === 1 || (loose.length > 1 && edit.replace_all)) {
                        for (const match of [...loose].reverse()) {
                            const replacement = reindent(newText, indentAt(text, match.index));
                            text = text.slice(0, match.index) + replacement + text.slice(match.index + match.length);
                        }

                        replacements += loose.length;
                        notes.push(`${label}old_string matched only when ignoring whitespace and line breaks; it was applied there. Copy text exactly, with its line breaks, next time.`);
                        return;
                    }
                }

                if (occurrences === 0) {
                    const hint = /\\[nt]/.test(edit.old_string)
                        ? " Note: old_string contains the two characters \\n; a line break must be a real newline (\"\\n\" in JSON)."
                        : "";
                    const closest = closestSnippet(text, oldText);
                    throw new ToolError([
                        `${label}old_string was not found in ${file}. Nothing was written.${hint}`,
                        closest
                            ? `The closest text in the file is below (line numbers are not part of the text). Copy old_string from it exactly:\n${closest}`
                            : "Read the file again and copy the text exactly.",
                    ].join("\n"));
                }

                // replace_all по нескольким местам — только с подтверждённым числом: иначе маленькая модель
                // меняет «display: flex» во всём файле, когда нужно в одном правиле.
                if (occurrences > 1 && (!edit.replace_all || edit.expected_count !== occurrences)) {
                    throw new ToolError(`${label}old_string occurs ${occurrences} times in ${file}. To change one place, add surrounding lines (for example the selector or function name) to make it unique. Only if every one of them must change, set replace_all=true and expected_count=${occurrences}. Nothing was written.`);
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
        description: [
            "Creates a new file or replaces the whole content of an existing one (an existing file must be read first).",
            "append=true adds content to the end of an existing file instead. Prefer edit_file for changes inside existing files.",
        ].join(" "),
        inputSchema: z.object({
            path: z.string().describe("Workspace-relative file path."),
            content: z.string().describe("Full file content (or, with append=true, the text to add at the end)."),
            append: z.boolean().default(false).describe("Add content to the end of the existing file."),
            confirm_shrink: z.boolean().default(false)
                .describe("Set only if you really mean to replace a file with much shorter content (most of it will be deleted)."),
        }),
        kind: "write",
        run: async ({ path: file, content: input, append, confirm_shrink }, context) => {
            let content = input;

            if (append) {
                const { state } = await files.readForEdit(context.sessionId, file);
                const separator = state.text === "" || state.text.endsWith("\n") ? "" : "\n";
                content = `${state.text}${separator}${input.replace(/\r\n/g, "\n")}`;
            }
            else if (!confirm_shrink) {
                // «Допиши в конец» маленькая модель выполняет как перезапись файла этим кусочком — остальное теряется.
                const existing = await files.readForEdit(context.sessionId, file).then(result => result.state.text, () => null);
                const oldLines = existing?.split("\n").length ?? 0;
                const newLines = content.split("\n").length;

                if (existing !== null && oldLines >= 30 && newLines < oldLines / 2) {
                    throw new ToolError([
                        `This would replace ${file} (${oldLines} lines) with ${newLines} lines and delete the rest. Nothing was written.`,
                        "To add text to the end, call write_file with append=true. To change a part, use edit_file.",
                        "Only if the whole file really must become this shorter content, call again with confirm_shrink=true.",
                    ].join(" "));
                }
            }

            const result = await files.write(context.sessionId, file, content);

            if (append) {
                return `Appended ${input.split("\n").length} lines to ${file}.\n\n${result.diff}`;
            }

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

/** Достаточно длинный текст, чтобы его повторное появление в файле не было случайным. */
function isSubstantial(text: string): boolean {
    return text.split("\n").filter(line => line.trim()).length >= 2 && text.trim().length >= 40;
}

/**
 * Где в файле, скорее всего, то, что искала модель: строка, совпадающая с первой непустой строкой old_string
 * (без учёта отступов), и столько же строк дальше — с номерами, чтобы модель скопировала настоящий текст.
 */
export function closestSnippet(text: string, oldText: string): string | null {
    const wanted = oldText.split("\n").map(line => line.trim()).filter(Boolean);
    const first = wanted[0];

    if (!first) return null;

    const lines = text.split("\n");
    const starts = lines.map((line, index) => ({ line: line.trim(), index })).filter(item => item.line === first || (first.length >= 8 && item.line.includes(first)));

    if (starts.length === 0 || starts.length > 3) return null;

    const span = Math.min(Math.max(wanted.length + 4, 6), 40);

    return starts.map(({ index }) => lines
        .slice(index, index + span)
        .map((line, offset) => `${index + offset + 1}\t${line}`)
        .join("\n")).join("\n…\n");
}

/**
 * Места, где old_string совпадает без учёта пробелов: любая последовательность пробельных символов
 * равна любой другой, а между соседними тегами («></div><div») пробелы допускаются.
 */
export function looseMatches(text: string, oldText: string): Array<{ index: number; length: number }> {
    const tokens = oldText.trim().split(/\s+/).filter(Boolean);

    if (tokens.length === 0 || oldText.trim().length < 8) {
        return [];
    }

    const pattern = tokens
        .map(token => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/></g, ">\\s*<"))
        .join("\\s+");

    const matches: Array<{ index: number; length: number }> = [];

    for (const match of text.matchAll(new RegExp(pattern, "g"))) {
        matches.push({ index: match.index, length: match[0].length });
    }

    return matches;
}

/** Отступ строки, в которой начинается совпадение (если перед ним на строке только пробелы). */
export function indentAt(text: string, index: number): string {
    const lineStart = text.lastIndexOf("\n", index - 1) + 1;
    const before = text.slice(lineStart, index);
    return /^[ \t]*$/.test(before) ? before : "";
}

/** Строки вставки без собственного отступа получают отступ места вставки (первая строка уже стоит на нём). */
export function reindent(newText: string, indent: string): string {
    if (!indent || !newText.includes("\n")) {
        return newText;
    }

    const lines = newText.split("\n");
    const hasOwnIndent = lines.slice(1).some(line => /^[ \t]+\S/.test(line));

    return hasOwnIndent
        ? newText
        : [lines[0], ...lines.slice(1).map(line => line.trim() ? indent + line : line)].join("\n");
}
