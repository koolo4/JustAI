import { randomUUID } from "node:crypto";

import {
    addUsage,
    emptyUsage,
    type AgentEvent,
    type CreateSessionRequest,
    type Message,
    type SendMessageRequest,
    type SessionDetails,
    type SessionStatus,
    type PermissionDecision,
    type PermissionMode,
    type SessionSummary,
    type ToolResultBlock,
    type ToolUseBlock,
} from "@justai/shared";

import { BadRequestError } from "../../../core/errors/BadRequestError.js";
import { ConflictError } from "../../../core/errors/ConflictError.js";
import { NotFoundError } from "../../../core/errors/NotFoundError.js";
import type { PermissionService } from "../permissions/PermissionService.js";
import type { AgentProfiles } from "../profiles.js";
import { projectTree, readProjectRules } from "../prompts/ProjectContext.js";
import { buildSystemPrompt } from "../prompts/SystemPrompt.js";
import type { ProviderRegistry } from "../providers/ProviderRegistry.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import { AgentLoop, createMessage } from "./AgentLoop.js";
import type { BudgetLimits } from "./Budget.js";
import type { SessionStore, StoredSession } from "./SessionStore.js";

export interface SessionManagerDeps {
    store: SessionStore;
    providers: ProviderRegistry;
    tools: ToolRegistry;
    profiles: AgentProfiles;
    workspaceRoot: string;
    shouldIgnore: (name: string) => boolean;
    limits: BudgetLimits;
    permissions: PermissionService;
    emit: (event: AgentEvent) => void;
}

const TITLE_LENGTH = 60;

/**
 * Жизненный цикл сессий: создание, сообщения пользователя, запуск и остановка цикла агента.
 */
export class SessionManager {

    private readonly cache = new Map<string, StoredSession>();

    private readonly running = new Map<string, { controller: AbortController; done: Promise<void> }>();

    constructor(
        private readonly deps: SessionManagerDeps,
    ) {}

    public async create(request: CreateSessionRequest): Promise<SessionSummary> {
        const profile = this.deps.profiles.get(request.profile ?? this.deps.profiles.defaultProfile);
        const providerId = request.provider ?? this.deps.providers.defaultProvider;
        // Проверяет id провайдера и определяет модель по умолчанию.
        const provider = this.deps.providers.create(providerId, request.model);
        const tools = this.deps.tools.select(profile.tools);

        const [rules, tree] = await Promise.all([
            readProjectRules(this.deps.workspaceRoot),
            projectTree(this.deps.workspaceRoot, this.deps.shouldIgnore),
        ]);

        const now = new Date().toISOString();

        const summary: SessionSummary = {
            id: randomUUID(),
            title: "New session",
            profile: profile.id,
            provider: provider.id,
            model: provider.model,
            mode: request.mode ?? "ask",
            status: "idle",
            createdAt: now,
            updatedAt: now,
            usage: emptyUsage(),
            steps: 0,
        };

        const session: StoredSession = {
            summary,
            system: buildSystemPrompt({
                profile,
                toolNames: tools.map(tool => tool.name),
                workspaceRoot: this.deps.workspaceRoot,
                projectRules: rules,
                tree,
                date: now.slice(0, 10),
            }),
            messages: [],
        };

        await this.deps.store.create(session);
        this.cache.set(summary.id, session);

        return summary;
    }

    public async list(): Promise<SessionSummary[]> {
        const stored = await this.deps.store.list();

        return stored.map(summary => this.cache.get(summary.id)?.summary ?? this.reconcile(summary));
    }

    public async get(id: string): Promise<SessionDetails> {
        const session = await this.load(id);

        return {
            session: session.summary,
            messages: session.messages.map(publicMessage),
            pendingPermissions: this.deps.permissions.pendingFor(id),
        };
    }

    /**
     * Добавляет сообщение пользователя и запускает цикл агента в фоне.
     */
    public async send(id: string, request: SendMessageRequest): Promise<SessionSummary> {
        const text = request.text?.trim();

        if (!text) {
            throw new BadRequestError("Message text is required.");
        }

        const session = await this.load(id);

        if (this.running.has(id)) {
            throw new ConflictError("The agent is already working in this session. Stop it or wait for it to finish.");
        }

        // Слот занимается синхронно, до первого await: второй параллельный запрос получит 409.
        const run = { controller: new AbortController(), done: Promise.resolve() };
        this.running.set(id, run);

        try {
            const repair = repairHistory(session.messages);

            if (repair) {
                await this.addMessage(session, repair);
            }

            const prompt = request.activeFile
                ? `${text}\n\n(The user has ${request.activeFile} open in the editor.)`
                : text;

            await this.addMessage(session, createMessage("user", [{ type: "text", text: prompt }]));

            if (session.summary.title === "New session") {
                session.summary.title = text.length > TITLE_LENGTH ? `${text.slice(0, TITLE_LENGTH)}…` : text;
            }

            await this.setStatus(session, "running");
        }
        catch (error) {
            this.running.delete(id);
            throw error;
        }

        run.done = this.runLoop(session, run.controller).finally(() => {
            this.running.delete(id);
        });

        return session.summary;
    }

