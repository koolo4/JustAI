import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

/** Хвост вывода, который хранится в памяти для каждого процесса. */
const MAX_BUFFER_CHARS = 2_000_000;

/** Переменные окружения, которые не передаются командам агента. */
const SECRET_ENV = /^(ANTHROPIC_|OPENAI_|JUSTAI_TOKEN$|JUSTAI_ENCRYPTION_KEY$|MICROSOFT_CLIENT_SECRET$)/i;

export type ProcessStatus = "running" | "exited" | "killed" | "timed_out";

export interface ProcessInfo {
    id: string;
    command: string;
    cwd: string;
    status: ProcessStatus;
    exitCode: number | null;
    startedAt: string;
    /** Сколько символов вывода всего было (для курсоров чтения). */
    outputLength: number;
}

export interface StartOptions {
    cwd: string;
    /** Владелец (сессия агента) — для списка и очистки. */
    owner?: string;
    onOutput?: (chunk: string) => void;
}

export interface RunOptions extends StartOptions {
    timeoutMs: number;
    signal?: AbortSignal;
}

export interface RunResult {
    info: ProcessInfo;
    output: string;
}

interface ManagedProcess {
    info: ProcessInfo;
    owner: string | undefined;
    child: ChildProcess;
    /** Хвост вывода и смещение его начала в полном выводе. */
    buffer: string;
    bufferStart: number;
    exited: Promise<void>;
    listeners: Set<(chunk: string) => void>;
}

/**
 * Запуск команд оболочки для агента: таймауты, фоновые процессы, убийство дерева процессов.
 */
export class ProcessManager {

    private readonly processes = new Map<string, ManagedProcess>();

    constructor(
        private readonly platform: NodeJS.Platform = process.platform,
    ) {}

    /**
     * Запускает команду и ждёт завершения (или таймаута / отмены).
     */
    public async run(command: string, options: RunOptions): Promise<RunResult> {
        const managed = this.spawnManaged(command, options);

        const timer = setTimeout(() => {
            void this.terminate(managed, "timed_out");
        }, options.timeoutMs);

        const onAbort = () => {
            void this.terminate(managed, "killed");
        };

        options.signal?.addEventListener("abort", onAbort, { once: true });

        if (options.signal?.aborted) {
            onAbort();
        }

        try {
            await managed.exited;
        }
        finally {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
            // Завершённые foreground-процессы в списке не нужны.
            this.processes.delete(managed.info.id);
        }

        return { info: { ...managed.info }, output: managed.buffer };
    }

    /**
     * Запускает команду в фоне (dev-сервер, watch). Вывод читается через read().
     */
    public start(command: string, options: StartOptions): ProcessInfo {
        return { ...this.spawnManaged(command, options).info };
    }

    /**
     * Вывод процесса начиная с позиции `since` (в символах полного вывода).
     */
    public read(id: string, since = 0): { info: ProcessInfo; output: string; next: number; skipped: number } {
        const managed = this.get(id);
        const from = Math.max(since, managed.bufferStart);
        const output = managed.buffer.slice(from - managed.bufferStart);

        return {
            info: { ...managed.info },
            output,
            next: managed.info.outputLength,
            skipped: from - since,
        };
    }

    /** Ждёт завершения процесса, но не дольше timeoutMs. */
    public async wait(id: string, timeoutMs: number): Promise<ProcessInfo> {
        const managed = this.get(id);

        await Promise.race([
            managed.exited,
            new Promise(resolve => setTimeout(resolve, timeoutMs)),
        ]);

        return { ...managed.info };
    }

    public async kill(id: string): Promise<ProcessInfo> {
        const managed = this.get(id);
        await this.terminate(managed, "killed");
        return { ...managed.info };
    }

    public list(owner?: string): ProcessInfo[] {
        return [...this.processes.values()]
            .filter(managed => owner === undefined || managed.owner === owner)
            .map(managed => ({ ...managed.info }));
    }

    /** Убивает все процессы (при остановке сервера). */
    public async killAll(): Promise<void> {
        await Promise.all([...this.processes.values()].map(managed => this.terminate(managed, "killed")));
    }

    private get(id: string): ManagedProcess {
        const managed = this.processes.get(id);

        if (!managed) {
            throw new Error(`Process ${id} not found (it may have finished and been removed).`);
        }

        return managed;
    }

