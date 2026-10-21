import { execFile } from "node:child_process";
import path from "node:path";

import { rgPath } from "@vscode/ripgrep";
import { z } from "zod";

import type { AgentFileSystem } from "./AgentFileSystem.js";
import { defineTool, ToolError, type Tool } from "./Tool.js";

const MAX_RESULT_LINES = 400;

/** Папки, которые не ищутся никогда (вдобавок к .gitignore). */
const ALWAYS_EXCLUDED = ["!.git", "!.justai", "!node_modules"];

/**
 * Поиск по workspace через ripgrep: уважает .gitignore, быстрый на больших проектах.
 */
export function createSearchTools(files: AgentFileSystem): Tool[] {
    const glob = defineTool({
        name: "glob",
        description: [
            "Finds files by name pattern, e.g. \"**/*.ts\" or \"src/**/*Controller.ts\". Respects .gitignore.",
            `Returns workspace-relative paths, at most ${MAX_RESULT_LINES}.`,
        ].join(" "),
        inputSchema: z.object({
            pattern: z.string().min(1).describe("Glob pattern relative to the search path."),
            path: z.string().default(".").describe("Directory to search in, relative to the workspace root."),
        }),
        kind: "read",
        run: async ({ pattern, path: directory }, context) => {
            const absolute = await files.resolve(directory, "read");
            const prefix = files.relative(absolute);

            const output = await ripgrep(
                ["--files", "--hidden", "--no-require-git", "--path-separator", "/", ...excludes(), "--glob", pattern],
                absolute,
                context.signal,
            );

            const paths = output
                .split("\n")
                .filter(Boolean)
                .map(file => prefix ? `${prefix}/${file}` : file)
                .sort();

            return limitLines(paths, "files") || "No files found.";
        },
    });

    const grep = defineTool({
        name: "grep",
        description: [
            "Searches file contents with a regular expression (ripgrep / Rust regex syntax). Respects .gitignore.",
            "output_mode: files_with_matches (default) lists matching files; content shows matching lines with line numbers; count shows matches per file.",
            "Use glob to restrict file types, e.g. \"*.ts\".",
        ].join(" "),
        inputSchema: z.object({
            pattern: z.string().min(1).describe("Regular expression."),
            path: z.string().default(".").describe("File or directory to search, relative to the workspace root."),
            glob: z.string().optional().describe("Only search files matching this glob, e.g. \"*.{ts,tsx}\"."),
            output_mode: z.enum(["files_with_matches", "content", "count"]).default("files_with_matches"),
            context: z.number().int().min(0).max(20).optional().describe("Lines of context around matches (content mode)."),
            case_insensitive: z.boolean().default(false),
        }),
        kind: "read",
        run: async (input, context) => {
            const target = await files.resolve(input.path, "read");
            const args = [
                "--hidden",
                "--no-require-git",
                "--with-filename",
                "--color", "never",
                "--no-heading",
                "--path-separator", "/",
                "--max-columns", "300",
                ...excludes(),
            ];

            if (input.case_insensitive) {
                args.push("-i");
            }

            if (input.glob) {
                args.push("--glob", input.glob);
            }

            if (input.output_mode === "files_with_matches") {
                args.push("--files-with-matches");
            }
            else if (input.output_mode === "count") {
                args.push("--count");
            }
            else {
                args.push("--line-number");

                if (input.context !== undefined) {
                    args.push("-C", String(input.context));
                }
            }

            // Путь относительно корня, чтобы rg печатал пути от корня workspace.
            const relativeTarget = path.relative(files.workspaceRoot, target) || ".";
            args.push("-e", input.pattern, "--", relativeTarget);

            const output = await ripgrep(args, files.workspaceRoot, context.signal);
            const lines = output.split("\n").filter(Boolean).map(stripDotSlash);

            return limitLines(lines, input.output_mode === "content" ? "lines" : "files") || "No matches found.";
        },
    });

    return [glob, grep];
}

function excludes(): string[] {
    return ALWAYS_EXCLUDED.flatMap(pattern => ["--glob", pattern]);
}

function ripgrep(args: string[], cwd: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            rgPath,
            args,
            { cwd, signal, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
            (error, stdout, stderr) => {
                // Код 1 у ripgrep — «ничего не найдено».
                if (error && (error as { code?: unknown }).code !== 1) {
                    if (signal.aborted) {
                        reject(error);
                        return;
                    }

                    reject(new ToolError(`Search failed: ${stderr.trim() || error.message}`));
                    return;
                }

                resolve(stdout.replace(/\r\n/g, "\n"));
            },
        );
    });
}

function limitLines(lines: string[], unit: string): string {
    if (lines.length <= MAX_RESULT_LINES) {
        return lines.join("\n");
    }

    return `${lines.slice(0, MAX_RESULT_LINES).join("\n")}\n\n[${lines.length - MAX_RESULT_LINES} more ${unit} not shown; narrow the pattern or path]`;
}

function stripDotSlash(line: string): string {
    return line.startsWith("./") ? line.slice(2) : line;
}
