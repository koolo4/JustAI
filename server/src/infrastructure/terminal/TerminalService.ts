import { randomUUID } from "node:crypto";

import type { IPty } from "@lydell/node-pty";

import { ConflictError } from "../../core/errors/ConflictError.js";
import { NotFoundError } from "../../core/errors/NotFoundError.js";
import { safeChildEnv } from "../process/ProcessManager.js";

export interface TerminalInfo {
    id: string;
    title: string;
    alive: boolean;
}

export type TerminalEvent =
    | { type: "terminal.output"; terminalId: string; data: string }
    | { type: "terminal.exit"; terminalId: string; exitCode: number };

interface Session {
    info: TerminalInfo;
    pty: IPty;
    /** Хвост вывода: после перезагрузки страницы вкладка восстанавливает экран. */
    buffer: string;
}

const MAX_TERMINALS = 8;
const BUFFER_CHARS = 200_000;

/** Оболочка по умолчанию: JUSTAI_TERMINAL_SHELL, иначе PowerShell на Windows и $SHELL/bash в остальных системах. */
export function defaultShell(env: NodeJS.ProcessEnv = process.env): { file: string; args: string[] } {
    if (env.JUSTAI_TERMINAL_SHELL) {
        return { file: env.JUSTAI_TERMINAL_SHELL, args: [] };
    }

    return process.platform === "win32"
        ? { file: "powershell.exe", args: ["-NoLogo"] }
        : { file: env.SHELL || "/bin/bash", args: ["-l"] };
}

/**
 * Терминалы пользователя (псевдотерминал через node-pty) в папке проекта. Ключи JustAI в окружение не попадают.
 * Вывод идёт событиями по WebSocket, ввод — через REST.
 */
export class TerminalService {

    private readonly sessions = new Map<string, Session>();
    private counter = 0;

    constructor(
        private readonly workspaceRoot: string,
        private readonly emit: (event: TerminalEvent) => void,
    ) {}

    public list(): Array<TerminalInfo & { buffer: string }> {
        return [...this.sessions.values()].map(session => ({ ...session.info, buffer: session.buffer }));
    }

    public async create(cols: number, rows: number): Promise<TerminalInfo> {
        if (this.sessions.size >= MAX_TERMINALS) {
            throw new ConflictError(`At most ${MAX_TERMINALS} terminals can be open.`);
        }

        // Нативный модуль грузится только при первом терминале: старт сервера от него не зависит.
        const { spawn } = await import("@lydell/node-pty");
        const shell = defaultShell();
        const id = randomUUID();
        this.counter += 1;

        const pty = spawn(shell.file, shell.args, {
            name: "xterm-256color",
            cols: clamp(cols, 20, 500),
            rows: clamp(rows, 5, 200),
            cwd: this.workspaceRoot,
            env: { ...safeChildEnv(), TERM: "xterm-256color" } as Record<string, string>,
        });

        const session: Session = { info: { id, title: `Terminal ${this.counter}`, alive: true }, pty, buffer: "" };
        this.sessions.set(id, session);

        pty.onData(data => {
            session.buffer = (session.buffer + data).slice(-BUFFER_CHARS);
            this.emit({ type: "terminal.output", terminalId: id, data });
        });

        pty.onExit(({ exitCode }) => {
            session.info.alive = false;
            this.emit({ type: "terminal.exit", terminalId: id, exitCode });
        });

        return session.info;
    }

    public write(id: string, data: string): void {
        this.alive(id).pty.write(data);
    }

    public resize(id: string, cols: number, rows: number): void {
        this.alive(id).pty.resize(clamp(cols, 20, 500), clamp(rows, 5, 200));
    }

    public close(id: string): void {
        const session = this.sessions.get(id);

        if (!session) {
            return;
        }

        this.sessions.delete(id);

        if (session.info.alive) {
            try {
                session.pty.kill();
            }
            catch {
                // процесс уже завершился
            }
        }
    }

    public closeAll(): void {
        for (const id of [...this.sessions.keys()]) {
            this.close(id);
        }
    }

    private alive(id: string): Session {
        const session = this.sessions.get(id);

        if (!session) {
            throw new TerminalNotFoundError(id);
        }

        if (!session.info.alive) {
            throw new ConflictError("The terminal has exited. Open a new one.");
        }

        return session;
    }
}

export class TerminalNotFoundError extends NotFoundError {
    constructor(id: string) {
        super(`Terminal ${id} not found.`);
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, Math.round(Number.isFinite(value) ? value : min)));
}