    private spawnManaged(command: string, options: StartOptions): ManagedProcess {
        const { file, args } = this.shellFor(command);

        const child = spawn(file, args, {
            cwd: options.cwd,
            env: commandEnv(),
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            // Своя группа процессов на POSIX — чтобы убить всё дерево.
            detached: this.platform !== "win32",
        });

        const info: ProcessInfo = {
            id: randomBytes(4).toString("hex"),
            command,
            cwd: options.cwd,
            status: "running",
            exitCode: null,
            startedAt: new Date().toISOString(),
            outputLength: 0,
        };

        let resolveExit!: () => void;
        const exited = new Promise<void>(resolve => {
            resolveExit = resolve;
        });

        const managed: ManagedProcess = {
            info,
            owner: options.owner,
            child,
            buffer: "",
            bufferStart: 0,
            exited,
            listeners: new Set(options.onOutput ? [options.onOutput] : []),
        };

        const append = (text: string) => {
            if (!text) {
                return;
            }

            const chunk = stripAnsi(text).replace(/\r\n/g, "\n");

            managed.buffer += chunk;
            info.outputLength += chunk.length;

            if (managed.buffer.length > MAX_BUFFER_CHARS) {
                const drop = managed.buffer.length - MAX_BUFFER_CHARS;
                managed.buffer = managed.buffer.slice(drop);
                managed.bufferStart += drop;
            }

            for (const listener of managed.listeners) {
                listener(chunk);
            }
        };

        // Отдельный декодер на поток: многобайтовые символы UTF-8 могут разрезаться между чанками.
        const stdout = new StringDecoder("utf8");
        const stderr = new StringDecoder("utf8");

        child.stdout?.on("data", (data: Buffer) => append(stdout.write(data)));
        child.stderr?.on("data", (data: Buffer) => append(stderr.write(data)));
        child.stdout?.on("end", () => append(stdout.end()));
        child.stderr?.on("end", () => append(stderr.end()));

        child.on("error", error => {
            append(`\n[failed to start: ${error.message}]\n`);
            info.status = info.status === "running" ? "exited" : info.status;
            info.exitCode ??= -1;
            resolveExit();
        });

        child.on("close", code => {
            if (info.status === "running") {
                info.status = "exited";
            }

            info.exitCode = code;
            resolveExit();
        });

        this.processes.set(info.id, managed);

        return managed;
    }

    private async terminate(managed: ManagedProcess, status: ProcessStatus): Promise<void> {
        if (managed.info.status !== "running") {
            await managed.exited;
            return;
        }

        managed.info.status = status;
        const pid = managed.child.pid;

        if (pid !== undefined) {
            if (this.platform === "win32") {
                spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
            }
            else {
                try {
                    process.kill(-pid, "SIGTERM");
                }
                catch {
                    // группа уже завершилась
                }

                setTimeout(() => {
                    try {
                        process.kill(-pid, "SIGKILL");
                    }
                    catch {
                        // уже завершилась
                    }
                }, 2000).unref();
            }
        }

        await Promise.race([
            managed.exited,
            new Promise(resolve => setTimeout(resolve, 5000)),
        ]);
    }

    private shellFor(command: string): { file: string; args: string[] } {
        if (this.platform === "win32") {
            // UTF-8 вывод: иначе кириллица из PowerShell и нативных программ приходит в OEM-кодировке.
            const prelude = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;$ProgressPreference='SilentlyContinue';";

            // -Command сам возвращает только 0/1: пробрасываем настоящий код последней программы.
            const epilogue = "$__ok=$?; if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; if (-not $__ok) { exit 1 }; exit 0";

            return {
                file: "powershell.exe",
                args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `${prelude}\n${command}\n${epilogue}`],
            };
        }

        return { file: "/bin/bash", args: ["-c", command] };
    }
}

function commandEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};

    for (const [key, value] of Object.entries(process.env)) {
        if (!SECRET_ENV.test(key)) {
            env[key] = value;
        }
    }

    // Неинтерактивный режим для инструментов (vitest run, без цвета и спиннеров).
    env.CI = "1";
    env.NO_COLOR = "1";
    env.FORCE_COLOR = "0";
    env.TERM = "dumb";

    return env;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

export function stripAnsi(text: string): string {
    return text.replace(ANSI, "");
}
