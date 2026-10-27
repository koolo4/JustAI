import { execFile } from "node:child_process";

export type ExecFile = (file: string, args: string[]) => Promise<{ code: number }>;

const runFile: ExecFile = (file, args) => new Promise(resolve => {
    execFile(file, args, { windowsHide: true, timeout: 15_000 }, error => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
        resolve({ code });
    });
});

/**
 * Перезапуск зависшей модели Ollama: завершается только процесс, в котором загружена модель
 * (llama-server.exe; в старых версиях — ollama_llama_server.exe или «ollama runner»), сама Ollama остаётся
 * и при следующем запросе загружает модель заново (~10 с). Так лечится зависание, при котором модель
 * «загружена на 100% GPU», а запросы ждут без конца при простаивающей видеокарте (kaitos #143, 27.10.2026).
 * true — процесс был и завершён.
 */
export async function restartOllamaRunner(platform: NodeJS.Platform = process.platform, exec: ExecFile = runFile): Promise<boolean> {
    if (platform === "win32") {
        let killed = false;

        for (const image of ["llama-server.exe", "ollama_llama_server.exe"]) {
            if ((await exec("taskkill", ["/F", "/IM", image])).code === 0) killed = true;
        }

        return killed;
    }

    const runner = await exec("pkill", ["-f", "ollama runner"]);
    const server = await exec("pkill", ["-x", "llama-server"]);
    return runner.code === 0 || server.code === 0;
}

/** Адрес Ollama на этом компьютере: перезапускать процесс можно только у своей, не у удалённой. */
export function isLocalOllama(baseUrl: string | undefined): boolean {
    if (!baseUrl) return true;

    try {
        return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(baseUrl).hostname);
    }
    catch {
        return false;
    }
}
