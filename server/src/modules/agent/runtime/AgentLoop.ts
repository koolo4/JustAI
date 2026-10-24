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
    type ToolSpec,
} from "../providers/ModelProvider.js";
import type { Authorizer } from "../permissions/PermissionService.js";
import { ToolError, type Tool } from "../tools/Tool.js";
import { toToolSpec } from "../tools/ToolRegistry.js";
import { DELEGATE_TOOL } from "../tools/delegateTool.js";
import { Budget, type BudgetLimits } from "./Budget.js";
import { applyCompaction, chooseCut, summarizeHistory, type Compaction } from "./Compactor.js";
import { contextBudget, fitToContextWindow } from "./ContextWindow.js";
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
    /** Пересказ начала сессии из прошлых прогонов. */
    compaction?: Compaction;
    /** Сохранить новый пересказ. Без него старые ходы при нехватке окна просто выбрасываются. */
    onCompaction?: (compaction: Compaction) => Promise<void>;
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

    private compaction: Compaction | undefined;

    /** Вызовы инструментов в этом прогоне (для страховки «просили сделать — ответил текстом»). */
    private toolCallsThisRun = 0;

    private nudgedToBuild = false;

    private planNudges = 0;

    /** Неудачные вызовы (инструмент + вход) → сколько раз провалились с последнего успешного изменения. */
    private readonly failedCalls = new Map<string, number>();

    constructor(
        private readonly options: AgentLoopOptions,
    ) {
        this.compaction = options.compaction;
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

                // Пустой ответ — не «готово»: небольшие модели так иногда отвечают на длинное задание.
                // Частая причина — вызов несуществующего инструмента: Ollama молча выбрасывает такой вызов,
                // и ответ приходит пустым. Поэтому в подсказке — список настоящих инструментов.
                if (isEmptyReply(turn.content) && turn.stopReason !== "max_tokens") {
                    if (formatRetries >= MAX_FORMAT_RETRIES) {
                        return this.result("failed", "The model kept returning empty replies (often: it tries to call a tool that does not exist).");
                    }

                    formatRetries += 1;
                    await add(createMessage("user", [{
                        type: "text",
                        text: [
                            "[JustAI] Your reply was empty, so nothing happened. If you tried to call a tool, it does not exist —",
                            `use only these tools: ${this.options.tools.map(tool => tool.name).join(", ")}.`,
                            "Continue the task now with one of them, or, if the task is complete, reply with your report.",
                        ].join(" "),
                    }]));
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

                // Просили сделать, а модель сразу ответила текстом (идеи, план) и не тронула ни одного инструмента.
                if (
                    !this.nudgedToBuild &&
                    this.toolCallsThisRun === 0 &&
                    this.options.tools.some(tool => tool.kind === "write" && tool.changesFiles !== false) &&
                    asksToBuild(lastUserText(messages))
                ) {
                    this.nudgedToBuild = true;
                    await add(createMessage("user", [{
                        type: "text",
                        text: "[JustAI] The user asked you to build this, not to describe it. Implement it now in the workspace: create the files with write_file (or delegate the steps), putting your ideas (modes, style, content) into the actual code. Then report briefly what you built.",
                    }]));
                    continue;
                }

                // Модель закончила, а в её собственном плане остались невыполненные пункты.
                const unfinished = unfinishedTodos(messages);

                if (unfinished.length > 0 && this.planNudges < MAX_PLAN_NUDGES) {
                    this.planNudges += 1;
                    await add(createMessage("user", [{
                        type: "text",
                        text: [
                            "[JustAI] Your plan still has unfinished items:",
                            ...unfinished.map(item => `- ${item}`),
                            "Continue and complete them in the workspace (update the plan with todo_write as you go). If an item is no longer needed, mark it completed and say why.",
                        ].join("\n"),
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

            this.toolCallsThisRun += toolUses.length;

            // Вход инструмента, обрезанный по max_tokens, часто выглядит валидным — не выполняем.
            const results = turn.stopReason === "max_tokens"
                ? toolUses.map(use => errorResult(
                    use.id,
                    "The tool input was cut off by the output token limit and was not executed. Split the work into smaller steps.",
                ))
                : await this.executeTools(toolUses);

            // Один и тот же неудачный вызов подряд — модель зациклилась: подсказать, а потом остановить.
            const repeats = this.trackRepeatedFailure(toolUses, results);

            if (repeats >= MAX_REPEATED_FAILURES) {
                await add(createMessage("user", results));
                return this.result("failed", `The agent repeated the same failing ${toolUses[0]!.name} call ${repeats} times and was stopped.`);
            }

            const nudge: ContentBlock[] = repeats > 0 && repeats % REPEAT_HINT_EVERY === 0
                ? [{
                    type: "text",
                    text: `[JustAI] You have made the same failing ${toolUses[0]!.name} call ${repeats} times. Repeating it will not work (for edit_file: that text is not in the file in that form). Change the approach: read the exact lines again (read_file with offset/limit around the place) and copy them character for character, make a smaller edit (one line), or rewrite the whole file with write_file.`,
                }]
                : [];

            await add(createMessage("user", [...results, ...nudge]));
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
        const view = await this.contextView(messages, tools);

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
     * Для моделей с маленьким окном — ужатая копия истории; сохранённая не меняется.
     * Если пришлось бы выбрасывать старые ходы, их сначала пересказывает модель (один раз, пересказ сохраняется).
     * Пересказ не удался — выбрасываем с журналом шагов, как раньше.
     */
    private async contextView(messages: Message[], tools: ToolSpec[]): Promise<Message[]> {
        const window = this.options.provider.contextWindow;

        if (!window) {
            return messages;
        }

        const options = {
            window: window.tokens,
            reserveForOutput: window.reserveForOutput,
            system: this.options.system,
            tools,
        };

        let base = applyCompaction(messages, this.compaction);
        let fit = fitToContextWindow(base, options);

        if (fit.dropped > 0 && this.options.onCompaction) {
            try {
                const budget = contextBudget(options);
                const cut = chooseCut(base, Math.floor(budget / 2));

                if (cut > 1) {
                    const summary = await summarizeHistory(
                        this.options.provider,
                        base.slice(1, cut),
                        this.compaction?.text,
                        this.options.signal,
                    );

                    this.budget.record(summary.usage);
                    this.compaction = { afterId: base[cut - 1]!.id, text: summary.text };
                    await this.options.onCompaction(this.compaction);

                    base = applyCompaction(messages, this.compaction);
                    fit = fitToContextWindow(base, options);
                }
            }
            catch (error) {
                if (this.options.signal.aborted) {
                    throw error;
                }
                // Пересказ — улучшение, не требование: остаётся обычное ужатие.
            }
        }

        return fit.messages;
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
                const isRead = this.findTool(use.name)?.kind === "read";

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

    /**
     * Сколько раз уже провалился такой же вызов (0 — на этом шаге провалов нет).
     * Чтение между попытками («прочитать → та же правка → прочитать…») счёт не сбрасывает —
     * только успешное действие, которое что-то меняет (правка, запись, команда).
     */
    private trackRepeatedFailure(toolUses: ToolUseBlock[], results: ToolResultBlock[]): number {
        let worst = 0;

        for (const use of toolUses) {
            const result = results.find(item => item.toolUseId === use.id);

            if (!result) continue;

            if (!result.isError) {
                if (this.findTool(use.name)?.kind !== "read") this.failedCalls.clear();
                continue;
            }

            const key = `${use.name}:${JSON.stringify(use.input)}`;
            const count = (this.failedCalls.get(key) ?? 0) + 1;
            this.failedCalls.set(key, count);
            worst = Math.max(worst, count);
        }

        return worst;
    }

    /**
     * Инструмент по имени. Некоторые модели (gpt-oss) добавляют пространство имён:
     * «repo_browser.list_dir», «functions.read_file» — берём часть после последней точки/двоеточия.
     */
    private findTool(name: string): Tool | undefined {
        return this.toolsByName.get(name) ?? this.toolsByName.get(name.split(/[.:/]/).pop() ?? name);
    }

    private async executeTool(use: ToolUseBlock): Promise<ToolResultBlock> {
        const { sessionId, signal } = this.options;

        if (signal.aborted) {
            return errorResult(use.id, "Cancelled by user before execution.");
        }

        const tool = this.findTool(use.name);

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
            name: tool.name,
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

/**
 * Пользователь просит что-то сделать (а не объяснить или посоветовать): «сделай», «создай», «мне нужен сайт», «build an app».
 * Вопросы и просьбы об идеях/плане без слов действия не считаются.
 */
export function asksToBuild(text: string): boolean {
    const lower = text.toLowerCase();
    // \b в JS не понимает кириллицу — границы слов задаются пробелами.
    const onlyIdeas = /(^|\s)(только|just|only)\s[^.?!]{0,40}(иде|план|совет|idea|plan|advice)/.test(lower)
        || /^(объясни|расскажи|что такое|как работает|почему|explain|what is|why|how does)(\s|$)/.test(lower.trim());

    if (onlyIdeas) {
        return false;
    }

    return /(сдела|созда|напиши|написать|реализу|добав|нужен|нужна|нужно|сверста|собери|запили|build|make|create|implement|write|add)\w*/.test(lower)
        && /(сайт|страниц|игр|приложени|бот|скрипт|сервис|функци|компонент|файл|код|лендинг|site|page|game|app|script|bot|service|feature|component|file|code)/.test(lower);
}

/** Подсказка о зацикливании — на каждый 3-й одинаковый неудачный вызов; остановка — на 6-й. */
const REPEAT_HINT_EVERY = 3;
const MAX_REPEATED_FAILURES = 6;

/** Сколько раз за прогон напоминать о невыполненных пунктах плана. */
const MAX_PLAN_NUDGES = 2;

/**
 * Невыполненные пункты последнего плана (todo_write) в текущем прогоне — после последнего сообщения пользователя.
 * План из прошлых задач не учитывается.
 */
export function unfinishedTodos(messages: Message[]): string[] {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i]!;

        if (message.role === "user" && message.content.some(block => block.type === "text" && !block.text.startsWith("[JustAI]"))) {
            return [];
        }

        for (const block of [...message.content].reverse()) {
            if (block.type !== "tool_use" || block.name !== "todo_write") continue;

            const todos = (block.input as { todos?: Array<{ content?: unknown; status?: unknown }> } | null)?.todos;

            return Array.isArray(todos)
                ? todos.filter(todo => todo.status !== "completed").map(todo => String(todo.content))
                : [];
        }
    }

    return [];
}

/** Текст последнего сообщения пользователя (не результаты инструментов и не подсказки JustAI). */
function lastUserText(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i]!;

        if (message.role !== "user") continue;

        const text = message.content
            .map(block => block.type === "text" ? block.text : "")
            .join("\n")
            .trim();

        if (text && !text.startsWith("[JustAI]")) {
            return text;
        }
    }

    return "";
}

/** В ответе нет ни текста, ни вызова инструмента (размышления не считаются). */
export function isEmptyReply(content: ContentBlock[]): boolean {
    return !content.some(block =>
        block.type === "tool_use" || (block.type === "text" && block.text.trim() !== ""));
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
