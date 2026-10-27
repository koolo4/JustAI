import { execFile, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export interface GitResult {
    code: number;
    stdout: Buffer;
    stderr: string;
}

export interface GitRunOptions {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
}

/**
 * Запуск git. Бинарник ищется в JUSTAI_GIT, PATH и типовых местах установки на Windows
 * (Git for Windows, GitHub Desktop).
 */
export class GitService {

    private resolved: string | null | undefined;

    constructor(
        private readonly env: NodeJS.ProcessEnv = process.env,
    ) {}

    /** Путь к git или null, если git не найден. */
    public get binary(): string | null {
        if (this.resolved === undefined) {
            this.resolved = findGit(this.env);
        }

        return this.resolved;
    }

    public get available(): boolean {
        return this.binary !== null;
    }

    public run(args: string[], options: GitRunOptions): Promise<GitResult> {
        const binary = this.binary;

        if (!binary) {
            return Promise.reject(new Error("git is not installed or not found. Install Git or set JUSTAI_GIT to the git executable."));
        }

        return new Promise((resolve, reject) => {
            execFile(
                binary,
                args,
                {
                    cwd: options.cwd,
                    env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: "0" },
                    encoding: "buffer",
                    maxBuffer: 64 * 1024 * 1024,
                    windowsHide: true,
                    ...(options.signal ? { signal: options.signal } : {}),
                },
                (error, stdout, stderr) => {
                    if (error && typeof (error as { code?: unknown }).code !== "number") {
                        reject(error);
                        return;
                    }

                    resolve({
                        code: error ? (error as { code: number }).code : 0,
                        stdout,
                        stderr: stderr.toString("utf8"),
                    });
                },
            );
        });
    }

    /** Выполняет git и возвращает stdout как текст; ненулевой код — исключение. */
    public async text(args: string[], options: GitRunOptions): Promise<string> {
        const result = await this.run(args, options);

        if (result.code !== 0) {
            throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
        }

        return result.stdout.toString("utf8");
    }
}

function findGit(env: NodeJS.ProcessEnv): string | null {
    const candidates: string[] = [];

    if (env.JUSTAI_GIT) {
        candidates.push(env.JUSTAI_GIT);
    }

    candidates.push("git");

    if (process.platform === "win32") {
        const programFiles = env.ProgramFiles ?? "C:\\Program Files";
        const localAppData = env.LOCALAPPDATA ?? "";

        candidates.push(
            path.join(programFiles, "Git", "cmd", "git.exe"),
            path.join(localAppData, "Programs", "Git", "cmd", "git.exe"),
            ...gitHubDesktopGits(localAppData),
        );
    }

    for (const candidate of candidates) {
        if (candidate !== "git" && !existsSync(candidate)) {
            continue;
        }

        const probe = spawnSync(candidate, ["--version"], { windowsHide: true, encoding: "utf8" });

        if (probe.status === 0 && probe.stdout.startsWith("git version")) {
            return candidate;
        }
    }

    return null;
}

/**
 * Если git найден не в PATH (например, только git из GitHub Desktop), его папка добавляется в PATH окружения:
 * команды агента, приложения и сценарии, запущенные JustAI, тоже видят git — иначе приложение
 * в проверке пишет «проект не под git», хотя папка — репозиторий. Возвращает добавленную папку или null.
 */
export function addGitToPath(binary: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
    if (!binary || binary === "git" || !path.isAbsolute(binary)) return null;

    const key = Object.keys(env).find(name => name.toLowerCase() === "path") ?? "PATH";
    const dir = path.dirname(binary);
    const parts = (env[key] ?? "").split(path.delimiter).filter(Boolean);

    if (parts.some(part => path.resolve(part).toLowerCase() === dir.toLowerCase())) return null;

    env[key] = [dir, ...parts].join(path.delimiter);
    return dir;
}

/** GitHub Desktop кладёт свой git в %LOCALAPPDATA%\GitHubDesktop\app-<версия>\resources\app\git. */
function gitHubDesktopGits(localAppData: string): string[] {
    const root = path.join(localAppData, "GitHubDesktop");

    try {
        return readdirSync(root)
            .filter(name => name.startsWith("app-"))
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
            .map(name => path.join(root, name, "resources", "app", "git", "cmd", "git.exe"));
    }
    catch {
        return [];
    }
}
