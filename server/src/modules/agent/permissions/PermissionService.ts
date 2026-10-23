import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
    AgentEvent,
    PermissionDecision,
    PermissionMode,
    PermissionRequest,
} from "@justai/shared";

import type { Tool } from "../tools/Tool.js";
import { classifyCommand, splitSegments, tokenize, type CommandRules } from "./CommandClassifier.js";

/** Сколько ждать ответа пользователя. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Инструменты kind=execute без собственных побочных эффектов:
 * kill_process трогает только процессы агента, delegate_task — действия исполнителя проверяются по отдельности.
 */
const HARMLESS_EXECUTE = new Set(["kill_process", "delegate_task"]);

export interface AuthorizeRequest {
    sessionId: string;
    toolUseId: string;
    tool: Tool;
    input: unknown;
    signal: AbortSignal;
}

export type AuthorizeResult =
    | { allowed: true }
    | { allowed: false; message: string };

export interface Authorizer {
    authorize(request: AuthorizeRequest): Promise<AuthorizeResult>;
}

interface Assessment {
    action: "allow" | "ask";
    reason: string;
    dangerous: boolean;
    /** Ключ для «разрешить всегда» в этой сессии. */
    sessionKey?: string;
    /** Префикс команды для project-правила allow. */
    commandPrefix?: string;
}

interface Pending {
    request: PermissionRequest;
    settle: (decision: PermissionDecision, note?: string) => void;
}

export interface PermissionServiceOptions {
    /** .justai/permissions.json — правила проекта { allow: [], deny: [] }. */
    rulesFile: string;
    emit: (event: AgentEvent) => void;
    timeoutMs?: number;
}

/**
 * Решает, можно ли выполнить вызов инструмента, и при необходимости спрашивает пользователя
 * (событие permission.request → POST /permissions/:requestId).
 */
export class PermissionService {

    private readonly pending = new Map<string, Pending>();

    /** sessionId → ключи, разрешённые «всегда» в этой сессии. */
    private readonly sessionAllow = new Map<string, Set<string>>();

    constructor(
        private readonly options: PermissionServiceOptions,
    ) {}

    /**
     * Авторизатор для сессии. Режим читается при каждом решении — его можно менять на ходу.
     */
    public forSession(sessionId: string, mode: () => PermissionMode): Authorizer {
        return {
            authorize: request => this.authorize(request, mode(), sessionId),
        };
    }

    public pendingFor(sessionId: string): PermissionRequest[] {
        return [...this.pending.values()]
            .map(item => item.request)
            .filter(request => request.sessionId === sessionId);
    }

    /**
     * Ответ пользователя. false — запрос не найден (уже решён или истёк).
     */
    public resolve(sessionId: string, requestId: string, decision: PermissionDecision, note?: string): boolean {
        const item = this.pending.get(requestId);

        if (!item || item.request.sessionId !== sessionId) {
            return false;
        }

        item.settle(decision, note);
        return true;
    }

    public async readRules(): Promise<CommandRules> {
        try {
            const parsed = JSON.parse(await fs.readFile(this.options.rulesFile, "utf8")) as Partial<CommandRules>;

            return {
                allow: Array.isArray(parsed.allow) ? parsed.allow.filter(isString) : [],
                deny: Array.isArray(parsed.deny) ? parsed.deny.filter(isString) : [],
            };
        }
        catch {
            return { allow: [], deny: [] };
        }
    }

    private async authorize(request: AuthorizeRequest, mode: PermissionMode, sessionId: string): Promise<AuthorizeResult> {
        const assessment = await this.assess(request, mode, sessionId);

        if (assessment.action === "allow") {
            return { allowed: true };
        }

        const permission: PermissionRequest = {
            requestId: randomUUID(),
            sessionId,
            toolUseId: request.toolUseId,
            tool: request.tool.name,
            input: request.input,
            summary: summarize(request.tool.name, request.input),
            reason: assessment.reason,
            dangerous: assessment.dangerous,
            createdAt: new Date().toISOString(),
        };

        const { decision, note } = await this.ask(permission, request.signal);

        if (decision === "deny") {
            return {
                allowed: false,
                message: request.signal.aborted
                    ? "Cancelled by user."
                    : `The user denied this action${note ? `: ${note.trim().replace(/[.!?]?$/, ".")}` : "."} Do not retry it as is; adjust your approach or ask the user.`,
            };
        }

        if (decision === "allow_always" && !assessment.dangerous) {
            await this.rememberAlways(sessionId, assessment);
        }

        return { allowed: true };
    }

