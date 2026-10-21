import { randomUUID } from "node:crypto";

import { z } from "zod";

import type {
    AgentEvent,
    ContentBlock,
    Message,
    MessageMeta,
    ToolOutput,
    ToolResultBlock,
    ToolUseBlock,
    Usage,
} from "@justai/shared";

import {
    ModelOutputError,
    type ModelProvider,
    type ModelTurn,
} from "../providers/ModelProvider.js";
import type { Authorizer } from "../permissions/PermissionService.js";
import { ToolError, type Tool } from "../tools/Tool.js";
import { toToolSpec } from "../tools/ToolRegistry.js";
import { DELEGATE_TOOL } from "../tools/delegateTool.js";
import { Budget, type BudgetLimits } from "./Budget.js";
import { fitToContextWindow } from "./ContextWindow.js";
import { formatVerificationFailure, type VerificationOutcome } from "./Verifier.js";

const DEFAULT_VERIFY_ATTEMPTS = 3;

/** Лимит текста результата инструмента, который увидит модель. */
export const MAX_TOOL_OUTPUT_CHARS = 30_000;

/** Сколько раз подряд повторять ответ, который не удалось разобрать. */
const MAX_OUTPUT_RETRIES = 2;

/** Сколько раз просить продолжить текст, обрезанный по max_tokens. */
const MAX_CONTINUATIONS = 2;

/** Сколько раз сообщать модели, что её вызов инструмента не разобран. */
const MAX_FORMAT_RETRIES = 3;

export interface AgentLoopOptions {
    sessionId: string;
    workspaceRoot: string;
    provider: ModelProvider;
    tools: Tool[];
    system: string;
    limits: BudgetLimits;
    signal: AbortSignal;
    emit(event: AgentEvent): void;
    /** Проверка разрешений перед вызовом инструмента. Без него всё разрешено (тесты). */
    authorizer?: Authorizer;
    /** Вызывается перед каждым изменяющим инструментом (снапшот для отката). */
    beforeMutation?: () => Promise<void>;
    /** Автоматическая проверка проекта перед завершением, если были правки. */
    verify?: (signal: AbortSignal) => Promise<VerificationOutcome>;
    maxVerifyAttempts?: number;
    /** Сохранить новое сообщение (вызывается для каждого сообщения по порядку). */
    onMessage(message: Message): Promise<void>;
}

export type AgentLoopStatus = "completed" | "stopped" | "failed";

export interface AgentLoopResult {
    status: AgentLoopStatus;
    /** Причина остановки или ошибки. */
    reason?: string;
    steps: number;
    usage: Usage;
}

/**
 * Цикл агента: модель → инструменты → модель … (MASTER_PLAN, раздел 4.3).
 * История передаётся в провайдер целиком и только дополняется (append-only).
 */
export class AgentLoop {

    private readonly budget: Budget;

    private readonly toolsByName: Map<string, Tool>;

    /** Файлы менялись после последней проверки. */
    private changedSinceVerify = false;

    private lastVerifyFailed = false;

    /** В этом прогоне была хотя бы одна успешная правка файлов. */
    private wroteThisRun = false;

    private verifyAttempts = 0;

    constructor(
        private readonly options: AgentLoopOptions,
    ) {
        this.budget = new Budget(options.limits);
        this.toolsByName = new Map(options.tools.map(tool => [tool.name, tool]));
    }

