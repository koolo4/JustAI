import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { isLocalUrl } from "../../../infrastructure/browser/BrowserService.js";
import type { ProcessManager } from "../../../infrastructure/process/ProcessManager.js";
import { StaticServer } from "./StaticServer.js";

/** justai.app.json в корне репозитория: как поставить зависимости, собрать и запустить приложение. */
export interface AppConfig {
    install?: string;
    build?: string;
    start?: string;
    url?: string;
    readyTimeoutSec?: number;
}

export interface RunningApp {
    branch: string;
    commit: string;
    dir: string;
    url: string;
    /** Как запущено: команда или «встроенный статический сервер». */
    how: string;
    startedAt: number;
    lastUsed: number;
    processId?: string;
}

export const APP_CONFIG_FILE = "justai.app.json";
const APP_OWNER = "github-app";
const SETUP_TIMEOUT_MS = 10 * 60_000;

/**
 * Приложение проекта для проверок планировщика: отдельная рабочая копия (git worktree) нужной ветки
 * в .justai/worktrees — задачи агента в основной папке ему не мешают и наоборот. Одновременно одно приложение.
 */
export class AppManager {

    private current?: RunningApp & { staticServer?: StaticServer };

    constructor(
        private readonly deps: {
            workspaceRoot: string;
            processes: ProcessManager;
            /** git в папке проекта; withAuth — с токеном (fetch). */
            git: (args: string[], withAuth?: boolean) => Promise<string>;
            /** Команды проекта проходят тот же классификатор, что и у агента: разрушительные не запускаются. */
            isDangerous: (command: string) => Promise<string | null>;
            log?: (message: string) => void;
        },
    ) {}

    public status(): RunningApp | null {
        if (!this.current) return null;
        const { staticServer: _server, ...app } = this.current;
        return app;
    }

    public touch(): void {
        if (this.current) this.current.lastUsed = Date.now();
    }

    /** Хвост вывода приложения (для встроенного сервера вывода нет). */
    public logs(chars = 4_000): string {
        const id = this.current?.processId;

        if (!id) return this.current ? "(built-in static server: no output)" : "(no app is running)";

        try {
            const { output, info } = this.deps.processes.read(id);
            const tail = output.length > chars ? `…${output.slice(-chars)}` : output;
            return `${tail.trimEnd() || "(no output yet)"}\n[process ${info.status}${info.exitCode !== null ? `, exit code ${info.exitCode}` : ""}]`;
        }
        catch {
            return "(the app process is gone)";
        }
    }

    /**
     * Поднять приложение из ветки: worktree, установка и сборка (если заданы), запуск и ожидание готовности.
     * Уже запущенное приложение сначала останавливается.
     */
    public async start(branch: string, overrides: { start?: string; url?: string; readyTimeoutSec?: number } = {}): Promise<RunningApp> {
        await this.stop();

        const { dir, commit } = await this.worktree(branch);
        const config = await readAppConfig(dir);
        const command = overrides.start ?? config?.start;
        const readyMs = (overrides.readyTimeoutSec ?? config?.readyTimeoutSec ?? 60) * 1000;

        for (const [step, setup] of [["install", config?.install], ["build", config?.build]] as const) {
            if (!setup) continue;
            await this.assertSafe(setup);
            const result = await this.deps.processes.run(setup, { cwd: dir, owner: APP_OWNER, timeoutMs: SETUP_TIMEOUT_MS });

            if (result.info.status !== "exited" || result.info.exitCode !== 0) {
                throw new Error(`${step} (\`${setup}\`) failed with ${result.info.status === "timed_out" ? "a timeout" : `exit code ${result.info.exitCode}`}:\n${tail(result.output)}`);
            }
        }

        if (command) {
            const url = overrides.url ?? config?.url;

            if (!url) throw new Error(`The app has a start command but no url: add "url" to ${APP_CONFIG_FILE} or the scenario.`);
            if (!isLocalUrl(url)) throw new Error(`Only local addresses are allowed (localhost / 127.0.0.1), got ${url}.`);

            await this.assertSafe(command);
            const info = this.deps.processes.start(command, { cwd: dir, owner: APP_OWNER });
            this.current = { branch, commit, dir, url, how: `\`${command}\``, startedAt: Date.now(), lastUsed: Date.now(), processId: info.id };
            await this.waitReady(url, readyMs, info.id);
            return this.status()!;
        }

        if (existsSync(path.join(dir, "index.html"))) {
            const staticServer = new StaticServer(dir);
            const base = await staticServer.start();
            // Путь из url сценария сохраняется: http://localhost:8080/game.html → <встроенный сервер>/game.html.
            const pathname = overrides.url ? safePath(overrides.url) : "";
            this.current = { branch, commit, dir, url: new URL(pathname, base).toString(), how: "built-in static server", startedAt: Date.now(), lastUsed: Date.now(), staticServer };
            return this.status()!;
        }

        throw new Error(`Do not know how to start this project: add ${APP_CONFIG_FILE} with "start" and "url" (for example {"install": "npm ci", "start": "npm run dev -- --port 5173", "url": "http://localhost:5173"}).`);
    }