    private async assess(request: AuthorizeRequest, mode: PermissionMode, sessionId: string): Promise<Assessment> {
        const { tool, input } = request;
        const allowed = this.sessionAllow.get(sessionId) ?? new Set<string>();

        if (tool.requiresApproval) {
            const key = `tool:${tool.name}`;

            return allowed.has(key)
                ? { action: "allow", reason: "allowed for this session", dangerous: false }
                : { action: "ask", reason: "always requires your approval", dangerous: false, sessionKey: key };
        }

        switch (tool.kind) {
            case "read":
                return { action: "allow", reason: "read-only", dangerous: false };

            case "write": {
                if (mode !== "ask" || allowed.has("kind:write")) {
                    return { action: "allow", reason: "file changes are allowed in this mode", dangerous: false };
                }

                return { action: "ask", reason: "changes files in the workspace", dangerous: false, sessionKey: "kind:write" };
            }

            case "network": {
                const key = `tool:${tool.name}`;

                return allowed.has(key)
                    ? { action: "allow", reason: "allowed for this session", dangerous: false }
                    : { action: "ask", reason: "uses an external service", dangerous: false, sessionKey: key };
            }

            case "execute": {
                if (HARMLESS_EXECUTE.has(tool.name)) {
                    return { action: "allow", reason: "manages the agent's own processes", dangerous: false };
                }

                const command = commandOf(input);

                // Инструмент без явной команды (например, diagnostics запускает проверки проекта):
                // в full-auto разрешён, иначе — вопрос, ответ «на сессию» запоминается.
                if (command === null) {
                    const key = `tool:${tool.name}`;

                    return mode === "full-auto" || allowed.has(key)
                        ? { action: "allow", reason: mode === "full-auto" ? "allowed in full-auto mode" : "allowed for this session", dangerous: false }
                        : { action: "ask", reason: "runs a program", dangerous: false, sessionKey: key };
                }

                const rules = await this.readRules();
                const classification = classifyCommand(command, rules);
                const prefix = commandPrefix(command);
                const sessionKey = prefix ? `cmd:${prefix.toLowerCase()}` : undefined;

                if (classification.level === "dangerous") {
                    return { action: "ask", reason: `Potentially destructive: ${classification.reason}`, dangerous: true };
                }

                if (sessionKey && allowed.has(sessionKey)) {
                    return { action: "allow", reason: "allowed for this session", dangerous: false };
                }

                const autoAllowed =
                    classification.allowedByRule === true ||
                    (mode === "auto-edit" && classification.level === "safe") ||
                    mode === "full-auto";

                return autoAllowed
                    ? { action: "allow", reason: classification.reason, dangerous: false }
                    : {
                        action: "ask",
                        reason: classification.reason,
                        dangerous: false,
                        ...(sessionKey ? { sessionKey } : {}),
                        ...(prefix ? { commandPrefix: prefix } : {}),
                    };
            }
        }
    }

    private ask(request: PermissionRequest, signal: AbortSignal): Promise<{ decision: PermissionDecision; note?: string }> {
        return new Promise(resolve => {
            let settled = false;

            const finish = (decision: PermissionDecision, note?: string) => {
                if (settled) {
                    return;
                }

                settled = true;
                clearTimeout(timer);
                signal.removeEventListener("abort", onAbort);
                this.pending.delete(request.requestId);

                this.options.emit({
                    type: "permission.resolved",
                    sessionId: request.sessionId,
                    requestId: request.requestId,
                    decision,
                });

                resolve(note === undefined ? { decision } : { decision, note });
            };

            const onAbort = () => finish("deny");

            const timer = setTimeout(
                () => finish("deny", "no answer from the user in time"),
                this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            );

            this.pending.set(request.requestId, { request, settle: finish });
            signal.addEventListener("abort", onAbort, { once: true });

            this.options.emit({ type: "permission.request", sessionId: request.sessionId, request });

            if (signal.aborted) {
                onAbort();
            }
        });
    }

    private async rememberAlways(sessionId: string, assessment: Assessment): Promise<void> {
        if (assessment.sessionKey) {
            let allowed = this.sessionAllow.get(sessionId);

            if (!allowed) {
                allowed = new Set();
                this.sessionAllow.set(sessionId, allowed);
            }

            allowed.add(assessment.sessionKey);
        }

        // Префикс команды запоминается и для проекта: следующие сессии его не спросят.
        if (assessment.commandPrefix) {
            const rules = await this.readRules();

            if (!rules.allow.some(rule => rule.toLowerCase() === assessment.commandPrefix!.toLowerCase())) {
                rules.allow.push(assessment.commandPrefix);
                await fs.mkdir(path.dirname(this.options.rulesFile), { recursive: true });
                await fs.writeFile(this.options.rulesFile, `${JSON.stringify(rules, null, 2)}\n`, "utf8");
            }
        }
    }
}

function commandOf(input: unknown): string | null {
    if (input && typeof input === "object" && "command" in input && typeof input.command === "string") {
        return input.command;
    }

    return null;
}

/**
 * Префикс для «разрешить всегда»: программа + подкоманда (npm run X, npx tool, node script.js).
 * Только для одиночной команды — цепочки разрешаются разово.
 */
export function commandPrefix(command: string): string | null {
    const segments = splitSegments(command);

    if (segments.length !== 1) {
        return null;
    }

    const tokens = tokenize(segments[0]!);
    const program = tokens[0]?.toLowerCase();

    if (!program) {
        return null;
    }

    const take = ["npm", "pnpm", "yarn"].includes(program) && tokens[1] === "run"
        ? 3
        : 2;

    return tokens.slice(0, take).join(" ");
}

function summarize(tool: string, input: unknown): string {
    if (input && typeof input === "object") {
        if ("command" in input && typeof input.command === "string") {
            return input.command;
        }

        if ("path" in input && typeof input.path === "string") {
            return `${tool} ${input.path}`;
        }
    }

    const text = JSON.stringify(input) ?? "";
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function isString(value: unknown): value is string {
    return typeof value === "string" && value.trim() !== "";
}
