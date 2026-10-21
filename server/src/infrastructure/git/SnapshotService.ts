import { promises as fs } from "node:fs";
import path from "node:path";

import type { GitService } from "./GitService.js";

export type ChangeStatus = "added" | "modified" | "deleted";

export interface SnapshotChange {
    path: string;
    status: ChangeStatus;
}

export interface SessionChanges {
    files: SnapshotChange[];
    /** Unified diff от снапшота до текущего состояния. */
    diff: string;
}

/** Исключения теневого репозитория вдобавок к .gitignore проекта. */
const DEFAULT_EXCLUDES = [
    ".justai/",
    "node_modules/",
    ".venv/",
    "venv/",
    "__pycache__/",
    "dist/",
    "build/",
    "target/",
    ".next/",
    "coverage/",
    "*.log",
];

/**
 * Снапшоты рабочей папки в теневом git-репозитории (.justai/shadow.git).
 * Репозиторий пользователя, его индекс и ветки не затрагиваются; работает и без git в проекте.
 * Снапшот сессии — ссылка refs/justai/<sessionId> на коммит с состоянием до первой правки агента.
 */
export class SnapshotService {

    private readonly gitDir: string;

    private ready: Promise<void> | null = null;

    /** Последовательные операции: git-индексы и refs не любят параллельных записей. */
    private queue: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly git: GitService,
        private readonly workspaceRoot: string,
    ) {
        this.gitDir = path.join(workspaceRoot, ".justai", "shadow.git");
    }

    public get available(): boolean {
        return this.git.available;
    }

    /**
     * Снапшот до первой правки в сессии. Повторные вызовы ничего не делают.
     */
    public ensure(sessionId: string): Promise<void> {
        return this.serialize(async () => {
            await this.init();

            if (await this.snapshotOf(sessionId)) {
                return;
            }

            const tree = await this.captureTree("snapshot");
            const commit = (await this.shadow(
                ["commit-tree", tree, "-m", `JustAI snapshot before session ${sessionId}`],
                { GIT_AUTHOR_NAME: "JustAI", GIT_AUTHOR_EMAIL: "justai@localhost", GIT_COMMITTER_NAME: "JustAI", GIT_COMMITTER_EMAIL: "justai@localhost" },
            )).trim();

            await this.shadow(["update-ref", ref(sessionId), commit]);
        });
    }

    public async has(sessionId: string): Promise<boolean> {
        if (!this.available) {
            return false;
        }

        return this.serialize(async () => {
            await this.init();
            return (await this.snapshotOf(sessionId)) !== null;
        });
    }

    /**
     * Что изменилось в рабочей папке с момента снапшота сессии.
     */
    public changes(sessionId: string): Promise<SessionChanges> {
        return this.serialize(async () => {
            await this.init();

            const snapshot = await this.snapshotOf(sessionId);

            if (!snapshot) {
                return { files: [], diff: "" };
            }

            const current = await this.captureTree("current");
            const nameStatus = await this.shadow(["diff-tree", "-r", "--no-renames", "--name-status", "-z", snapshot, current]);
            const diff = await this.shadow(["diff-tree", "-r", "--no-renames", "-p", "--no-color", snapshot, current]);

            return { files: parseNameStatus(nameStatus), diff };
        });
    }

    /**
     * Возвращает файлы к состоянию снапшота: изменённые и удалённые восстанавливаются,
     * созданные после снапшота — удаляются. Возвращает список затронутых файлов.
     */
    public revert(sessionId: string): Promise<SnapshotChange[]> {
        return this.serialize(async () => {
            await this.init();

            const snapshot = await this.snapshotOf(sessionId);

            if (!snapshot) {
                return [];
            }

            const current = await this.captureTree("current");
            const changes = parseNameStatus(
                await this.shadow(["diff-tree", "-r", "--no-renames", "--name-status", "-z", snapshot, current]),
            );

            for (const change of changes) {
                const absolute = path.join(this.workspaceRoot, ...change.path.split("/"));

                if (change.status === "added") {
                    await fs.rm(absolute, { force: true });
                    await this.removeEmptyParents(path.dirname(absolute));
                    continue;
                }

                const blob = await this.git.run(
                    ["--git-dir", this.gitDir, "show", `${snapshot}:${change.path}`],
                    { cwd: this.workspaceRoot },
                );

                if (blob.code !== 0) {
                    throw new Error(`Cannot restore ${change.path}: ${blob.stderr.trim()}`);
                }

                await fs.mkdir(path.dirname(absolute), { recursive: true });
                await fs.writeFile(absolute, blob.stdout);
            }

            return changes;
        });
    }

    /** Забыть снапшот (изменения приняты). */
    public discard(sessionId: string): Promise<void> {
        return this.serialize(async () => {
            await this.init();

            if (await this.snapshotOf(sessionId)) {
                await this.shadow(["update-ref", "-d", ref(sessionId)]);
            }
        });
    }

    /**
     * Папки, созданные вместе с файлом, после удаления файла остаются пустыми — убираем их.
     * (git не хранит пустые папки, поэтому отличить «была пустой» нельзя; такие случаи редки.)
     */
    private async removeEmptyParents(directory: string): Promise<void> {
        let current = directory;

        while (current !== this.workspaceRoot && current.startsWith(this.workspaceRoot)) {
            try {
                await fs.rmdir(current);
            }
            catch {
                return;
            }

            current = path.dirname(current);
        }
    }

    private async init(): Promise<void> {
        this.ready ??= (async () => {
            try {
                await fs.access(path.join(this.gitDir, "HEAD"));
            }
            catch {
                await fs.mkdir(this.gitDir, { recursive: true });
                await this.git.text(["init", "--bare", "--quiet", this.gitDir], { cwd: this.workspaceRoot });
                await this.shadow(["config", "core.autocrlf", "false"]);
                await this.shadow(["config", "core.quotepath", "false"]);
            }

            await fs.mkdir(path.join(this.gitDir, "info"), { recursive: true });
            await fs.writeFile(path.join(this.gitDir, "info", "exclude"), `${DEFAULT_EXCLUDES.join("\n")}\n`, "utf8");
        })();

        try {
            await this.ready;
        }
        catch (error) {
            this.ready = null;
            throw error;
        }
    }

    /** Дерево текущего состояния рабочей папки через отдельный индекс-файл. */
    private async captureTree(indexName: string): Promise<string> {
        const env = { GIT_INDEX_FILE: path.join(this.gitDir, `index-${indexName}`) };

        await this.shadow(["add", "--all"], env, true);
        return (await this.shadow(["write-tree"], env)).trim();
    }

    private async snapshotOf(sessionId: string): Promise<string | null> {
        const result = await this.git.run(
            ["--git-dir", this.gitDir, "rev-parse", "--verify", "--quiet", ref(sessionId)],
            { cwd: this.workspaceRoot },
        );

        return result.code === 0 ? result.stdout.toString("utf8").trim() : null;
    }

    private shadow(args: string[], env: NodeJS.ProcessEnv = {}, withWorkTree = false): Promise<string> {
        const prefix = ["--git-dir", this.gitDir];

        if (withWorkTree) {
            prefix.push("--work-tree", this.workspaceRoot);
        }

        return this.git.text([...prefix, ...args], { cwd: this.workspaceRoot, env });
    }

    private serialize<T>(action: () => Promise<T>): Promise<T> {
        const next = this.queue.then(action, action);
        this.queue = next.catch(() => undefined);
        return next;
    }
}

function ref(sessionId: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) {
        throw new Error(`Invalid session id: ${sessionId}`);
    }

    return `refs/justai/${sessionId}`;
}

function parseNameStatus(output: string): SnapshotChange[] {
    const parts = output.split("\0").filter(Boolean);
    const changes: SnapshotChange[] = [];

    for (let i = 0; i + 1 < parts.length; i += 2) {
        const code = parts[i]!;
        const file = parts[i + 1]!;

        changes.push({
            path: file,
            status: code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified",
        });
    }

    return changes;
}
