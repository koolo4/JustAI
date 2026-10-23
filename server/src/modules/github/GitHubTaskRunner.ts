import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { Message, ToolResultBlock } from "@justai/shared";

import type { GitService } from "../../infrastructure/git/GitService.js";
import type { ProcessManager } from "../../infrastructure/process/ProcessManager.js";
import { classifyCommand } from "../agent/permissions/CommandClassifier.js";
import type { PermissionService } from "../agent/permissions/PermissionService.js";
import type { SessionManager } from "../agent/runtime/SessionManager.js";
import type { VerificationOutcome, Verifier } from "../agent/runtime/Verifier.js";
import { BOT_MARKER, GitHubError, type GitHubClient, type GitHubComment, type GitHubIssue } from "./GitHubClient.js";

export const LABELS = {
    working: "justai:working",
    review: "justai:review",
    failed: "justai:failed",
    paused: "justai:paused",
    merged: "justai:merged",
} as const;

export interface GitHubRunnerConfig {
    /** Метка задач для JustAI. */
    label: string;
    /** Кто может ставить задачи; пусто — владелец токена. */
    allowedUsers: string[];
    profile: string;
    provider: string;
    model?: string;
    executorProvider?: string;
    pollMs: number;
    /** Работать с публичным репозиторием (задачи в нём может написать кто угодно). */
    allowPublic: boolean;
    /** Токен для git push по https://github.com (через переменные окружения, не в адресе и не в конфиге). */
    token: string;
    /** Как часто обновлять отчёт о ходе работы и проверять команду остановки (мс, по умолчанию 30 с). */
    progressMs?: number;
    /** Профиль задач-проверок «[justai-test]» (по умолчанию tester: без правки файлов). */
    testProfile?: string;
    /** Предел времени команды «/justai run» (мс, по умолчанию 5 минут). */
    commandTimeoutMs?: number;
    /** Сливать PR по команде «/justai merge» (при зелёных проверках). По умолчанию да. */
    merge?: boolean;
    mergeMethod?: "squash" | "merge" | "rebase";
}

export interface GitHubRunnerStatus {
    enabled: boolean;
    repo: string;
    state: "idle" | "working" | "error" | "stopped";
    currentIssue?: number;
    /** Сессия, в которой сейчас работает исполнитель (её можно открыть в интерфейсе и смотреть шаги). */
    currentSessionId?: string;
    lastCheck?: string;
    lastError?: string;
    /** Задачи выполняются, но что-то второстепенное не работает (например, нет прав на метки). */
    warning?: string;
    tasks: Array<{ issue: number; status: TaskState["status"]; branch: string; pullRequest?: string; kind?: TaskState["kind"]; checks?: TaskState["checks"] }>;
}

interface TaskState {
    sessionId: string;
    branch: string;
    status: "working" | "review" | "failed" | "paused" | "merged";
    /** Последний учтённый комментарий: новые после него — правки. */
    lastCommentId: number;
    pullRequest?: string;
    /** code — задача с правками и PR; test — проверка без правок (ветка `branch` только читается). */
    kind?: "code" | "test";
    /** Итог проверок проекта (typecheck, тесты…), которые мост запускает сам после работы агента. */
    checks?: VerificationOutcome["status"];
}

interface StoredState {
    tasks: Record<string, TaskState>;
    /** Служебные issues с правками и командами, которые уже приняты. */
    followUps?: number[];
    /** Комментарии «/justai run …» и «/justai merge», которые уже выполнены. */
    ran?: number[];
    /** Задачи, ждущие других (номер → чего ждёт): чтобы сообщить об ожидании один раз. */
    waiting?: Record<string, number[]>;
}

interface ProgressWatch {
    readonly stopped: boolean;
    readonly stopCommentId: number;
    update(header: string): Promise<void>;
    finish(): Promise<void>;
}

/** Владелец процессов проверок и команд «/justai run» (не сессия агента). */
const RUN_OWNER = "github-bridge";

/** Служебная ветка для скриншотов из отчётов. */
export const ARTIFACTS_BRANCH = "justai-artifacts";
const MAX_SCREENSHOTS = 6;
const COMMAND_OUTPUT_CHARS = 4_000;

const REPORT_CHARS = 3_000;

const CONTINUE_NOTE = "Continue the task from where you stopped and finish it.";

const RESUME_NOTE = "The previous run of this task was interrupted (JustAI was restarted). Check the current state of the files and continue from where you stopped until the task, including any requested changes above, is complete.";

function summarize(state: StoredState): GitHubRunnerStatus["tasks"] {
    return Object.entries(state.tasks).map(([issue, task]) => ({
        issue: Number(issue),
        status: task.status,
        branch: task.branch,
        ...(task.pullRequest ? { pullRequest: task.pullRequest } : {}),
        ...(task.kind ? { kind: task.kind } : {}),
        ...(task.checks ? { checks: task.checks } : {}),
    }));
}

/**
 * Мост GitHub → JustAI: задачи из issues выполняются локальным агентом без присмотра,
 * результат — ветка, pull request и отчёт в issue. Новые комментарии к задаче — доработка той же ветки.
 */
export class GitHubTaskRunner {

    private timer?: NodeJS.Timeout;
    private running?: Promise<void>;
    private allowed?: Set<string>;
    private readonly stateFile: string;
    private status: GitHubRunnerStatus;
    /** Прерывает проверки и команды при остановке моста. */
    private aborter = new AbortController();

    constructor(
        private readonly deps: {
            client: GitHubClient;
            git: GitService;
            sessions: SessionManager;
            permissions: PermissionService;
            workspaceRoot: string;
            config: GitHubRunnerConfig;
            /** Проверки проекта после работы агента (результат — в отчёте). */
            verifier?: Verifier;
            /** Команды «/justai run» и остановка серверов, которые агент оставил запущенными. */
            processes?: ProcessManager;
            /** Закрыть страницу браузера сессии после задачи. */
            browser?: { close(sessionId: string): Promise<unknown> };
            log?: (message: string) => void;
        },
    ) {
        this.stateFile = path.join(deps.workspaceRoot, ".justai", "github-state.json");
        this.status = { enabled: false, repo: deps.client.repo, state: "stopped", tasks: [] };
    }

    public getStatus(): GitHubRunnerStatus {
        return this.status;
    }

    public start(): void {
        if (this.timer) return;

        this.aborter = new AbortController();
        this.status = { ...this.status, enabled: true, state: "idle" };
        this.timer = setInterval(() => void this.check(), this.deps.config.pollMs);
        this.timer.unref();
        void this.check();
    }

    public async stop(): Promise<void> {
        clearInterval(this.timer);
        this.timer = undefined;
        this.status = { ...this.status, enabled: false, state: "stopped" };
        this.aborter.abort();
        await this.running?.catch(() => undefined);
    }

    /** Один проход: взять следующую задачу или правку. Параллельно не выполняется. */
    public check(): Promise<void> {
        this.running ??= this.tick()
            .catch(error => {
                this.status = { ...this.status, state: "error", lastError: message(error) };
                this.deps.log?.(`[github] ${message(error)}`);
            })
            .finally(() => {
                this.running = undefined;
            });

        return this.running;
    }

