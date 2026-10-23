/**
 * Замеры агента на задачах-эталонах: npm run eval -- --provider groq --profile planner --runs 2
 *
 * Параметры: --provider (по умолчанию JUSTAI_PROVIDER), --model, --profile (coder), --executor (для planner),
 * --tasks id1,id2 (по умолчанию все), --runs (1), --timeout секунды на задачу (300), --trace.
 * Ключи и настройки — из server/.env и настроек интерфейса. Результат проверяется независимо (команды в tasks.ts).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import { Container, resolveInstallRoot } from "../src/app/Container.js";
import { SettingsStore } from "../src/app/SettingsStore.js";
import { configureProxy } from "../src/infrastructure/network/proxy.js";
import { EVAL_TASKS, type EvalTask } from "./tasks.js";

interface Options {
    provider: string;
    model?: string;
    profile: string;
    executor?: string;
    tasks: EvalTask[];
    runs: number;
    timeoutMs: number;
    trace: boolean;
}

export interface EvalResult {
    task: string;
    run: number;
    passed: boolean;
    reason: string;
    status: string;
    steps: number;
    inputTokens: number;
    outputTokens: number;
    seconds: number;
}

const here = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Options {
    const values = new Map<string, string>();

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i]!;

        if (!arg.startsWith("--")) continue;

        const [key, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
        const next = argv[i + 1];

        if (inline !== undefined) values.set(key, inline);
        else if (next !== undefined && !next.startsWith("--")) { values.set(key, next); i += 1; }
        else values.set(key, "true");
    }

    const wanted = values.get("tasks")?.split(",").map(item => item.trim()).filter(Boolean);
    const tasks = wanted ? EVAL_TASKS.filter(task => wanted.includes(task.id)) : EVAL_TASKS;

    if (wanted && tasks.length !== wanted.length) {
        throw new Error(`Unknown task. Available: ${EVAL_TASKS.map(task => task.id).join(", ")}`);
    }

    const model = values.get("model");
    const executor = values.get("executor");

    return {
        provider: values.get("provider") ?? env.JUSTAI_PROVIDER ?? "mock",
        ...(model ? { model } : {}),
        profile: values.get("profile") ?? "coder",
        ...(executor ? { executor } : {}),
        tasks,
        runs: Math.max(1, Number(values.get("runs") ?? 1) || 1),
        timeoutMs: Math.max(30, Number(values.get("timeout") ?? 300) || 300) * 1000,
        trace: values.has("trace"),
    };
}

async function runTask(task: EvalTask, run: number, options: Options): Promise<EvalResult> {
    const root = await mkdtemp(path.join(os.tmpdir(), `justai-eval-${task.id}-`));

    for (const [file, content] of Object.entries(task.files)) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), content, "utf8");
    }

    const container = new Container({ workspaceRoot: root, token: "eval" });
    await container.initialize();

    const trace: string[] = [];
    container.webSocketConnectionManager.broadcast = ((event: { type: string; [key: string]: unknown }) => {
        if (!options.trace) return;
        if (event.type === "tool.started") trace.push(`→ ${String(event.name)} ${JSON.stringify(event.input).slice(0, 100)}`);
        if (event.type === "tool.finished" && event.isError) trace.push(`  ✕ ${String(event.preview).split("\n")[0]?.slice(0, 120)}`);
    }) as never;

    const manager = container.sessionManager;
    const started = Date.now();
    let status = "error";
    let reason = "";
    let steps = 0;
    let usage = { inputTokens: 0, outputTokens: 0 };

    try {
        const session = await manager.create({
            profile: options.profile,
            provider: options.provider,
            ...(options.model ? { model: options.model } : {}),
            ...(options.executor ? { executorProvider: options.executor } : {}),
            mode: "full-auto",
        });

        await manager.send(session.id, { text: task.prompt });
        const timer = setTimeout(() => void manager.stop(session.id), options.timeoutMs);
        await manager.waitForIdle(session.id);
        clearTimeout(timer);

        const details = await manager.get(session.id);
        status = details.session.status;
        steps = details.session.steps;
        usage = details.session.usage;
        reason = details.session.lastError ?? "";
    }
    catch (error) {
        reason = error instanceof Error ? error.message : String(error);
    }
    finally {
        await container.dispose();
    }

    const failure = task.check(root);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);

    if (options.trace && trace.length) {
        console.log(trace.map(line => `    ${line}`).join("\n"));
    }

    return {
        task: task.id,
        run,
        passed: failure === "",
        // Ошибка сессии (нет ключа, провайдер недоступен) важнее итога проверки — она и есть причина.
        reason: [reason && `session ${status}: ${reason}`, failure].filter(Boolean).join(" · "),
        status,
        steps,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        seconds: Math.round((Date.now() - started) / 1000),
    };
}

export function formatReport(results: EvalResult[], label: string): string {
    const lines = [`Eval: ${label}`, ""];
    const pad = (text: string | number, width: number) => String(text).padEnd(width);

    lines.push(`${pad("task", 18)}${pad("run", 5)}${pad("result", 8)}${pad("steps", 7)}${pad("tokens in/out", 16)}${pad("time", 7)}note`);

    for (const result of results) {
        lines.push(
            `${pad(result.task, 18)}${pad(result.run, 5)}${pad(result.passed ? "PASS" : "FAIL", 8)}${pad(result.steps, 7)}`
            + `${pad(`${result.inputTokens}/${result.outputTokens}`, 16)}${pad(`${result.seconds}s`, 7)}${result.passed ? "" : result.reason.slice(0, 120)}`,
        );
    }

    const passed = results.filter(result => result.passed).length;
    const seconds = results.reduce((sum, result) => sum + result.seconds, 0);
    const tokens = results.reduce((sum, result) => sum + result.inputTokens + result.outputTokens, 0);

    lines.push("", `Passed ${passed}/${results.length} · total ${seconds}s · ${tokens} tokens`);
    return lines.join("\n");
}

async function main(): Promise<void> {
    dotenv.config({ path: path.join(here, "..", ".env"), quiet: true });
    new SettingsStore(resolveInstallRoot()).apply();
    configureProxy(process.env);

    const options = parseArgs(process.argv.slice(2), process.env);
    const label = `${options.profile}/${options.provider}${options.model ? `:${options.model}` : ""}${options.executor ? ` + executor ${options.executor}` : ""}`;
    const results: EvalResult[] = [];

    for (const task of options.tasks) {
        for (let run = 1; run <= options.runs; run += 1) {
            const result = await runTask(task, run, options);
            results.push(result);
            console.log(`${result.passed ? "PASS" : "FAIL"} ${task.id} #${run} (${result.seconds}s, ${result.steps} steps)${result.passed ? "" : ` — ${result.reason.slice(0, 160)}`}`);
        }
    }

    const report = formatReport(results, label);
    console.log(`\n${report}`);

    const directory = path.join(here, "results");
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify({ label, options: { ...options, tasks: options.tasks.map(task => task.id) }, results }, null, 2), "utf8");
    console.log(`Saved ${path.relative(process.cwd(), file)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().then(() => process.exit(0), error => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
