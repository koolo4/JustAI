import {
    emptyUsage,
    type AgentEvent,
    type ExecutorConfig,
    type Message,
    type PermissionMode,
    type ToolResultBlock,
    type Usage,
} from "@justai/shared";

import type { SnapshotService } from "../../../infrastructure/git/SnapshotService.js";
import type { PermissionService } from "../permissions/PermissionService.js";
import type { AgentProfiles } from "../profiles.js";
import { buildSessionPrompt } from "../prompts/sessionPrompt.js";
import type { ProviderRegistry } from "../providers/ProviderRegistry.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import { AgentLoop, createMessage, type AgentLoopStatus } from "./AgentLoop.js";
import type { BudgetLimits } from "./Budget.js";
import type { VerificationOutcome } from "./Verifier.js";

export const EXECUTOR_PROFILE = "executor";

export interface ExecutorRunnerDeps {
    providers: ProviderRegistry;
    tools: ToolRegistry;
    profiles: AgentProfiles;
    permissions: PermissionService;
    snapshots?: SnapshotService;
    workspaceRoot: string;
    shouldIgnore: (name: string) => boolean;
    limits: BudgetLimits;
}

export interface ExecutorRunRequest {
    /** Сессия планировщика: разрешения, снапшот и события привязаны к ней. */
    sessionId: string;
    executor: ExecutorConfig;
    mode: () => PermissionMode;
    task: string;
    signal: AbortSignal;
    /** Строка хода работы для карточки delegate_task. */
    progress: (line: string) => void;
    /** События, которые нужно пробросить в UI как есть (изменения файлов). */
    emit: (event: AgentEvent) => void;
    /** Автопроверка после правок исполнителя: он сам исправляет то, что сломал. */
    verify?: (signal: AbortSignal) => Promise<VerificationOutcome>;
}

export interface ExecutorAction {
    tool: string;
    summary: string;
    ok: boolean;
    detail: string;
}

export interface ExecutorRunResult {
    status: AgentLoopStatus;
    reason?: string;
    report: string;
    actions: ExecutorAction[];
    usage: Usage;
    steps: number;
}

/**
 * Запускает исполнителя (обычно локальную модель) на одну задачу планировщика.
 * История исполнителя не сохраняется: планировщику возвращаются отчёт и список реальных действий.
 */
export class ExecutorRunner {

    constructor(
        private readonly deps: ExecutorRunnerDeps,
    ) {}