    public async run(history: Message[]): Promise<AgentLoopResult> {
        const messages = [...history];
        let outputRetries = 0;
        let continuations = 0;
        let formatRetries = 0;

        const add = async (message: Message) => {
            messages.push(message);
            await this.options.onMessage(message);
        };

        for (;;) {
            if (this.options.signal.aborted) {
                return this.result("stopped", "Stopped by user.");
            }

            const exceeded = this.budget.exceededReason();

            if (exceeded) {
                return this.result("stopped", `Budget exhausted: ${exceeded}.`);
            }

            let turn: ModelTurn;

            try {
                turn = await this.callModel(messages);
            }
            catch (error) {
                if (this.options.signal.aborted) {
                    return this.result("stopped", "Stopped by user.");
                }

                if (error instanceof ModelOutputError && outputRetries < MAX_OUTPUT_RETRIES) {
                    outputRetries += 1;
                    continue;
                }

                return this.result("failed", errorMessage(error));
            }

            outputRetries = 0;
            this.budget.record(turn.usage);

            this.options.emit({
                type: "budget.updated",
                sessionId: this.options.sessionId,
                usage: this.budget.usage,
                steps: this.budget.steps,
            });

            await add(createMessage("assistant", turn.content, {
                provider: this.options.provider.id,
                model: turn.model,
                usage: turn.usage,
                stopReason: turn.stopReason,
                providerRaw: turn.providerRaw,
            }));

            // Отказ может оборвать tool_use на середине — такие вызовы не выполняются.
            if (turn.stopReason === "refusal") {
                return this.result("failed", "The model declined the request (refusal).");
            }

            const toolUses = turn.content.filter(
                (block): block is ToolUseBlock => block.type === "tool_use",
            );

            if (toolUses.length === 0) {
                if (turn.formatError && formatRetries < MAX_FORMAT_RETRIES) {
                    formatRetries += 1;
                    await add(createMessage("user", [{ type: "text", text: `[JustAI] ${turn.formatError}` }]));
                    continue;
                }

                if (
                    this.options.provider.smallModelGuards &&
                    formatRetries < MAX_FORMAT_RETRIES &&
                    !this.wroteThisRun &&
                    this.options.tools.some(tool => tool.kind === "write" && tool.changesFiles !== false) &&
                    claimsFileChanges(turn.content)
                ) {
                    formatRetries += 1;
                    await add(createMessage("user", [{
                        type: "text",
                        text: "[JustAI] Your answer says files were changed, but no file was changed in this run (no edit_file or write_file call succeeded). Make the change now by calling the tool, or correct your answer if nothing needed to change.",
                    }]));
                    continue;
                }

                if (turn.stopReason === "pause_turn") {
                    continue;
                }

                if (turn.stopReason === "max_tokens" && continuations < MAX_CONTINUATIONS) {
                    continuations += 1;
                    await add(createMessage("user", [{
                        type: "text",
                        text: "Your previous reply was cut off by the output limit. Continue exactly where you stopped.",
                    }]));
                    continue;
                }

                const verdict = await this.verifyBeforeFinishing(add);

                if (verdict.continue) {
                    continue;
                }

                if (this.options.signal.aborted) {
                    return this.result("stopped", "Stopped by user.");
                }

                return this.result("completed", verdict.reason);
            }

            // Вход инструмента, обрезанный по max_tokens, часто выглядит валидным — не выполняем.
            const results = turn.stopReason === "max_tokens"
                ? toolUses.map(use => errorResult(
                    use.id,
                    "The tool input was cut off by the output token limit and was not executed. Split the work into smaller steps.",
                ))
                : await this.executeTools(toolUses);

            await add(createMessage("user", results));
        }
    }

    /**
     * Перед завершением: если были правки — автоматическая проверка проекта.
     * Провал → сообщение модели и ещё один круг (не больше maxVerifyAttempts).
     */
    private async verifyBeforeFinishing(
        add: (message: Message) => Promise<void>,
    ): Promise<{ continue: boolean; reason?: string }> {
        const { verify } = this.options;
        const maxAttempts = this.options.maxVerifyAttempts ?? DEFAULT_VERIFY_ATTEMPTS;

        if (!verify) {
            return { continue: false };
        }

        if (!this.changedSinceVerify) {
            return this.lastVerifyFailed
                ? { continue: false, reason: "Automatic checks are failing (see the last check above)." }
                : { continue: false };
        }

        if (this.verifyAttempts >= maxAttempts) {
            return { continue: false, reason: `Automatic checks still fail after ${maxAttempts} attempts.` };
        }

        this.verifyAttempts += 1;
        this.changedSinceVerify = false;

        const outcome = await verify(this.options.signal);

        if (outcome.status !== "failed") {
            this.lastVerifyFailed = false;
            return { continue: false };
        }

        this.lastVerifyFailed = true;

        if (this.options.signal.aborted) {
            return { continue: false };
        }

        await add(createMessage("user", [{
            type: "text",
            text: formatVerificationFailure(outcome, this.verifyAttempts, maxAttempts),
        }]));

        return { continue: true };
    }

    private async callModel(messages: Message[]): Promise<ModelTurn> {
        const tools = this.options.tools.map(toToolSpec);
        const window = this.options.provider.contextWindow;

        // Для моделей с маленьким окном отправляется ужатая копия истории; сохранённая не меняется.
        const view = window
            ? fitToContextWindow(messages, {
                window: window.tokens,
                reserveForOutput: window.reserveForOutput,
                system: this.options.system,
                tools,
            }).messages
            : messages;

        const stream = this.options.provider.stream({
            system: this.options.system,
            messages: view,
            tools,
            signal: this.options.signal,
        });

        for await (const event of stream) {
            switch (event.type) {
                case "text_delta":
                    this.options.emit({
                        type: "assistant.delta",
                        sessionId: this.options.sessionId,
                        text: event.text,
                    });
                    break;

                case "thinking_delta":
                    this.options.emit({
                        type: "assistant.thinking_delta",
                        sessionId: this.options.sessionId,
                        text: event.text,
                    });
                    break;

                case "done":
                    return event.turn;
            }
        }

        throw new ModelOutputError("The model stream ended without a final message.");
    }

