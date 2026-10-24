import { spawn, type ChildProcess } from "node:child_process";

/**
 * Не даёт компьютеру уснуть, пока идёт работа (задача из GitHub, команда, слияние).
 * Windows — SetThreadExecutionState в отдельном PowerShell (снимается, когда процесс завершается; экран при этом
 * не гаснет — иначе ноутбук с Modern Standby засыпает), macOS — caffeinate, Linux — systemd-inhibit.
 * Закрытие крышки и выключение вручную это не отменяет — это настройки электропитания.
 * Процесс-помощник сам завершается, если JustAI упал (следит за PID родителя).
 */
export class KeepAwake {

    private holders = 0;
    private child?: ChildProcess;

    constructor(
        private readonly options: {
            platform?: NodeJS.Platform;
            /** Для тестов: запуск процесса-помощника. */
            spawner?: (command: string, args: string[]) => ChildProcess;
            log?: (message: string) => void;
        } = {},
    ) {}

    public get active(): boolean {
        return this.holders > 0;
    }

    /** Держать компьютер бодрым до вызова возвращённой функции (повторный вызов ничего не делает). */
    public acquire(): () => void {
        this.holders += 1;

        if (this.holders === 1) {
            this.start();
        }

        let released = false;

        return () => {
            if (released) return;
            released = true;
            this.holders = Math.max(0, this.holders - 1);

            if (this.holders === 0) {
                this.stop();
            }
        };
    }

    public dispose(): void {
        this.holders = 0;
        this.stop();
    }

    private start(): void {
        const command = keepAwakeCommand(this.options.platform ?? process.platform, process.pid);

        if (!command) return;

        try {
            const spawner = this.options.spawner ?? ((file, args) => spawn(file, args, { stdio: "ignore", windowsHide: true }));
            const child = spawner(command.file, command.args);
            child.on("error", error => {
                this.options.log?.(`[keep-awake] ${error.message}`);
                if (this.child === child) this.child = undefined;
            });
            child.on("exit", () => {
                if (this.child === child) this.child = undefined;
            });
            this.child = child;
        }
        catch (error) {
            this.options.log?.(`[keep-awake] ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private stop(): void {
        const child = this.child;
        this.child = undefined;

        if (child && child.exitCode === null && !child.killed) {
            child.kill();
        }
    }
}

/** Команда, которая держит систему бодрой, пока жива (и пока жив процесс parentPid). */
export function keepAwakeCommand(platform: NodeJS.Platform, parentPid: number): { file: string; args: string[] } | null {
    if (platform === "win32") {
        // ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED = 0x80000003. Экран тоже держим включённым:
        // на ноутбуках с «современным ждущим режимом» (S0 Low Power Idle) погасший экран сразу усыпляет систему,
        // и одного ES_SYSTEM_REQUIRED недостаточно (так мост молчал 34 минуты). Повторяется каждые 30 с.
        const script = [
            "$sig = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint flags);'",
            "$api = Add-Type -MemberDefinition $sig -Name Power -Namespace JustAI -PassThru",
            `while (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue) {`,
            "  [void]$api::SetThreadExecutionState([uint32]2147483651)",
            "  Start-Sleep -Seconds 30",
            "}",
        ].join("\n");

        return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", script] };
    }

    if (platform === "darwin") {
        return { file: "caffeinate", args: ["-i", "-w", String(parentPid)] };
    }

    if (platform === "linux") {
        return {
            file: "systemd-inhibit",
            args: ["--what=idle:sleep", "--who=JustAI", "--why=JustAI is working on a task", "tail", `--pid=${parentPid}`, "-f", "/dev/null"],
        };
    }

    return null;
}

/** JUSTAI_KEEP_AWAKE: task (по умолчанию — пока идёт задача), always (пока включён мост), off. */
export function keepAwakeModeFromEnv(value: string | undefined): "task" | "always" | "off" {
    return value === "off" || value === "always" ? value : "task";
}