    /**
     * Меняет режим разрешений. Действует сразу, в том числе на работающий цикл.
     */
    public async setMode(id: string, mode: PermissionMode): Promise<SessionSummary> {
        const session = await this.load(id);

        session.summary.mode = mode;
        session.summary.updatedAt = new Date().toISOString();
        await this.deps.store.updateSummary(session.summary);

        return session.summary;
    }

    public async resolvePermission(
        id: string,
        requestId: string,
        decision: PermissionDecision,
        note?: string,
    ): Promise<void> {
        await this.load(id);

        if (!this.deps.permissions.resolve(id, requestId, decision, note)) {
            throw new NotFoundError("This permission request is no longer pending.");
        }
    }

    public async stop(id: string): Promise<SessionSummary> {
        const session = await this.load(id);
        const run = this.running.get(id);

        if (run) {
            run.controller.abort();
            await run.done;
        }

        return session.summary;
    }

    /** Дождаться завершения цикла (для тестов). */
    public async waitForIdle(id: string): Promise<void> {
        await this.running.get(id)?.done;
    }

    private async runLoop(session: StoredSession, controller: AbortController): Promise<void> {
        const { summary } = session;

        try {
            const profile = this.deps.profiles.get(summary.profile);

            const loop = new AgentLoop({
                sessionId: summary.id,
                workspaceRoot: this.deps.workspaceRoot,
                provider: this.deps.providers.create(summary.provider, summary.model),
                tools: this.deps.tools.select(profile.tools),
                system: session.system,
                limits: this.deps.limits,
                signal: controller.signal,
                emit: this.deps.emit,
                authorizer: this.deps.permissions.forSession(summary.id, () => summary.mode),
                onMessage: message => this.addMessage(session, message),
            });

            const result = await loop.run(session.messages);

            summary.usage = addUsage(summary.usage, result.usage);
            summary.steps += result.steps;

            await this.setStatus(session, result.status, result.reason);
        }
        catch (error) {
            await this.setStatus(session, "failed", error instanceof Error ? error.message : String(error));
        }
    }

    private async addMessage(session: StoredSession, message: Message): Promise<void> {
        session.messages.push(message);
        await this.deps.store.appendMessage(session.summary.id, message);

        this.deps.emit({
            type: "message.added",
            sessionId: session.summary.id,
            message: publicMessage(message),
        });
    }

    private async setStatus(session: StoredSession, status: SessionStatus, reason?: string): Promise<void> {
        const { summary } = session;

        summary.status = status;
        summary.updatedAt = new Date().toISOString();

        if (reason) {
            summary.lastError = reason;
        }
        else {
            delete summary.lastError;
        }

        await this.deps.store.updateSummary(summary);

        this.deps.emit({
            type: "session.status",
            sessionId: summary.id,
            status,
            ...(reason ? { error: reason } : {}),
        });
    }

    private async load(id: string): Promise<StoredSession> {
        const cached = this.cache.get(id);

        if (cached) {
            return cached;
        }

        const stored = await this.deps.store.load(id);

        if (!stored) {
            throw new NotFoundError(`Session ${id} not found.`);
        }

        stored.summary = this.reconcile(stored.summary);
        this.cache.set(id, stored);

        return stored;
    }

    /**
     * Сессия, записанная как running, но без живого цикла, — сервер перезапускали посреди работы.
     */
    private reconcile(stored: SessionSummary): SessionSummary {
        // Сессии, созданные до появления режимов разрешений.
        const summary: SessionSummary = { ...stored, mode: stored.mode ?? "ask" };

        if (summary.status === "running" && !this.running.has(summary.id)) {
            return { ...summary, status: "stopped", lastError: "Interrupted: the server was restarted." };
        }

        return summary;
    }
}

/**
 * Если история обрывается на tool_use без результатов (падение процесса),
 * дописывает результаты-ошибки: иначе API отклонит следующий запрос.
 */
export function repairHistory(messages: Message[]): Message | null {
    const last = messages.at(-1);

    if (!last || last.role !== "assistant") {
        return null;
    }

    const pending = last.content.filter(
        (block): block is ToolUseBlock => block.type === "tool_use",
    );

    if (pending.length === 0) {
        return null;
    }

    return createMessage("user", pending.map((use): ToolResultBlock => ({
        type: "tool_result",
        toolUseId: use.id,
        content: "Not executed: the session was interrupted.",
        isError: true,
    })));
}

/** Без providerRaw: он нужен только провайдеру и может быть большим. */
function publicMessage(message: Message): Message {
    if (!message.meta?.providerRaw) {
        return message;
    }

    const { providerRaw: _raw, ...meta } = message.meta;
    return { ...message, meta };
}
