import { existsSync } from "node:fs";
import path from "node:path";

import type { ProcessManager } from "../../../infrastructure/process/ProcessManager.js";
import { detectProjects } from "../project/ProjectDetector.js";
import { planChecks } from "../runtime/Verifier.js";

export interface Diagnostic {
    /** Путь от корня проекта через «/». */
    path: string;
    line: number;
    column: number;
    severity: "error" | "warning";
    code?: string;
    message: string;
}

export interface DiagnosticsResult {
    checks: Array<{ cwd: string; command: string; ok: boolean }>;
    diagnostics: Diagnostic[];
    /** Хвост вывода упавших проверок, если ошибки не удалось разобрать построчно. */
    unparsed: string;
}

/** tsc: `src/a.ts(12,5): error TS2322: Type …` */
const TSC = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/;
/** eslint (unix/compact), gcc, mypy, pyflakes: `src/a.ts:12:5: error: …` или `a.py:3:1 message`. */
const COLON = /^((?:[A-Za-z]:)?[^:\s][^:]*?):(\d+):(\d+):?\s*(?:(error|warning)\s*:?\s*)?(.+)$/i;

const MAX_DIAGNOSTICS = 200;
const UNPARSED_TAIL = 3_000;

/**
 * Разбор вывода проверок в список ошибок. `cwd` — папка проверки от корня (в монорепо — пакет),
 * пути из вывода пересчитываются от корня проекта.
 */
export function parseDiagnostics(output: string, cwd: string, root?: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trim();
        const tsc = TSC.exec(line);
        const colon = tsc ? null : COLON.exec(line);
        const match = tsc ?? colon;

        if (!match) {
            continue;
        }

        const file = match[1]!.trim();

        if (/^(https?|node|internal)\b/.test(file) || file.includes(" at ")) {
            continue;
        }

        diagnostics.push({
            path: toProjectPath(file, cwd, root),
            line: Number(match[2]),
            column: Number(match[3]),
            severity: (tsc ? match[4] : match[4] ?? "error")!.toLowerCase() === "warning" ? "warning" : "error",
            ...(tsc ? { code: match[5]! } : {}),
            message: (tsc ? match[6] : match[5])!.trim(),
        });
    }

    return diagnostics.slice(0, MAX_DIAGNOSTICS);
}

function toProjectPath(file: string, cwd: string, root: string | undefined): string {
    const normalized = file.replace(/\\/g, "/");

    if (root && path.isAbsolute(file)) {
        return path.relative(root, file).split(path.sep).join("/");
    }

    const joined = path.posix.normalize(cwd === "." ? normalized : `${cwd}/${normalized}`);

    // Некоторые инструменты печатают пути от корня, даже когда запущены в пакете.
    if (root && cwd !== "." && !existsSync(path.join(root, joined)) && existsSync(path.join(root, normalized))) {
        return normalized;
    }

    return joined;
}

/**
 * Проверки проекта (typecheck и lint из его же скриптов — как у автопроверки) и разбор ошибок.
 */
export class DiagnosticsService {

    constructor(
        private readonly processes: ProcessManager,
        private readonly root: string,
        private readonly timeoutMs: number,
    ) {}

    public async run(signal: AbortSignal, owner?: string): Promise<DiagnosticsResult> {
        const planned = planChecks(await detectProjects(this.root), ["typecheck", "lint"]);
        const checks: DiagnosticsResult["checks"] = [];
        const diagnostics: Diagnostic[] = [];
        let unparsed = "";

        for (const { cwd, command } of planned) {
            if (signal.aborted) {
                break;
            }

            const result = await this.processes.run(command, {
                cwd: path.join(this.root, cwd),
                ...(owner ? { owner } : {}),
                timeoutMs: this.timeoutMs,
                signal,
            });

            const ok = result.info.status === "exited" && result.info.exitCode === 0;
            checks.push({ cwd, command, ok });

            const found = parseDiagnostics(result.output, cwd, this.root);
            diagnostics.push(...found);

            if (!ok && found.length === 0) {
                unparsed += `$ ${command}${cwd === "." ? "" : ` (in ${cwd})`}\n${result.output.slice(-UNPARSED_TAIL)}\n`;
            }
        }

        return { checks, diagnostics: dedupe(diagnostics).slice(0, MAX_DIAGNOSTICS), unparsed };
    }
}

function dedupe(diagnostics: Diagnostic[]): Diagnostic[] {
    const seen = new Set<string>();

    return diagnostics.filter(item => {
        const key = `${item.path}:${item.line}:${item.column}:${item.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** Текст для модели: ошибки по файлам. */
export function formatDiagnostics(result: DiagnosticsResult): string {
    if (result.checks.length === 0) {
        return "No type-check or lint command was found for this project (no typecheck/lint script, tsconfig.json or similar).";
    }

    const commands = result.checks.map(check => `${check.ok ? "✓" : "✕"} ${check.command}${check.cwd === "." ? "" : ` (in ${check.cwd})`}`).join("\n");

    if (result.diagnostics.length === 0) {
        return result.unparsed
            ? `${commands}\n\nThe check failed, but the errors could not be parsed. Output:\n${result.unparsed}`
            : `${commands}\n\nNo problems found.`;
    }

    const errors = result.diagnostics.filter(item => item.severity === "error").length;
    const lines = result.diagnostics.map(item =>
        `${item.path}:${item.line}:${item.column} ${item.severity}${item.code ? ` ${item.code}` : ""}: ${item.message}`);

    return `${commands}\n\n${errors} error(s), ${result.diagnostics.length - errors} warning(s):\n${lines.join("\n")}`;
}