    public async run(request: ExecutorRunRequest): Promise<ExecutorRunResult> {
        const profile = this.deps.profiles.get(EXECUTOR_PROFILE);
        const tools = this.deps.tools.select(profile.tools);
        const provider = this.deps.providers.create(request.executor.provider, request.executor.model);

        const { system } = await buildSessionPrompt({
            profile,
            toolNames: tools.map(tool => tool.name),
            workspaceRoot: this.deps.workspaceRoot,
            shouldIgnore: this.deps.shouldIgnore,
        });

        const messages: Message[] = [];
        const pending = new Map<string, { tool: string; summary: string }>();
        const calls = new Map<string, { tool: string; summary: string }>();
        const actions: ExecutorAction[] = [];

        request.progress(`Executor ${provider.id} / ${provider.model} started.`);

        const loop = new AgentLoop({
            sessionId: request.sessionId,
            workspaceRoot: this.deps.workspaceRoot,
            provider,
            tools,
            system,
            limits: this.deps.limits,
            signal: request.signal,
            emit: event => {
                switch (event.type) {
                    case "tool.started": {
                        const summary = summarizeInput(event.input);
                        pending.set(event.toolUseId, { tool: event.name, summary });
                        request.progress(`→ ${event.name} ${summary}`);
                        break;
                    }

                    case "tool.finished": {
                        const started = pending.get(event.toolUseId);
                        const firstLine = event.preview.split("\n").find(line => line.trim()) ?? "";
                        request.progress(`${event.isError ? "✕" : "✓"} ${started?.tool ?? "tool"}: ${firstLine.slice(0, 160)}`);
                        break;
                    }

                    case "file.changed":
                    case "todo.updated":
                    case "verification":
                        request.emit(event);
                        break;

                    default:
                        break;
                }
            },
            authorizer: this.deps.permissions.forSession(request.sessionId, request.mode),
            ...(this.deps.snapshots?.available
                ? { beforeMutation: () => this.deps.snapshots!.ensure(request.sessionId) }
                : {}),
            ...(request.verify
                ? {
                    verify: async (signal: AbortSignal) => {
                        request.progress("Running project checks…");
                        const outcome = await request.verify!(signal);
                        request.progress(`Checks ${outcome.status}: ${outcome.checks.map(check => `${check.ok ? "✓" : "✕"} ${check.command}`).join(", ") || "none"}`);
                        return outcome;
                    },
                    maxVerifyAttempts: 2,
                }
                : {}),
            onMessage: async message => {
                messages.push(message);

                // Действия берём из вызовов и результатов инструментов — это факты, а не пересказ модели.
                // (tool.started приходит не всегда: например, при отказе в разрешении.)
                for (const block of message.content) {
                    if (block.type === "tool_use") {
                        calls.set(block.id, { tool: block.name, summary: summarizeInput(block.input) });
                    }
                    else if (block.type === "tool_result") {
                        actions.push(toAction(block, calls.get(block.toolUseId)));
                    }
                }
            },
        });

        const result = await loop.run([createMessage("user", [{ type: "text", text: request.task }])]);
        const report = lastAssistantText(messages);

        request.progress(`Executor ${result.status} after ${result.steps} step(s).`);

        return {
            status: result.status,
            ...(result.reason ? { reason: result.reason } : {}),
            report,
            actions,
            usage: result.usage ?? emptyUsage(),
            steps: result.steps,
        };
    }
}

/**
 * Текст результата delegate_task для планировщика.
 */
export function formatExecutorResult(executor: ExecutorConfig, result: ExecutorRunResult): string {
    const lines = [
        `Executor ${executor.provider}/${executor.model}: ${result.status} after ${result.steps} step(s).${result.reason ? ` Reason: ${result.reason}` : ""}`,
        "",
        "Actions actually performed (from tool results):",
        ...(result.actions.length > 0
            ? result.actions.map(action => `- ${action.ok ? "OK" : "ERROR"} ${action.tool} ${action.summary}${action.detail ? ` — ${action.detail}` : ""}`)
            : ["- none"]),
        "",
        "Executor's report:",
        result.report || "(no report)",
        "",
        "Verify the result yourself (read_file / git_diff) before continuing.",
    ];

    return lines.join("\n");
}

function toAction(block: ToolResultBlock, started: { tool: string; summary: string } | undefined): ExecutorAction {
    const text = typeof block.content === "string"
        ? block.content
        : block.content.map(part => part.type === "text" ? part.text : "[image]").join("\n");

    const firstLine = text.split("\n").find(line => line.trim()) ?? "";

    return {
        tool: started?.tool ?? "tool",
        summary: started?.summary ?? "",
        ok: !block.isError,
        detail: firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine,
    };
}

function summarizeInput(input: unknown): string {
    if (input && typeof input === "object") {
        if ("command" in input && typeof input.command === "string") {
            return input.command;
        }

        if ("path" in input && typeof input.path === "string") {
            return input.path;
        }

        if ("pattern" in input && typeof input.pattern === "string") {
            return input.pattern;
        }
    }

    return "";
}

function lastAssistantText(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i]!;

        if (message.role !== "assistant") {
            continue;
        }

        const text = message.content
            .map(block => block.type === "text" ? block.text : "")
            .join("\n")
            .trim();

        if (text) {
            return text;
        }
    }

    return "";
}
