import path from "node:path";

import type { VerificationCheck } from "@justai/shared";

import type { ProcessManager } from "../../../infrastructure/process/ProcessManager.js";
import type { AuthorizeResult } from "../permissions/PermissionService.js";
import { detectProjects, type CommandKind, type DetectedProject } from "../project/ProjectDetector.js";

/** Хвост вывода упавшей проверки, который увидит модель. */
const OUTPUT_TAIL_CHARS = 6_000;

export interface VerificationOutcome {
    status: "passed" | "failed" | "skipped";
    checks: Array<VerificationCheck & { output: string }>;
}

export interface VerifyRequest {
    /** Разрешение на запуск команды (как run_command). */
    authorize: (command: string, cwd: string) => Promise<AuthorizeResult>;
    signal: AbortSignal;
    owner: string;
}

export interface VerifierOptions {
    processes: ProcessManager;
    workspaceRoot: string;
    /** Какие команды проекта запускать и в каком порядке. */
    kinds: CommandKind[];
    timeoutMs: number;
}

/**
 * Запускает проверки проекта (typecheck, тесты, …), найденные ProjectDetector.
 * Если команда есть у корневого проекта — проверяется только корень, иначе — подпроекты.
 */
export class Verifier {

    constructor(
        private readonly options: VerifierOptions,
    ) {}

    public get enabled(): boolean {
        return this.options.kinds.length > 0;
    }

    public async plan(): Promise<Array<{ cwd: string; command: string }>> {
        return planChecks(await detectProjects(this.options.workspaceRoot), this.options.kinds);
    }

    public async run(request: VerifyRequest): Promise<VerificationOutcome> {
        const planned = await this.plan();

        if (planned.length === 0) {
            return { status: "skipped", checks: [] };
        }

        const checks: VerificationOutcome["checks"] = [];

        for (const { cwd, command } of planned) {
            if (request.signal.aborted) {
                break;
            }

            const permission = await request.authorize(command, cwd);

            if (!permission.allowed) {
                checks.push({ cwd, command, ok: false, exitCode: null, skipped: "not allowed", output: "" });
                continue;
            }

            const result = await this.options.processes.run(command, {
                cwd: path.join(this.options.workspaceRoot, cwd),
                owner: request.owner,
                timeoutMs: this.options.timeoutMs,
                signal: request.signal,
            });

            const ok = result.info.status === "exited" && result.info.exitCode === 0;

            checks.push({
                cwd,
                command,
                ok,
                exitCode: result.info.exitCode,
                ...(result.info.status === "timed_out" ? { skipped: `timed out after ${this.options.timeoutMs / 1000}s` } : {}),
                output: result.output,
            });
        }

        const ran = checks.filter(check => !check.skipped || check.skipped.startsWith("timed out"));

        return {
            status: ran.length === 0 ? "skipped" : ran.every(check => check.ok) ? "passed" : "failed",
            checks,
        };
    }
}

export function planChecks(projects: DetectedProject[], kinds: CommandKind[]): Array<{ cwd: string; command: string }> {
    const root = projects.find(project => project.root === ".");
    const planned: Array<{ cwd: string; command: string }> = [];

    for (const kind of kinds) {
        const rootCommand = root?.commands[kind];

        if (rootCommand) {
            planned.push({ cwd: ".", command: rootCommand });
            continue;
        }

        for (const project of projects) {
            const command = project.commands[kind];

            if (command && project.root !== ".") {
                planned.push({ cwd: project.root, command });
            }
        }
    }

    return planned;
}

/**
 * Сообщение модели о проваленных проверках.
 */
export function formatVerificationFailure(outcome: VerificationOutcome, attempt: number, maxAttempts: number): string {
    const failed = outcome.checks.filter(check => !check.ok && !check.skipped?.startsWith("not allowed"));

    const sections = failed.map(check => {
        const output = check.output.trimEnd();
        const tail = output.length > OUTPUT_TAIL_CHARS
            ? `…\n${output.slice(-OUTPUT_TAIL_CHARS)}`
            : output;

        return [
            `\`${check.command}\` in ${check.cwd} ${check.skipped ? `(${check.skipped})` : `(exit code ${check.exitCode})`}:`,
            "```",
            tail || "(no output)",
            "```",
        ].join("\n");
    });

    return [
        `[JustAI automatic check, attempt ${attempt} of ${maxAttempts}] After your changes these project checks failed:`,
        "",
        ...sections,
        "",
        "Fix the problems, then finish again. If a failure is unrelated to your task (it was failing before your changes), say so explicitly and do not change unrelated code.",
    ].join("\n");
}

export function verifyKindsFromEnv(value: string | undefined): CommandKind[] {
    if (value === "off" || value === "") {
        return [];
    }

    const allowed: CommandKind[] = ["build", "typecheck", "lint", "test"];
    const kinds = (value ?? "typecheck,test")
        .split(",")
        .map(item => item.trim())
        .filter((item): item is CommandKind => (allowed as string[]).includes(item));

    return kinds;
}