    public async stop(): Promise<void> {
        const app = this.current;
        this.current = undefined;

        if (!app) return;

        if (app.processId) await this.deps.processes.kill(app.processId).catch(() => undefined);

        for (const info of this.deps.processes.list(APP_OWNER)) {
            if (info.status === "running") await this.deps.processes.kill(info.id).catch(() => undefined);
        }

        await app.staticServer?.stop();
        await this.removeWorktree(app.dir);
    }

    /** Рабочая копия ветки с GitHub (detached), без локальных веток. */
    private async worktree(branch: string): Promise<{ dir: string; commit: string }> {
        await this.deps.git(["fetch", "origin"], true);

        if (!(await this.deps.git(["ls-remote", "--heads", "origin", branch], true)).trim()) {
            throw new Error(`Branch '${branch}' is not on GitHub.`);
        }

        const dir = path.join(this.deps.workspaceRoot, ".justai", "worktrees", branch.replace(/[^\w.-]+/g, "_"));
        await this.removeWorktree(dir);
        await this.deps.git(["worktree", "add", "--detach", "--force", dir, `origin/${branch}`]);
        const commit = (await this.deps.git(["-C", dir, "rev-parse", "--short", "HEAD"])).trim();

        return { dir, commit };
    }

    private async removeWorktree(dir: string): Promise<void> {
        await this.deps.git(["worktree", "remove", "--force", dir]).catch(() => undefined);
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        await this.deps.git(["worktree", "prune"]).catch(() => undefined);
    }

    private async assertSafe(command: string): Promise<void> {
        const reason = await this.deps.isDangerous(command);
        if (reason) throw new Error(`Refused to run \`${command}\`: ${reason}.`);
    }

    private async waitReady(url: string, timeoutMs: number, processId: string): Promise<void> {
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const info = this.deps.processes.list(APP_OWNER).find(item => item.id === processId);

            if (!info || info.status !== "running") {
                const output = this.logs();
                await this.stop();
                throw new Error(`The app exited before it became ready:\n${output}`);
            }

            try {
                const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
                await response.body?.cancel().catch(() => undefined);
                if (response.status < 500) return;
            }
            catch {
                // ещё не слушает порт
            }

            await new Promise(resolve => setTimeout(resolve, 500));
        }

        const output = this.logs();
        await this.stop();
        throw new Error(`The app did not answer at ${url} within ${Math.round(timeoutMs / 1000)} s. Output:\n${output}`);
    }
}

export async function readAppConfig(dir: string): Promise<AppConfig | null> {
    try {
        const parsed = JSON.parse(await readFile(path.join(dir, APP_CONFIG_FILE), "utf8")) as Record<string, unknown>;
        const text = (key: string) => typeof parsed[key] === "string" && parsed[key] ? { [key]: parsed[key] as string } : {};

        return {
            ...text("install"),
            ...text("build"),
            ...text("start"),
            ...text("url"),
            ...(typeof parsed.readyTimeoutSec === "number" ? { readyTimeoutSec: parsed.readyTimeoutSec } : {}),
        };
    }
    catch {
        return null;
    }
}

function safePath(url: string): string {
    try {
        const parsed = new URL(url, "http://localhost");
        return `${parsed.pathname.replace(/^\/+/, "")}${parsed.search}`;
    }
    catch {
        return "";
    }
}

function tail(text: string, max = 2_000): string {
    const trimmed = text.trimEnd();
    return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}
