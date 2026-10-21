import { z } from "zod";

import type { ProcessInfo, ProcessManager } from "../../../infrastructure/process/ProcessManager.js";
import type { AgentFileSystem } from "./AgentFileSystem.js";
import { defineTool, ToolError, type Tool } from "./Tool.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/** Сколько ждать первый вывод фонового процесса. */
const BACKGROUND_STARTUP_MS = 3_000;

/** Голова + хвост вывода: ошибки тестов и сборки обычно в конце. */
const OUTPUT_HEAD_CHARS = 4_000;
const OUTPUT_TAIL_CHARS = 24_000;

/**
 * Инструменты оболочки: запуск команд, фоновые процессы.
 * Разрешения проверяет PermissionGate до вызова (P2-04).
 */
export function createShellTools(
    files: AgentFileSystem,
    processes: ProcessManager,
    platform: NodeJS.Platform = process.platform,
): Tool[] {
    const shell = platform === "win32" ? "Windows PowerShell 5.1" : "bash";

    const runCommand = defineTool({
        name: "run_command",
        description: [
            `Runs a shell command (${shell}) in the workspace and returns its exit code and output (stdout and stderr combined).`,
            "Use it to install dependencies, build, run tests, linters and scripts.",
            "Commands run non-interactively (no stdin; CI=1): pass flags that avoid prompts and watch modes, e.g. \"npx vitest run\" instead of \"npx vitest\".",
            `Default timeout ${DEFAULT_TIMEOUT_MS / 1000}s, maximum ${MAX_TIMEOUT_MS / 1000}s.`,
            "For long-running processes such as dev servers set background=true, then use read_output and kill_process.",
            platform === "win32"
                ? "PowerShell 5.1 syntax: chain commands with \";\" (not \"&&\"), use $env:NAME for environment variables."
                : "",
        ].filter(Boolean).join(" "),
        inputSchema: z.object({
            command: z.string().min(1).describe("Command line to run."),
            cwd: z.string().default(".").describe("Working directory relative to the workspace root."),
            timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional(),
            background: z.boolean().default(false).describe("Start without waiting for completion (dev servers, watchers)."),
            description: z.string().optional().describe("Short note on what the command does (shown to the user)."),
        }),
        kind: "execute",
        run: async (input, context) => {
            const cwd = await files.resolve(input.cwd, "read");
            const onOutput = (chunk: string) => context.emit({
                type: "tool.progress",
                sessionId: context.sessionId,
                toolUseId: context.toolUseId,
                chunk,
            });

            if (input.background) {
                const started = processes.start(input.command, { cwd, owner: context.sessionId, onOutput });
                const info = await processes.wait(started.id, BACKGROUND_STARTUP_MS);
                const { output, next } = processes.read(info.id, 0);

                return [
                    `Started background process ${info.id} (${info.status}${info.exitCode !== null ? `, exit code ${info.exitCode}` : ""}).`,
                    `Use read_output with process_id="${info.id}" (since=${next}) to see more, kill_process to stop it.`,
                    "",
                    truncate(output) || "(no output yet)",
                ].join("\n");
            }

            const result = await processes.run(input.command, {
                cwd,
                owner: context.sessionId,
                timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
                signal: context.signal,
                onOutput,
            });

            const text = formatResult(result.info, result.output, input.timeout_ms ?? DEFAULT_TIMEOUT_MS);

            if (result.info.status !== "exited" || result.info.exitCode !== 0) {
                throw new ToolError(text);
            }

            return text;
        },
    });

    const readOutput = defineTool({
        name: "read_output",
        description: "Returns new output of a background process started with run_command, and whether it is still running.",
        inputSchema: z.object({
            process_id: z.string(),
            since: z.number().int().min(0).default(0).describe("Output offset returned by the previous call; 0 for everything kept."),
            wait_ms: z.number().int().min(0).max(30_000).default(0).describe("Wait up to this long for the process to exit first."),
        }),
        kind: "read",
        run: async ({ process_id, since, wait_ms }) => {
            const info = wait_ms > 0
                ? await processes.wait(process_id, wait_ms).catch(notFound)
                : undefined;

            const { output, next, skipped } = (() => {
                try {
                    return processes.read(process_id, since);
                }
                catch (error) {
                    return notFound(error);
                }
            })();

            const current = info ?? processes.list().find(item => item.id === process_id);

            return [
                `Process ${process_id}: ${describe(current)}. Next offset: ${next}.`,
                skipped > 0 ? `[${skipped} older characters were dropped]` : "",
                "",
                truncate(output) || "(no new output)",
            ].filter(line => line !== "").join("\n");
        },
    });

    const killProcess = defineTool({
        name: "kill_process",
        description: "Stops a background process (and its child processes).",
        inputSchema: z.object({
            process_id: z.string(),
        }),
        kind: "execute",
        run: async ({ process_id }) => {
            const info = await processes.kill(process_id).catch(notFound);
            return `Process ${process_id}: ${describe(info)}.`;
        },
    });

    const listProcesses = defineTool({
        name: "list_processes",
        description: "Lists background processes started in this session.",
        inputSchema: z.object({}),
        kind: "read",
        run: async (_input, context) => {
            const list = processes.list(context.sessionId);

            return list.length === 0
                ? "No background processes."
                : list.map(info => `${info.id}  ${describe(info)}  ${info.command}`).join("\n");
        },
    });

    return [runCommand, readOutput, killProcess, listProcesses];
}

function formatResult(info: ProcessInfo, output: string, timeoutMs: number): string {
    const status = info.status === "timed_out"
        ? `Timed out after ${timeoutMs / 1000}s and was killed.`
        : info.status === "killed"
            ? "Cancelled."
            : `Exit code: ${info.exitCode}`;

    return `${status}\n\n${truncate(output) || "(no output)"}`;
}

function describe(info: ProcessInfo | undefined): string {
    if (!info) {
        return "finished";
    }

    return info.status === "running"
        ? "running"
        : `${info.status}${info.exitCode !== null ? ` (exit code ${info.exitCode})` : ""}`;
}

function truncate(output: string): string {
    const text = output.trimEnd();

    if (text.length <= OUTPUT_HEAD_CHARS + OUTPUT_TAIL_CHARS) {
        return text;
    }

    const omitted = text.length - OUTPUT_HEAD_CHARS - OUTPUT_TAIL_CHARS;

    return `${text.slice(0, OUTPUT_HEAD_CHARS)}\n\n[… ${omitted} characters omitted …]\n\n${text.slice(-OUTPUT_TAIL_CHARS)}`;
}

function notFound(error: unknown): never {
    throw new ToolError(error instanceof Error ? error.message : String(error));
}