    /**
     * Подряд идущие read-инструменты выполняются параллельно, остальные — по одному.
     * Порядок результатов совпадает с порядком вызовов.
     */
    private async executeTools(uses: ToolUseBlock[]): Promise<ToolResultBlock[]> {
        const results: ToolResultBlock[] = [];
        let index = 0;

        while (index < uses.length) {
            const batch: ToolUseBlock[] = [];

            while (index < uses.length) {
                const use = uses[index]!;
                const isRead = this.toolsByName.get(use.name)?.kind === "read";

                if (batch.length > 0 && !isRead) {
                    break;
                }

                batch.push(use);
                index += 1;

                if (!isRead) {
                    break;
                }
            }

            results.push(...await Promise.all(batch.map(use => this.executeTool(use))));
        }

        return results;
    }

    private async executeTool(use: ToolUseBlock): Promise<ToolResultBlock> {
        const { sessionId, signal } = this.options;

        if (signal.aborted) {
            return errorResult(use.id, "Cancelled by user before execution.");
        }

        const tool = this.toolsByName.get(use.name);

        if (!tool) {
            return errorResult(
                use.id,
                `Unknown tool '${use.name}'. Available tools: ${[...this.toolsByName.keys()].join(", ")}.`,
            );
        }

        const parsed = tool.inputSchema.safeParse(use.input);

        if (!parsed.success) {
            return errorResult(
                use.id,
                `Invalid input for '${use.name}':\n${z.prettifyError(parsed.error)}`,
            );
        }

        if (this.options.authorizer) {
            const decision = await this.options.authorizer.authorize({
                sessionId,
                toolUseId: use.id,
                tool,
                input: parsed.data,
                signal,
            });

            if (!decision.allowed) {
                return errorResult(use.id, decision.message);
            }
        }

        if (tool.kind !== "read" && this.options.beforeMutation) {
            try {
                await this.options.beforeMutation();
            }
            catch (error) {
                return errorResult(use.id, `Could not save a restore point before this change, so it was not made: ${errorMessage(error)}`);
            }
        }

        this.options.emit({
            type: "tool.started",
            sessionId,
            toolUseId: use.id,
            name: use.name,
            input: use.input,
        });

        let content: ToolOutput;
        let isError = false;

        try {
            content = await tool.run(parsed.data, {
                sessionId,
                toolUseId: use.id,
                workspaceRoot: this.options.workspaceRoot,
                signal,
                emit: this.options.emit,
            });
        }
        catch (error) {
            isError = true;
            content = signal.aborted
                ? "Cancelled by user."
                : error instanceof ToolError
                    ? error.message
                    : `Tool '${use.name}' failed: ${errorMessage(error)}`;
        }

        content = truncateOutput(content);

        if (!isError && ((tool.kind === "write" && tool.changesFiles !== false) || tool.name === DELEGATE_TOOL)) {
            this.changedSinceVerify = true;
            this.wroteThisRun = true;
        }

        this.options.emit({
            type: "tool.finished",
            sessionId,
            toolUseId: use.id,
            isError,
            preview: outputPreview(content),
        });

        return {
            type: "tool_result",
            toolUseId: use.id,
            content,
            isError,
        };
    }

    private result(status: AgentLoopStatus, reason?: string): AgentLoopResult {
        return {
            status,
            ...(reason ? { reason } : {}),
            steps: this.budget.steps,
            usage: this.budget.usage,
        };
    }
}

export function createMessage(
    role: Message["role"],
    content: ContentBlock[],
    meta?: MessageMeta,
): Message {
    return {
        id: randomUUID(),
        role,
        content,
        createdAt: new Date().toISOString(),
        ...(meta ? { meta } : {}),
    };
}

/**
 * Ответ утверждает, что файлы изменены («has been added», «I've updated …»).
 */
export function claimsFileChanges(content: ContentBlock[]): boolean {
    const text = content
        .map(block => block.type === "text" ? block.text : "")
        .join("\n");

    return /\b(has|have) been (added|updated|created|modified|implemented|fixed|changed|written)\b|\bI(?:'ve| have)? (added|updated|created|modified|implemented|fixed|changed|wrote|rewrote)\b|<tool_response>/i.test(text);
}

function errorResult(toolUseId: string, text: string): ToolResultBlock {
    return {
        type: "tool_result",
        toolUseId,
        content: text,
        isError: true,
    };
}

export function truncateOutput(output: ToolOutput): ToolOutput {
    const cut = (text: string) =>
        text.length <= MAX_TOOL_OUTPUT_CHARS
            ? text
            : `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n[…output truncated: ${text.length - MAX_TOOL_OUTPUT_CHARS} more characters. Narrow the request (offset/limit, a more specific pattern).]`;

    if (typeof output === "string") {
        return cut(output);
    }

    return output.map(block => block.type === "text" ? { ...block, text: cut(block.text) } : block);
}

function outputPreview(output: ToolOutput): string {
    const text = typeof output === "string"
        ? output
        : output.map(block => block.type === "text" ? block.text : "[image]").join("\n");

    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