    private async tick(): Promise<void> {
        const { client, config } = this.deps;
        this.status = { ...this.status, lastCheck: new Date().toISOString() };

        if (!config.allowPublic && !(await client.isPrivate())) {
            throw new Error(`Repository ${client.repo} is public: anyone could post tasks that run on this computer. Make it private or set JUSTAI_GITHUB_ALLOW_PUBLIC=on.`);
        }

        // Папка проекта должна быть клоном именно этого репозитория: иначе можно отправить в него чужой код.
        const origin = await this.git(["remote", "get-url", "origin"]).catch(() => "");

        if (!originMatches(origin, client.repo)) {
            throw new Error(`The project folder is not a clone of ${client.repo} (origin: ${origin.trim() || "none"}). Clone the repository and open that folder in JustAI (📁).`);
        }

        const allowed = await this.allowedUsers();
        const state = await this.load();
        this.status = { ...this.status, tasks: summarize(state) };
        const all = (await client.listIssues()).filter(issue => !issue.isPullRequest);
        const open = all.filter(issue => allowed.has(issue.author.toLowerCase()));
        // Зависимость выполнена, когда её issue закрыт (слияние PR «Closes #N» закрывает его само).
        const openNumbers = new Set(all.map(issue => issue.number));

        // «В работе» в файле, но не в этом процессе: задачу оборвал перезапуск JustAI — продолжаем в той же сессии.
        for (const issue of open) {
            const task = state.tasks[issue.number];

            if (task?.status === "working" && task.sessionId) {
                await this.run(issue, state, [{ id: 0, author: "JustAI", body: RESUME_NOTE, createdAt: "" }]);
                return;
            }
        }

        // Правки отдельным issue («/justai #3»): для планировщиков, которым GitHub не даёт комментировать.
        for (const issue of open) {
            const target = followUpTarget(issue, config.label);
            const task = target === null ? undefined : state.tasks[target];

            if (target === null || !task || task.status === "working" || state.followUps?.includes(issue.number)) {
                continue;
            }

            const action = followUpCommand(issue, config.label)?.action;

            // «/justai merge #N»: слить PR задачи (проверки запускаются заново).
            if (action === "merge") {
                if (!(await this.merge(target, task, state, issue.number))) return;

                state.followUps = [...state.followUps ?? [], issue.number];
                await this.save(state);
                await this.soft(client.closeIssue(issue.number), "closing issues");
                return;
            }

            state.followUps = [...state.followUps ?? [], issue.number];
            await this.save(state);

            // «/justai stop #N», когда задача не выполняется, — останавливать нечего.
            if (action === "stop") {
                await this.soft(client.comment(issue.number, `Задача #${target} сейчас не выполняется — останавливать нечего.`), "comments");
                await this.soft(client.closeIssue(issue.number), "closing issues");
                continue;
            }

            await this.soft(client.comment(issue.number, `Принято как правка к задаче #${target}. Отчёт будет в #${target}.`), "comments");
            await this.soft(client.closeIssue(issue.number), "closing issues");

            const body = stripCommands(issue.body, config.label) || CONTINUE_NOTE;
            await this.run(await client.getIssue(target), state, [{ id: 0, author: issue.author, body, createdAt: "" }]);
            return;
        }

        // Команда отдельным issue: «/justai run [#N] команда» первой строкой.
        for (const issue of open) {
            const request = runIssueCommand(issue, config.label);

            if (!request || state.followUps?.includes(issue.number)) {
                continue;
            }

            const target = request.target === undefined ? undefined : state.tasks[request.target];
            const done = request.target !== undefined && !target
                ? await this.soft(client.comment(issue.number, `Задача #${request.target} не найдена в этом JustAI — команда не выполнена.`), "comments").then(() => true)
                : await this.runCommand(issue.number, target?.branch, request.command);

            if (!done) return;

            state.followUps = [...state.followUps ?? [], issue.number];
            await this.save(state);
            await this.soft(client.closeIssue(issue.number), "closing issues");
            return;
        }

        const issues = open.filter(issue => followUpTarget(issue, config.label) === null && !runIssueCommand(issue, config.label)
            && (isTask(issue, config.label) || isTestTask(issue, config.label)));

        for (const issue of issues) {
            const task = state.tasks[issue.number];

            if (!task) {
                // «Depends on #N»: задача ждёт, пока те задачи не будут слиты (их issues закрыты).
                const waiting = dependsOn(issue.body).filter(number => number !== issue.number && openNumbers.has(number));

                if (waiting.length) {
                    if (state.waiting?.[issue.number]?.join() !== waiting.join()) {
                        state.waiting = { ...state.waiting, [issue.number]: waiting };
                        await this.save(state);
                        await this.soft(client.comment(issue.number,
                            `⏳ **JustAI**: задача ждёт ${waiting.map(number => `#${number}`).join(", ")} — начну, когда ${waiting.length > 1 ? "они будут слиты" : "она будет слита"} (issue закроется).`), "comments");
                    }

                    continue;
                }

                // Задачу могли пометить маркером в тексте (метку ставит не каждая интеграция) — метку ставим сами.
                if (!issue.labels.includes(config.label)) {
                    await this.soft(client.addLabels(issue.number, [config.label]), "labels");
                }

                await this.run(issue, state, []);
                return;
            }

            if (task.status === "working") {
                continue;
            }

            const comments = await client.listComments(issue.number);
            const fresh = comments.filter(item =>
                item.id > task.lastCommentId && allowed.has(item.author.toLowerCase()) && !item.body.includes(BOT_MARKER)
                && !state.ran?.includes(item.id));

            // «/justai run команда» в задаче: выполнить в её ветке и ответить результатом; «/justai merge» — слить PR.
            for (const item of fresh) {
                const command = runCommentCommand(item.body, config.label);
                const merge = !command && isMergeCommand(item.body, config.label);

                if (!command && !merge) continue;
                if (!(command ? await this.runCommand(issue.number, task.branch, command) : await this.merge(issue.number, task, state, issue.number))) return;

                state.ran = [...state.ran ?? [], item.id].slice(-200);
                await this.save(state);
            }

            if (task.status === "merged") {
                continue;
            }

            const feedback = fresh.filter(item => !isStopCommand(item.body, config.label) && !runCommentCommand(item.body, config.label)
                && !isMergeCommand(item.body, config.label));

            if (feedback.length > 0) {
                await this.run(issue, state, feedback, comments);
                return;
            }
        }

        this.status = { ...this.status, state: "idle", currentIssue: undefined, lastError: undefined };
    }

    private async run(issue: GitHubIssue, state: StoredState, feedback: GitHubComment[], knownComments?: GitHubComment[]): Promise<void> {
        const { client, sessions, permissions, config } = this.deps;

        const previous = state.tasks[issue.number];
        const base = await client.defaultBranch();
        const kind = previous?.kind ?? (isTestTask(issue, config.label) ? "test" : "code");
        const testOf = kind === "test" ? testTarget(issue, config.label) : null;
        // Проверка смотрит ветку указанной задачи («/justai test #N») или основную.
        const branch = previous?.branch
            ?? (kind === "test" ? (testOf !== null ? state.tasks[testOf]?.branch : undefined) ?? base : `justai/issue-${issue.number}`);

        // Чужие незакоммиченные изменения не трогаем: задача подождёт.
        // Исключение — работу оборвал перезапуск: папка на ветке этой задачи (изменения агента продолжаются)
        // или прерванная проверка (её следы в папке оставила она сама — убираются).
        const dirty = await this.isDirty();
        const onTaskBranch = (await this.git(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim() === branch;
        const interruptedTest = kind === "test" && previous?.status === "working";

        if (dirty && !onTaskBranch && !interruptedTest) {
            this.status = { ...this.status, state: "error", lastError: "The workspace has uncommitted changes; GitHub tasks wait until it is clean." };
            return;
        }

        const comments = knownComments ?? await client.listComments(issue.number);

        this.status = { ...this.status, state: "working", currentIssue: issue.number, lastError: undefined, warning: undefined };
        this.deps.log?.(`[github] issue #${issue.number}: ${feedback.length ? "feedback" : "new task"} → ${branch}`);

        await this.soft(client.addLabels(issue.number, [LABELS.working]), "labels");
        await this.soft(client.removeLabel(issue.number, LABELS.review), "labels");
        await this.soft(client.removeLabel(issue.number, LABELS.failed), "labels");
        await this.soft(client.removeLabel(issue.number, LABELS.paused), "labels");

        const task: TaskState = {
            sessionId: previous?.sessionId ?? "",
            branch,
            status: "working",
            lastCommentId: Math.max(0, ...comments.map(item => item.id)),
            kind,
            ...(previous?.pullRequest ? { pullRequest: previous.pullRequest } : {}),
        };

        state.tasks[issue.number] = task;
        if (state.waiting?.[issue.number]) delete state.waiting[issue.number];
        await this.save(state);

        try {
            if (kind === "test") {
                if (dirty) await this.discardChanges();
                await this.checkoutDetached(branch);
            }
            else if (dirty && onTaskBranch) {
                await this.git(["fetch", "origin"], true);
            }
            else {
                await this.checkoutBranch(branch, base, Boolean(previous));
            }

            if (!task.sessionId || !(await sessions.get(task.sessionId).then(() => true, () => false))) {
                const created = await sessions.create({
                    profile: kind === "test" ? config.testProfile ?? "tester" : config.profile,
                    provider: config.provider,
                    ...(config.model ? { model: config.model } : {}),
                    ...(config.executorProvider ? { executorProvider: config.executorProvider } : {}),
                    mode: "full-auto",
                });
                task.sessionId = created.id;
                await sessions.setTitle(created.id, `GitHub #${issue.number}: ${cleanTitle(issue.title, config.label)}`);
            }

            this.status = { ...this.status, currentSessionId: task.sessionId };

            permissions.setUnattended(task.sessionId, true);
            const startIndex = (await sessions.get(task.sessionId)).messages.length;
            const prompt = feedback.length ? feedbackPrompt(issue, feedback, branch)
                : kind === "test" ? testPrompt(issue, branch, config.label) : taskPrompt(issue, branch, config.label);
            await sessions.send(task.sessionId, { text: prompt });

            // Пока агент работает: живой отчёт в issue и проверка команды «/justai stop».
            const watch = await this.watch(issue, task, startIndex, state);
            await sessions.waitForIdle(task.sessionId);
            await watch.finish();
            // Серверы, которые агент оставил запущенными, мешают проверкам и следующей задаче.
            await this.cleanupSession(task.sessionId);

            const details = await sessions.get(task.sessionId);
            const messages = details.messages.slice(startIndex);
            const lastText = lastAssistantText(messages) || "(no report)";
            // Незаконченный шаг: последний текст агента — не итог (часто там описание успеха, которого не было).
            const report = details.session.status === "completed" || watch.stopped
                ? lastText
                : `_⚠ Агент не закончил (${details.session.lastError ?? details.session.status}). Ниже — последнее, что он написал; это не итог и может не совпадать с файлами._\n\n${lastText}`;

            if (kind === "test") {
                await this.finishTest(issue, task, watch, details.session, messages, report);
                return;
            }

            // Коммиты мог сделать и агент (например, слияние основной ветки для разрешения конфликта) — их тоже отправляем.
            const committed = await this.commit(issue, watch.stopped ? "WIP: " : "") || await this.isAhead(branch);

            if (committed) {
                await this.push(branch);
                const pull = await client.findPullRequest(branch)
                    ?? await client.createPullRequest(branch, base, `JustAI: ${cleanTitle(issue.title, this.deps.config.label)}`, `${clip(report, REPORT_CHARS)}\n\nCloses #${issue.number}\n\n${BOT_MARKER}`);
                task.pullRequest = pull.url;
            }

            if (watch.stopped) {
                task.status = "paused";
                task.lastCommentId = Math.max(task.lastCommentId, watch.stopCommentId);

                await watch.update("⏸ **JustAI** остановлен по команде.");
                await this.soft(client.comment(issue.number, [
                    "⏸ **JustAI** stopped on request.",
                    committed ? `Work so far is saved in \`${branch}\`${task.pullRequest ? ` · pull request: ${task.pullRequest}` : ""}.` : "No file changes yet.",
                    "",
                    "**Where it stopped:**",
                    clip(report, REPORT_CHARS),
                    "",
                    "_To continue, reply in this issue with instructions (or create an issue with `/justai continue #" + issue.number + "`). JustAI resumes in the same session._",
                ].join("\n")), "comments");
                await this.soft(client.addLabels(issue.number, [LABELS.paused]), "labels");
                return;
            }

            const ok = details.session.status === "completed" && (committed || Boolean(task.pullRequest));
            task.status = ok ? "review" : "failed";
            await watch.update(ok ? "✅ **JustAI** закончил — отчёт ниже." : "⚠️ **JustAI** не смог закончить — подробности ниже.");

            // Проверки — не со слов агента: мост запускает их сам на том, что закоммичено.
            const checks = ok ? await this.runChecks() : null;
            if (checks) task.checks = checks.status;
            const screenshots = await this.uploadScreenshots(issue.number, messages);
            // Что на самом деле изменилось в ветке — по git, чтобы отчёт агента можно было сверить.
            const stat = (await this.git(["diff", "--stat", `refs/remotes/origin/${base}...HEAD`]).catch(() => "")).trim();

            await this.soft(client.comment(issue.number, [
                ok ? "✅ **JustAI** finished this step." : "⚠️ **JustAI** could not complete this step.",
                committed ? `Branch \`${branch}\`${task.pullRequest ? ` · pull request: ${task.pullRequest}` : ""}` : "No file changes were made.",
                details.session.lastError ? `Error: ${details.session.lastError}` : "",
                ...(checks ? ["", checksReport(checks)] : []),
                ...(stat ? ["", "**Изменения в ветке** (по git, не со слов агента):", fenced(clip(stat, 2_000))] : []),
                "",
                "**Report:**",
                clip(report, REPORT_CHARS),
                ...screenshots,
                "",
                `_Reply in this issue to request changes — JustAI will continue on the same branch. Run a command on this branch: \`/${config.label} run <command>\`. Merge when it is good: \`/${config.label} merge\`._`,
            ].join("\n")), "comments");

            await this.soft(client.addLabels(issue.number, [ok ? LABELS.review : LABELS.failed]), "labels");
        }
        catch (error) {
            task.status = "failed";
            this.status = { ...this.status, state: "error", lastError: message(error) };
            await client.comment(issue.number, `⚠️ **JustAI** failed: ${clip(message(error), 1_000)}`).catch(() => undefined);
            await client.addLabels(issue.number, [LABELS.failed]).catch(() => undefined);
        }
        finally {
            permissions.setUnattended(task.sessionId, false);
            await client.removeLabel(issue.number, LABELS.working).catch(() => undefined);
            await this.cleanupSession(task.sessionId);
            // Проверка ничего не меняет: всё, что после неё осталось в папке, — её следы.
            if (kind === "test") await this.discardChanges().catch(() => undefined);
            await this.git(["checkout", base]).catch(() => undefined);
            await this.save(state);
            this.status = { ...this.status, currentIssue: undefined, currentSessionId: undefined, ...(this.status.state === "working" ? { state: "idle" as const } : {}) };
        }
    }

    /** Итог задачи-проверки: файлы не коммитятся, в отчёте — вердикт, проверки проекта и скриншоты. */
    private async finishTest(
        issue: GitHubIssue,
        task: TaskState,
        watch: ProgressWatch,
        session: { status: string; lastError?: string },
        messages: Message[],
        report: string,
    ): Promise<void> {
        const { client, config } = this.deps;
        const commit = (await this.git(["rev-parse", "--short", "HEAD"]).catch(() => "")).trim();
        const where = `ветка \`${task.branch}\`${commit ? ` (коммит ${commit})` : ""}`;

        if (watch.stopped) {
            task.status = "paused";
            task.lastCommentId = Math.max(task.lastCommentId, watch.stopCommentId);

            await watch.update("⏸ **JustAI** остановлен по команде.");
            await this.soft(client.comment(issue.number, [
                `⏸ **JustAI**: проверка остановлена по команде (${where}).`,
                "",
                "**На чём остановилась:**",
                clip(report, REPORT_CHARS),
                "",
                "_Продолжить — комментарий с указаниями в этом issue._",
            ].join("\n")), "comments");
            await this.soft(client.addLabels(issue.number, [LABELS.paused]), "labels");
            return;
        }

        const checks = await this.runChecks();
        if (checks) task.checks = checks.status;
        const screenshots = await this.uploadScreenshots(issue.number, messages);
        const passed = session.status === "completed" && testVerdict(report) !== "fail" && checks?.status !== "failed";
        task.status = passed ? "review" : "failed";

        await watch.update(passed ? "✅ **JustAI** закончил проверку — отчёт ниже." : "❌ **JustAI**: проверка не прошла — отчёт ниже.");
        await this.soft(client.comment(issue.number, [
            `🧪 **JustAI** — результат проверки: ${passed ? "✅ PASS" : "❌ FAIL"}`,
            `Проверено: ${where}. Файлы проекта не менялись.`,
            session.lastError ? `Ошибка: ${session.lastError}` : "",
            ...(checks ? ["", checksReport(checks)] : []),
            "",
            "**Отчёт:**",
            clip(report, REPORT_CHARS),
            ...screenshots,
            "",
            `_Проверить ещё раз или иначе — комментарий с указаниями в этом issue. Выполнить команду: \`/${config.label} run <команда>\`._`,
        ].join("\n")), "comments");
        await this.soft(client.addLabels(issue.number, [passed ? LABELS.review : LABELS.failed]), "labels");
    }

    /**
     * «/justai run …»: команда в ветке задачи (или основной), ответ — код выхода и хвост вывода.
     * Разрушительные команды (по классификатору) не выполняются. false — папка занята, повторить позже.
     */
    private async runCommand(postTo: number, branch: string | undefined, command: string): Promise<boolean> {
        const { client, processes, permissions, config } = this.deps;

        if (!processes) {
            await this.soft(client.comment(postTo, "⚠️ **JustAI**: на этом ПК команды по запросу не поддерживаются."), "comments");
            return true;
        }

        const classification = classifyCommand(command, await permissions.readRules());

        if (classification.level === "dangerous") {
            await this.soft(client.comment(postTo, `⛔ **JustAI**: команда ${code(command)} не выполнена — ${classification.reason}. Такие команды без присмотра не запускаются.`), "comments");
            return true;
        }

        if (await this.isDirty()) {
            this.status = { ...this.status, state: "error", lastError: "The workspace has uncommitted changes; GitHub tasks wait until it is clean." };
            return false;
        }

        const base = await client.defaultBranch();
        const target = branch ?? base;
        const limit = config.commandTimeoutMs ?? 300_000;

        this.status = { ...this.status, state: "working", currentIssue: postTo, lastError: undefined };
        this.deps.log?.(`[github] issue #${postTo}: run ${command} on ${target}`);

        try {
            await this.checkoutDetached(target);
            const commit = (await this.git(["rev-parse", "--short", "HEAD"])).trim();
            const started = Date.now();
            const result = await processes.run(command, { cwd: this.deps.workspaceRoot, owner: RUN_OWNER, timeoutMs: limit, signal: this.aborter.signal });
            const ok = result.info.status === "exited" && result.info.exitCode === 0;
            const outcome = result.info.status === "timed_out" ? `не уложилась в ${Math.round(limit / 1000)} с` : `код выхода ${result.info.exitCode ?? "—"}`;

            await this.soft(client.comment(postTo, [
                `▶ **JustAI** выполнил ${code(command)} в ветке \`${target}\` (коммит ${commit})`,
                `${ok ? "✅" : "❌"} ${outcome} · ${Math.round((Date.now() - started) / 1000)} с`,
                "",
                fenced(tail(result.output, COMMAND_OUTPUT_CHARS) || "(нет вывода)"),
            ].join("\n")), "comments");
        }
        catch (error) {
            await this.soft(client.comment(postTo, `⚠️ **JustAI**: команда ${code(command)} не выполнена: ${clip(message(error), 1_000)}`), "comments");
        }
        finally {
            await this.cleanupSession(RUN_OWNER);
            await this.discardChanges().catch(() => undefined);
            await this.git(["checkout", base]).catch(() => undefined);
            this.status = { ...this.status, currentIssue: undefined, ...(this.status.state === "working" ? { state: "idle" as const } : {}) };
        }

        return true;
    }

    /**
     * «/justai merge»: слить PR задачи в основную ветку — только готовую задачу и только если проверки,
     * запущенные заново на ветке PR, не падают. false — папка занята, повторить позже.
     */
    private async merge(issueNumber: number, task: TaskState, state: StoredState, replyTo: number): Promise<boolean> {
        const { client, config } = this.deps;
        const say = (text: string) => this.soft(client.comment(replyTo, text), "comments");
        const pullNumber = Number(/\/pull\/(\d+)/.exec(task.pullRequest ?? "")?.[1] ?? 0);

        if (config.merge === false) {
            await say("⛔ **JustAI**: слияние на этом ПК выключено (`JUSTAI_GITHUB_MERGE=off`) — слейте pull request вручную.");
            return true;
        }

        if (task.kind === "test" || !pullNumber || task.status !== "review") {
            await say(task.kind === "test"
                ? "⛔ **JustAI**: это задача-проверка — сливать нечего."
                : `⛔ **JustAI**: задачу #${issueNumber} слить нельзя — ${task.status === "merged" ? "она уже слита" : !pullNumber ? "pull request ещё нет" : `она в состоянии «${task.status}», а нужно «review» (готов PR)`}.`);
            return true;
        }

        if (await this.isDirty()) {
            this.status = { ...this.status, state: "error", lastError: "The workspace has uncommitted changes; GitHub tasks wait until it is clean." };
            return false;
        }

        const base = await client.defaultBranch();
        this.status = { ...this.status, state: "working", currentIssue: issueNumber, lastError: undefined };
        this.deps.log?.(`[github] issue #${issueNumber}: merge ${task.branch}`);

        try {
            // Проверки — на том, что сейчас в ветке PR (после отчёта её могли доработать).
            await this.checkoutDetached(task.branch);
            const checks = await this.runChecks();
            if (checks) task.checks = checks.status;

            if (checks?.status === "failed") {
                await say(["❌ **JustAI**: не слито — проверки не прошли.", "", checksReport(checks), "", "_Попросите исправить комментарием, затем снова `/" + config.label + " merge`._"].join("\n"));
                return true;
            }

            await client.mergePullRequest(pullNumber, `JustAI: ${cleanTitle((await client.getIssue(issueNumber)).title, config.label)} (#${issueNumber})`, config.mergeMethod ?? "squash");

            task.status = "merged";
            await this.soft(client.removeLabel(issueNumber, LABELS.review), "labels");
            await this.soft(client.addLabels(issueNumber, [LABELS.merged]), "labels");
            await this.soft(client.comment(issueNumber, [
                `🔀 **JustAI**: pull request ${task.pullRequest} слит в \`${base}\`.`,
                ...(checks ? ["", checksReport(checks)] : []),
            ].join("\n")), "comments");
            await this.soft(client.closeIssue(issueNumber), "closing issues");
            await this.soft(client.deleteBranch(task.branch), "branches", "Contents");
            if (replyTo !== issueNumber) await say(`🔀 Задача #${issueNumber} слита.`);
        }
        catch (error) {
            const notReady = error instanceof GitHubError && (error.status === 405 || error.status === 409);
            await say(notReady
                ? `⚠️ **JustAI**: GitHub не даёт слить PR — конфликт с \`${base}\` или ветка не готова (${clip(message(error), 300)}). Попросите комментарием: «влей ${base} в ветку и разреши конфликты», затем снова \`/${config.label} merge\`.`
                : `⚠️ **JustAI**: не удалось слить: ${clip(message(error), 1_000)}`);
        }
        finally {
            await this.discardChanges().catch(() => undefined);
            await this.git(["checkout", base]).catch(() => undefined);
            await this.save(state);
            this.status = { ...this.status, currentIssue: undefined, ...(this.status.state === "working" ? { state: "idle" as const } : {}) };
        }

        return true;
    }

    /** Проверки проекта (typecheck, тесты…) силами моста; null — проверять нечего или они выключены. */
    private async runChecks(): Promise<VerificationOutcome | null> {
        const { verifier, permissions } = this.deps;

        if (!verifier?.enabled) return null;

        const rules = await permissions.readRules();

        try {
            const outcome = await verifier.run({
                owner: RUN_OWNER,
                signal: this.aborter.signal,
                authorize: async command => classifyCommand(command, rules).level === "dangerous"
                    ? { allowed: false, message: "potentially destructive command" }
                    : { allowed: true },
            });

            return outcome.checks.length ? outcome : null;
        }
        catch (error) {
            this.deps.log?.(`[github] checks failed to run: ${message(error)}`);
            return null;
        }
        finally {
            await this.cleanupSession(RUN_OWNER);
        }
    }

    /** Скриншоты, которые агент снял за этот шаг, — в служебную ветку; в отчёт — картинки. */
    private async uploadScreenshots(issue: number, messages: Message[]): Promise<string[]> {
        const images = collectImages(messages).slice(-MAX_SCREENSHOTS);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const lines: string[] = [];

        for (const [index, image] of images.entries()) {
            const extension = image.mediaType === "image/jpeg" ? "jpg" : "png";

            try {
                const url = await this.deps.client.uploadFile(
                    ARTIFACTS_BRANCH,
                    `screenshots/issue-${issue}/${stamp}-${index + 1}.${extension}`,
                    image.dataBase64,
                    `JustAI: screenshot for #${issue}`,
                );
                lines.push(...(image.caption ? [`_${image.caption}_`] : []), `![скриншот ${index + 1}](${url})`);
            }
            catch (error) {
                await this.soft(Promise.reject(error), "screenshots", "Contents");
                break;
            }
        }

        return lines.length ? ["", "**Скриншоты:**", ...lines] : [];
    }

    /** Остановить процессы и закрыть браузер, которые остались от сессии. */
    private async cleanupSession(owner: string): Promise<void> {
        const { processes, browser } = this.deps;

        for (const info of processes?.list(owner) ?? []) {
            if (info.status === "running") await processes!.kill(info.id).catch(() => undefined);
        }

        await browser?.close(owner).catch(() => undefined);
    }

    /** В локальной ветке есть коммиты, которых нет на GitHub (или ветки там ещё нет). */
    private async isAhead(branch: string): Promise<boolean> {
        const remote = await this.git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).catch(() => "");
        const range = remote.trim() ? `refs/remotes/origin/${branch}..HEAD` : "HEAD";
        const base = remote.trim() ? [] : ["--not", "--remotes=origin"];
        return (await this.git(["rev-list", "--count", range, ...base]).catch(() => "0")).trim() !== "0";
    }

    private async isDirty(): Promise<boolean> {
        return (await this.git(["status", "--porcelain", "--", ".", ":(exclude).justai"])).trim() !== "";
    }

    /**
     * Убрать следы проверки или команды. Вызывается только когда перед ними папка была чистой,
     * поэтому чужих изменений здесь нет; игнорируемые файлы (node_modules, сборка) и .justai не трогаются.
     */
    private async discardChanges(): Promise<void> {
        await this.git(["reset", "--hard", "-q"]);
        await this.git(["clean", "-fdq", "-e", ".justai"]);
    }

    /** Ветка с GitHub без локальной ветки (detached): проверка и команды ничего не меняют в ветках. */
    private async checkoutDetached(branch: string): Promise<void> {
        await this.git(["fetch", "origin"], true);

        if (!(await this.git(["ls-remote", "--heads", "origin", branch], true)).trim()) {
            throw new Error(`Branch '${branch}' is not on GitHub yet (the task has no commits): nothing to check.`);
        }

        await this.git(["checkout", "--detach", `origin/${branch}`]);
    }

    /**
     * Наблюдение за работающим агентом: отчёт о ходе работы (один комментарий, обновляется) и команда остановки —
     * комментарий «/justai stop» в задаче или issue «/justai stop #N».
     */
    private async watch(issue: GitHubIssue, task: TaskState, startIndex: number, state: StoredState): Promise<ProgressWatch> {
        const { client, sessions, config } = this.deps;
        const allowed = await this.allowedUsers();
        let progressId = 0;
        let stopped = false;
        let stopCommentId = 0;
        let busy: Promise<void> | undefined;

        const render = async (header: string, active = true): Promise<string> => {
            const details = await sessions.get(task.sessionId);
            return progressReport(header, details.messages.slice(startIndex), task.branch, issue.number, config.label, active);
        };

        const update = async (header: string, active = false) => {
            if (!progressId) return;
            await this.soft(render(header, active).then(body => client.updateComment(progressId, body)), "comments");
        };

        try {
            progressId = await client.comment(issue.number, await render("⏳ **JustAI** работает над задачей…"));
        }
        catch (error) {
            await this.soft(Promise.reject(error), "comments");
        }

        const checkStop = async () => {
            const comments = await client.listComments(issue.number).catch(() => [] as GitHubComment[]);
            const command = comments.find(item =>
                item.id > task.lastCommentId && allowed.has(item.author.toLowerCase()) && isStopCommand(item.body, config.label));
            const issues = command ? [] : await client.listIssues().catch(() => [] as GitHubIssue[]);
            const stopIssue = issues.find(item =>
                !item.isPullRequest && allowed.has(item.author.toLowerCase()) && !state.followUps?.includes(item.number)
                && followUpCommand(item, config.label)?.action === "stop" && followUpTarget(item, config.label) === issue.number);

            if (!command && !stopIssue) return;

            stopped = true;
            stopCommentId = command?.id ?? 0;

            if (stopIssue) {
                state.followUps = [...state.followUps ?? [], stopIssue.number];
                await this.soft(client.comment(stopIssue.number, `Задача #${issue.number} остановлена.`), "comments");
                await this.soft(client.closeIssue(stopIssue.number), "closing issues");
            }

            this.deps.log?.(`[github] issue #${issue.number}: stop requested`);
            await sessions.stop(task.sessionId);
        };

        const tick = () => {
            busy ??= (async () => {
                if (!stopped) await checkStop();
                if (!stopped) await update("⏳ **JustAI** работает над задачей…", true);
            })().catch(() => undefined).finally(() => { busy = undefined; });
        };

        const timer = setInterval(tick, config.progressMs ?? 30_000);
        timer.unref();

        return {
            get stopped() { return stopped; },
            get stopCommentId() { return stopCommentId; },
            update,
            finish: async () => {
                clearInterval(timer);
                await busy;
            },
        };
    }

    /**
     * Метки и комментарии — дополнительная функция: без прав на них задача всё равно выполняется
     * (ветка, коммит, pull request), а проблема показывается в статусе.
     */
    private async soft(action: Promise<unknown>, what: string, permission = "Issues"): Promise<void> {
        try {
            await action;
        }
        catch (error) {
            const hint = error instanceof GitHubError && error.status === 403
                ? `No permission for ${what}: give the token \"${permission}: Read and write\" (GitHub → Settings → Developer settings → Fine-grained tokens).`
                : `Could not update ${what}: ${message(error)}`;
            this.status = { ...this.status, warning: hint };
            this.deps.log?.(`[github] ${hint}`);
        }
    }

    private async allowedUsers(): Promise<Set<string>> {
        if (!this.allowed) {
            const users = this.deps.config.allowedUsers.length ? this.deps.config.allowedUsers : [await this.deps.client.currentUser()];
            this.allowed = new Set(users.map(user => user.toLowerCase()));
        }

        return this.allowed;
    }

    private async checkoutBranch(branch: string, base: string, existing: boolean): Promise<void> {
        await this.git(["fetch", "origin"], true);

        if (!(await this.git(["ls-remote", "--heads", "origin", base], true)).trim()) {
            throw new Error(`The repository has no commits on '${base}' yet. Add a first commit (for example, "Add a README" on the repository page on GitHub), then the task will run.`);
        }

        const remoteBranch = existing && (await this.git(["ls-remote", "--heads", "origin", branch], true)).trim() !== "";

        await this.git(["checkout", "-B", branch, remoteBranch ? `origin/${branch}` : `origin/${base}`]);
    }

    /** Закоммитить всё, что сделал агент. false — изменений нет. */
    private async commit(issue: GitHubIssue, prefix = ""): Promise<boolean> {
        // .justai (сессии, токен, состояние моста) не коммитится никогда, даже если у проекта нет своего .gitignore.
        await this.git(["add", "-A", "--", ".", ":(exclude).justai"]);

        if (!(await this.git(["diff", "--cached", "--name-only"])).trim()) {
            return false;
        }

        const identity = (await this.git(["config", "user.email"]).catch(() => "")).trim()
            ? []
            : ["-c", "user.name=JustAI", "-c", "user.email=justai@users.noreply.github.com"];

        await this.git([...identity, "commit", "-m", `JustAI: ${prefix}${cleanTitle(issue.title, this.deps.config.label)} (#${issue.number})`]);
        return true;
    }

    private async push(branch: string): Promise<void> {
        await this.git(["push", "origin", `HEAD:refs/heads/${branch}`], true);
    }

    /** git в папке проекта; withAuth — заголовок авторизации для https://github.com через окружение. */
    private async git(args: string[], withAuth = false): Promise<string> {
        const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0" };

        if (withAuth && this.deps.config.token) {
            const basic = Buffer.from(`x-access-token:${this.deps.config.token}`).toString("base64");
            Object.assign(env, {
                GIT_CONFIG_COUNT: "1",
                GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
                GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
            });
        }

        const result = await this.deps.git.run(args, { cwd: this.deps.workspaceRoot, env });

        if (result.code !== 0) {
            throw new Error(`git ${args.filter(arg => !arg.startsWith("user.")).join(" ")} failed: ${result.stderr.trim().slice(0, 400)}`);
        }

        return result.stdout.toString("utf8");
    }

    private async load(): Promise<StoredState> {
        try {
            return JSON.parse(await readFile(this.stateFile, "utf8")) as StoredState;
        }
        catch {
            return { tasks: {} };
        }
    }

    private async save(state: StoredState): Promise<void> {
        await mkdir(path.dirname(this.stateFile), { recursive: true });
        await writeFile(this.stateFile, JSON.stringify(state, null, 2), "utf8");
        this.status = { ...this.status, tasks: summarize(state) };
    }
}

/**
 * Задача для JustAI: метка, «[justai]» в начале заголовка или отдельная строка «/justai» в описании.
 * Маркеры нужны интеграциям, которым GitHub разрешает создавать issues, но не ставить метки.
 */
/** Заголовок без служебной пометки «[justai]» / «[justai-test]». */
export function cleanTitle(title: string, label: string): string {
    return title.replace(new RegExp(`^\\s*\\[${escapeRegExp(label)}(?:-test)?\\]\\s*`, "i"), "").trim() || title;
}

/**
 * Задача-проверка: «[justai-test]» в начале заголовка или строка «/justai test» («/justai test #N» — проверить ветку задачи N).
 * Агент ничего не меняет: запускает, проверяет в браузере, снимает скриншоты и отчитывается.
 */
export function isTestTask(issue: GitHubIssue, label: string): boolean {
    const escaped = escapeRegExp(label);
    return new RegExp(`^\\s*\\[${escaped}-test\\]`, "i").test(issue.title)
        || new RegExp(`^\\s*/${escaped}\\s+test(?:\\s+#\\d+)?\\s*$`, "im").test(issue.body);
}

/** Номер задачи, ветку которой надо проверить («/justai test #N»), иначе null — основная ветка. */
export function testTarget(issue: GitHubIssue, label: string): number | null {
    const match = new RegExp(`^\\s*/${escapeRegExp(label)}\\s+test\\s+#(\\d+)\\s*$`, "im").exec(issue.body);
    return match ? Number(match[1]) : null;
}

/** Issue-команда: первая строка описания «/justai run [#N] команда». */
export function runIssueCommand(issue: GitHubIssue, label: string): { target?: number; command: string } | null {
    const first = issue.body.split("\n").find(line => line.trim()) ?? "";
    const match = new RegExp(`^\\s*/${escapeRegExp(label)}\\s+run\\s+(?:#(\\d+)\\s+)?(.+?)\\s*$`, "i").exec(first);

    if (!match) return null;

    return { ...(match[1] ? { target: Number(match[1]) } : {}), command: match[2]! };
}

/** Комментарий-команда «/justai run команда» отдельной строкой; номер задачи в комментарии не нужен. */
export function runCommentCommand(body: string, label: string): string | null {
    const match = new RegExp(`^\\s*/${escapeRegExp(label)}\\s+run\\s+(?:#\\d+\\s+)?(.+?)\\s*$`, "im").exec(body);
    return match ? match[1]! : null;
}

/** Вердикт агента-проверяющего: последняя строка «RESULT: PASS / FAIL». */
export function testVerdict(report: string): "pass" | "fail" | "unknown" {
    const matches = [...report.matchAll(/RESULT:\s*\**\s*(PASS|FAIL)/gi)];
    const last = matches.at(-1)?.[1];
    return last ? (last.toUpperCase() === "PASS" ? "pass" : "fail") : "unknown";
}

/** Проверки проекта для отчёта: итог и по каждой команде; у упавших — хвост вывода. */
export function checksReport(outcome: VerificationOutcome): string {
    const failed = outcome.checks.filter(check => !check.ok);
    const header = outcome.status === "passed" ? `✅ все прошли (${outcome.checks.length})`
        : outcome.status === "failed" ? `❌ не прошли: ${failed.length} из ${outcome.checks.length}` : "— не запускались";

    const lines = [`**Проверки проекта** (запустил JustAI, не агент): ${header}`];

    for (const check of outcome.checks) {
        const where = check.cwd === "." ? "" : ` в ${check.cwd}`;
        const result = check.skipped ? ` — ${check.skipped}` : check.ok ? "" : ` — код выхода ${check.exitCode ?? "—"}`;
        lines.push(`- ${check.ok ? "✓" : "✕"} ${code(check.command)}${where}${result}`);
    }

    for (const check of failed.filter(item => !item.skipped?.startsWith("not allowed") && item.output.trim())) {
        lines.push("", `<details><summary>Вывод ${code(check.command)}</summary>`, "", fenced(tail(check.output, 2_000)), "", "</details>");
    }

    return lines.join("\n");
}

/** Картинки из результатов инструментов (browser_screenshot, MCP) — с подписью из текста рядом. */
export function collectImages(messages: Message[]): Array<{ mediaType: string; dataBase64: string; caption: string }> {
    const images: Array<{ mediaType: string; dataBase64: string; caption: string }> = [];

    for (const message of messages) {
        for (const block of message.content) {
            if (block.type !== "tool_result" || typeof block.content === "string") continue;

            const caption = block.content.map(part => part.type === "text" ? part.text : "").join(" ").trim();

            for (const part of block.content) {
                if (part.type === "image") images.push({ mediaType: part.mediaType, dataBase64: part.dataBase64, caption: firstLineOf(caption) });
            }
        }
    }

    return images;
}

function code(text: string): string {
    const single = text.replace(/\s+/g, " ").trim();
    return single.includes("`") ? `\`\` ${single} \`\`` : `\`${single}\``;
}

function fenced(text: string): string {
    const fence = text.includes("```") ? "~~~~" : "```";
    return `${fence}\n${text.trimEnd()}\n${fence}`;
}

function tail(text: string, max: number): string {
    const trimmed = text.trimEnd();
    return trimmed.length > max ? `…\n${trimmed.slice(-max)}` : trimmed;
}

export function isTask(issue: GitHubIssue, label: string): boolean {
    const escaped = escapeRegExp(label);
    return issue.labels.includes(label)
        || new RegExp(`^\\s*\\[${escaped}\\]`, "i").test(issue.title)
        || new RegExp(`^\\s*/${escaped}\\s*$`, "im").test(issue.body);
}

/**
 * Служебный issue для задачи N: «/justai #3», «/justai continue #3» (правка или продолжение), «/justai stop #3» (остановить).
 */
export function followUpCommand(issue: GitHubIssue, label: string): { target: number; action: "stop" | "continue" | "merge" } | null {
    const match = new RegExp(`^\\s*/${escapeRegExp(label)}\\s+(?:(stop|pause|continue|merge)\\s+)?#(\\d+)\\s*$`, "im").exec(issue.body);

    if (!match) {
        return null;
    }

    const action = match[1] === "stop" || match[1] === "pause" ? "stop" : match[1] === "merge" ? "merge" : "continue";
    return { target: Number(match[2]), action };
}

/** Комментарий-команда «/justai merge» отдельной строкой: слить PR задачи. */
export function isMergeCommand(body: string, label: string): boolean {
    return new RegExp(`^\\s*/${escapeRegExp(label)}\\s+merge\\s*$`, "im").test(body);
}

/**
 * Зависимости задачи: строки «Depends on #3, #4» или «Зависит от #3» в начале строки.
 * Задача начнётся, когда эти issues закроются (слияние их PR закрывает их).
 */
export function dependsOn(body: string): number[] {
    const numbers = new Set<number>();

    for (const line of body.matchAll(/^\s*[-*]?\s*\**(?:depends on|зависит от)\**\s*:?\s*(.+)$/gim)) {
        for (const ref of line[1]!.matchAll(/#(\d+)/g)) numbers.add(Number(ref[1]));
    }

    return [...numbers];
}

/** Номер задачи, к которой этот issue — правка или команда, иначе null. */
export function followUpTarget(issue: GitHubIssue, label: string): number | null {
    return followUpCommand(issue, label)?.target ?? null;
}

/** Комментарий-команда «/justai stop» (или pause) отдельной строкой. */
export function isStopCommand(body: string, label: string): boolean {
    return new RegExp(`^\\s*/${escapeRegExp(label)}\\s+(stop|pause)\\s*$`, "im").test(body);
}

/** Текст правки без служебных строк «/justai …». */
export function stripCommands(body: string, label: string): string {
    return body.replace(new RegExp(`^\\s*/${escapeRegExp(label)}\\b.*$`, "gim"), "").trim();
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * origin указывает на owner/name на GitHub: https://github.com/owner/name(.git), git@github.com:owner/name.git.
 * Локальный путь (bare-репозиторий в тестах) принимается: проверить по нему владельца нельзя.
 */
export function originMatches(origin: string, repo: string): boolean {
    const url = origin.trim();

    if (!url) {
        return false;
    }

    const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(url);

    if (match) {
        return match[1]!.toLowerCase() === repo.toLowerCase();
    }

    return !/^[a-z]+:\/\//i.test(url) && !/^[\w.-]+@/.test(url);
}

export function taskPrompt(issue: GitHubIssue, branch: string, label = "justai"): string {
    return [
        cleanTitle(issue.title, label),
        "",
        issue.body.trim() || "(no description)",
        "",
        "---",
        `This is GitHub task #${issue.number}. You are working in a git repository on branch ${branch}. Implement this task completely in the files, run the project's checks or tests if there are any, and fix what fails.`,
        "Do not commit or push: JustAI commits your changes and opens a pull request after you finish.",
        "Finish with a short report: what you changed (files), how you verified it, and anything left to do.",
    ].join("\n");
}

export function testPrompt(issue: GitHubIssue, branch: string, label = "justai"): string {
    return [
        cleanTitle(issue.title, label),
        "",
        stripCommands(issue.body, label) || "(no description: run the project's checks and check that it starts and works)",
        "",
        "---",
        `This is GitHub test task #${issue.number}. You are a tester: check the project as it is (branch ${branch}) and report. Do not change the project's files.`,
        "- Install dependencies if needed and run what the task asks for (tests, build, scripts) with run_command.",
        "- To check a web interface: start the dev server or a static server with run_command background=true, open it with browser_open,",
        "  act with browser_click / browser_type, read with browser_text / browser_console, and take screenshots with browser_screenshot",
        "  (width 375 for a phone). Screenshots are attached to the report automatically.",
        "- Stop the servers you started (kill_process) when you are done.",
        "Finish with a report: each checked step with ✓ or ✕ and what you saw (errors, console messages, wrong text),",
        "then a last line exactly \"RESULT: PASS\" if everything works or \"RESULT: FAIL\" otherwise.",
    ].join("\n");
}

const PROGRESS_ACTIONS = 8;

/**
 * Отчёт о ходе работы для issue: шаги, план агента, последние действия (с ошибками) и повторяющиеся сбои —
 * чтобы планировщик или человек видели, идёт ли работа, и могли вовремя остановить её.
 */
export function progressReport(header: string, messages: Message[], branch: string, issue: number, label: string, active = true): string {
    const results = new Map<string, ToolResultBlock>();

    for (const message of messages) {
        for (const block of message.content) {
            if (block.type === "tool_result") results.set(block.toolUseId, block);
        }
    }

    const actions: string[] = [];
    let plan: Array<{ content?: unknown; status?: unknown }> | undefined;
    let steps = 0;
    let lastFailure = "";
    let failureStreak = 0;
    let failureTool = "";

    for (const message of messages) {
        for (const block of message.content) {
            if (block.type !== "tool_use") continue;

            steps += 1;

            if (block.name === "todo_write") {
                const todos = (block.input as { todos?: unknown } | null)?.todos;
                if (Array.isArray(todos)) plan = todos as typeof plan;
                continue;
            }

            const result = results.get(block.id);
            const error = result?.isError ? firstLineOf(resultText(result)) : "";
            actions.push(`${!result ? "…" : result.isError ? "✕" : "✓"} \`${block.name}\` ${briefInput(block.input)}${error ? ` — ${error}` : ""}`);

            const key = `${block.name}:${JSON.stringify(block.input)}`;

            if (result?.isError) {
                failureStreak = key === lastFailure ? failureStreak + 1 : 1;
                lastFailure = key;
                failureTool = block.name;
            }
            else if (result) {
                failureStreak = 0;
                lastFailure = "";
            }
        }
    }

    const time = new Date().toISOString().slice(11, 16);
    const lines = [header, `Шагов: ${steps} · ветка \`${branch}\` · обновлено ${time} UTC`];

    if (plan?.length) {
        lines.push("", "**План:**", ...plan.map(todo => `- [${todo.status === "completed" ? "x" : " "}] ${String(todo.content)}${todo.status === "in_progress" ? " ← сейчас" : ""}`));
    }

    if (actions.length) {
        lines.push("", "**Последние действия:**", ...actions.slice(-PROGRESS_ACTIONS));
    }

    if (failureStreak >= 2) {
        lines.push("", `⚠ Одна и та же ошибка \`${failureTool}\` повторяется ${failureStreak} раза подряд — возможно, агент застрял.`);
    }

    if (active) lines.push("", `_Остановить: комментарий \`/${label} stop\` (или issue со строкой \`/${label} stop #${issue}\`). Продолжить потом — комментарий с указаниями._`);
    return lines.join("\n");
}

function resultText(block: ToolResultBlock): string {
    return typeof block.content === "string"
        ? block.content
        : block.content.map(part => part.type === "text" ? part.text : "[image]").join(" ");
}

function firstLineOf(text: string): string {
    const line = text.trim().split("\n").find(item => item.trim()) ?? "";
    return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

function briefInput(input: unknown): string {
    const value = input as { path?: unknown; command?: unknown; pattern?: unknown; query?: unknown; task?: unknown } | null;
    const main = value?.path ?? value?.command ?? value?.pattern ?? value?.query ?? value?.task;

    if (typeof main !== "string") return "";

    const single = main.replace(/\s+/g, " ").trim();
    return single.length > 80 ? `${single.slice(0, 79)}…` : single;
}

export function feedbackPrompt(issue: GitHubIssue, feedback: GitHubComment[], branch: string): string {
    return [
        ...feedback.map(item => item.body.trim()),
        "",
        "---",
        `These are new comments from ${[...new Set(feedback.map(item => item.author))].join(", ")} on GitHub task #${issue.number} (${issue.title}).`,
        `Address them on branch ${branch}. Do not commit or push. Finish with a short report of what you changed.`,
    ].join("\n");
}

function lastAssistantText(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i]!;

        if (message.role !== "assistant") continue;

        const text = message.content.map(block => block.type === "text" ? block.text : "").join("").trim();
        if (text) return text;
    }

    return "";
}

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
