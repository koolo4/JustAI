import { randomUUID } from "node:crypto";

import {
    addUsage,
    emptyUsage,
    type AgentEvent,
    type CreateSessionRequest,
    type ExecutorConfig,
    type Message,
    type SendMessageRequest,
    type SessionDetails,
    type SessionStatus,
    type RevertResponse,
    type SessionChangesResponse,
    type PermissionDecision,
    type PermissionMode,
    type SessionSummary,
    type ToolResultBlock,
    type ToolUseBlock,
} from "@justai/shared";

import { BadRequestError } from "../../../core/errors/BadRequestError.js";
import { ConflictError } from "../../../core/errors/ConflictError.js";
import { NotFoundError } from "../../../core/errors/NotFoundError.js";
import type { SnapshotChange, SnapshotService } from "../../../infrastructure/git/SnapshotService.js";
import type { PermissionService } from "../permissions/PermissionService.js";
import type { AgentProfiles } from "../profiles.js";
import { buildSessionPrompt } from "../prompts/sessionPrompt.js";
import type { ProviderRegistry } from "../providers/ProviderRegistry.js";
import { DELEGATE_TOOL, type DelegateInput } from "../tools/delegateTool.js";
import type { SpawnInput } from "../tools/spawnTool.js";
import { latestTodos } from "../tools/todoTool.js";
import { ToolError, type ToolContext } from "../tools/Tool.js";
import { formatExecutorResult, type ExecutorRunner } from "./ExecutorRunner.js";
import type { VerificationOutcome, Verifier } from "./Verifier.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import { AgentLoop, createMessage } from "./AgentLoop.js";
import { expandMentions } from "./Mentions.js";
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
    /** Снапшоты для отката. Без них (нет git) откат недоступен. */
    snapshots?: SnapshotService;
    /** Уведомить UI о файлах, восстановленных откатом. */
    onReverted?: (changes: SnapshotChange[]) => Promise<void>;
    /** Автоматическая проверка проекта после правок. */
    verifier?: Verifier;
    /** Провайдер read-only помощников (spawn_agent); по умолчанию — модель сессии. */
    subagentProvider?: string;
    /** Исполнитель для профилей с delegate_task. */
    executor?: {
        defaultProvider: string;
        runner: ExecutorRunner;
    };
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

        let executor: ExecutorConfig | undefined;

        if (profile.tools.includes(DELEGATE_TOOL)) {
            if (!this.deps.executor) {
                throw new BadRequestError("The planner profile needs an executor, but delegation is not configured.");
            }

            const instance = this.deps.providers.create(
                request.executorProvider ?? this.deps.executor.defaultProvider,
                request.executorModel,
            );

            executor = { provider: instance.id, model: instance.model };
        }

        const prompt = await buildSessionPrompt({
            profile,
            toolNames: tools.map(tool => tool.name),
            workspaceRoot: this.deps.workspaceRoot,
            shouldIgnore: this.deps.shouldIgnore,
        });

        const now = new Date().toISOString();

        const summary: SessionSummary = {
            id: randomUUID(),
            title: "New session",
            profile: profile.id,
            provider: provider.id,
            model: provider.model,
            mode: request.mode ?? "ask",
            verify: request.verify ?? true,
            ...(executor ? { executor } : {}),
            status: "idle",
            createdAt: now,
            updatedAt: now,
            usage: emptyUsage(),
            steps: 0,
        };

        const session: StoredSession = {
            summary,
            system: prompt.system,
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
            todos: latestTodos(session.messages),
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

            const attachments = await expandMentions(text, this.deps.workspaceRoot, this.deps.shouldIgnore);
            await this.addMessage(session, createMessage("user", [{ type: "text", text: prompt }, ...attachments]));

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
     * Меняет режим разрешений и автопроверку. Действует сразу, в том числе на работающий цикл.
     */
    public async update(id: string, changes: { mode?: PermissionMode; verify?: boolean }): Promise<SessionSummary> {
        const session = await this.load(id);

        if (changes.mode) {
            session.summary.mode = changes.mode;
        }

        if (changes.verify !== undefined) {
            session.summary.verify = changes.verify;
        }

        session.summary.updatedAt = new Date().toISOString();
        await this.deps.store.updateSummary(session.summary);

        return session.summary;
    }

    /** @deprecated используйте update(id, { mode }). */
    public setMode(id: string, mode: PermissionMode): Promise<SessionSummary> {
        return this.update(id, { mode });
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

    /**
     * Изменения рабочей папки с момента первой правки агента в этой сессии.
     */
    public async changes(id: string): Promise<SessionChangesResponse> {
        await this.load(id);

        if (!this.deps.snapshots?.available) {
            return { available: false, files: [], diff: "" };
        }

        return { available: true, ...await this.deps.snapshots.changes(id) };
    }

    /**
     * Откатывает рабочую папку (или только `paths`) к состоянию до первой правки агента в сессии.
     */
    public async revert(id: string, paths?: string[]): Promise<RevertResponse> {
        await this.load(id);

        if (!this.deps.snapshots?.available) {
            throw new ConflictError("Revert is unavailable: git was not found on this computer.");
        }

        if (this.running.has(id)) {
            throw new ConflictError("Stop the agent before reverting its changes.");
        }

        const files = await this.deps.snapshots.revert(id, paths);
        await this.deps.onReverted?.(files);

        return { files };
    }

    /**
     * Принять изменения сессии: снапшот забывается, откатить их больше нельзя.
     * Следующая правка агента начнёт новый снапшот.
     */
    public async accept(id: string): Promise<void> {
        await this.load(id);

        if (!this.deps.snapshots?.available) {
            throw new ConflictError("Accept is unavailable: git was not found on this computer.");
        }

        if (this.running.has(id)) {
            throw new ConflictError("Stop the agent before accepting its changes.");
        }

        await this.deps.snapshots.discard(id);
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

    /** Работает ли сейчас хотя бы один агент. */
    public get busy(): boolean {
        return this.running.size > 0;
    }

    /** Остановить все работающие сессии и дождаться их завершения. */
    public async stopAll(): Promise<void> {
        const runs = [...this.running.values()];

        for (const run of runs) {
            run.controller.abort();
        }

        await Promise.allSettled(runs.map(run => run.done));
    }

    /**
     * delegate_task: выполнить задачу планировщика исполнителем в рамках той же сессии.
     */
    public async delegate(input: DelegateInput, context: ToolContext): Promise<string> {
        const session = await this.load(context.sessionId);
        const { summary } = session;

        if (!this.deps.executor) {
            throw new ToolError("Delegation is not configured on this server.");
        }

        const executor = summary.executor ?? (() => {
            const instance = this.deps.providers.create(this.deps.executor!.defaultProvider);
            return { provider: instance.id, model: instance.model };
        })();

        const result = await this.deps.executor.runner.run({
            sessionId: summary.id,
            executor,
            mode: () => summary.mode,
            task: input.task,
            signal: context.signal,
            progress: line => context.emit({
                type: "tool.progress",
                sessionId: summary.id,
                toolUseId: context.toolUseId,
                chunk: `${line}\n`,
            }),
            emit: this.deps.emit,
            ...this.verifyOption(summary, ["run_command"]),
        });

        summary.usage = addUsage(summary.usage, result.usage);

        if (context.signal.aborted) {
            throw new ToolError("Cancelled by user.");
        }

        const text = formatExecutorResult(executor, result);

        if (result.status === "failed") {
            throw new ToolError(text);
        }

        return text;
    }

    /**
     * spawn_agent: read-only помощник (explore / review) на модели сессии
     * или на JUSTAI_SUBAGENT_PROVIDER. Возвращает его ответ.
     */
    public async spawn(input: SpawnInput, context: ToolContext): Promise<string> {
        const session = await this.load(context.sessionId);
        const { summary } = session;

        if (!this.deps.executor) {
            throw new ToolError("Helper agents are not configured on this server.");
        }

        const provider = this.deps.subagentProvider
            ? this.deps.providers.create(this.deps.subagentProvider)
            : this.deps.providers.create(summary.provider, summary.model);
        const helper = { provider: provider.id, model: provider.model };

        const result = await this.deps.executor.runner.run({
            sessionId: summary.id,
            profile: input.kind,
            executor: helper,
            mode: () => summary.mode,
            task: input.task,
            signal: context.signal,
            progress: line => context.emit({
                type: "tool.progress",
                sessionId: summary.id,
                toolUseId: context.toolUseId,
                chunk: `${line}\n`,
            }),
            emit: this.deps.emit,
        });

        summary.usage = addUsage(summary.usage, result.usage);

        if (context.signal.aborted) {
            throw new ToolError("Cancelled by user.");
        }

        if (result.status === "failed" || !result.report) {
            throw new ToolError(`The ${input.kind} helper (${helper.provider}/${helper.model}) did not produce an answer${result.reason ? `: ${result.reason}` : "."}`);
        }

        return `${input.kind === "review" ? "Review" : "Findings"} from ${helper.provider}/${helper.model} (${result.steps} step(s)):\n\n${result.report}`;
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
                ...(this.deps.snapshots?.available
                    ? { beforeMutation: () => this.deps.snapshots!.ensure(summary.id) }
                    : {}),
                ...this.verifyOption(summary, profile.tools),
                onMessage: message => this.addMessage(session, message),
                ...(session.compaction ? { compaction: session.compaction } : {}),
                onCompaction: async compaction => {
                    session.compaction = compaction;
                    await this.deps.store.appendCompaction(summary.id, compaction);
                },
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

    /**
     * Автопроверка для цикла: только для профилей, которые меняют код, и если она не выключена в сессии.
     * Команды проверки проходят те же разрешения, что и run_command.
     */
    private verifyOption(
        summary: SessionSummary,
        profileTools: readonly string[],
    ): { verify?: (signal: AbortSignal) => Promise<VerificationOutcome> } {
        const verifier = this.deps.verifier;
        const runTool = this.deps.tools.get("run_command");
        const changesCode = profileTools.includes("run_command") || profileTools.includes(DELEGATE_TOOL);

        if (!verifier?.enabled || !runTool || !changesCode || summary.verify === false) {
            return {};
        }

        const authorizer = this.deps.permissions.forSession(summary.id, () => summary.mode);

        return {
            verify: async signal => {
                const planned = await verifier.plan();

                this.deps.emit({
                    type: "verification",
                    sessionId: summary.id,
                    status: "running",
                    checks: planned.map(check => ({ ...check, ok: false, exitCode: null })),
                });

                const outcome = await verifier.run({
                    owner: summary.id,
                    signal,
                    authorize: (command, cwd) => authorizer.authorize({
                        sessionId: summary.id,
                        toolUseId: `verify-${randomUUID()}`,
                        tool: runTool,
                        input: { command, cwd },
                        signal,
                    }),
                });

                this.deps.emit({
                    type: "verification",
                    sessionId: summary.id,
                    status: outcome.status,
                    checks: outcome.checks.map(({ output: _output, ...check }) => check),
                });

                return outcome;
            },
        };
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
