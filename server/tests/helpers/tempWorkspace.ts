import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface TempWorkspace {
    root: string;
    write(relativePath: string, content?: string): Promise<string>;
    dispose(): Promise<void>;
}

/**
 * Создаёт временную папку-workspace, которую тест обязан удалить через dispose().
 */
export async function createTempWorkspace(): Promise<TempWorkspace> {
    const root = await mkdtemp(path.join(os.tmpdir(), "justai-test-"));

    return {
        root,
        async write(relativePath, content = "") {
            const absolute = path.join(root, relativePath);
            await mkdir(path.dirname(absolute), { recursive: true });
            await writeFile(absolute, content, "utf8");
            return absolute;
        },
        async dispose() {
            await rm(root, { recursive: true, force: true });
        },
    };
}
