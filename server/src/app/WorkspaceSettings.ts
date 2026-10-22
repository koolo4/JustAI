import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { BadRequestError } from "../core/errors/BadRequestError.js";

const MAX_RECENT = 10;

interface StoredSettings {
    current?: string;
    recent: string[];
}

/**
 * Какую папку агент сейчас считает проектом и какие открывались недавно.
 * Хранится в `.justai/workspace.json` папки установки JustAI (не в проекте пользователя).
 */
export class WorkspaceSettings {

    private readonly file: string;

    constructor(
        /** Папка установки JustAI: проект по умолчанию и место хранения настроек. */
        public readonly installRoot: string,
        private readonly env: NodeJS.ProcessEnv = process.env,
    ) {
        this.file = path.join(installRoot, ".justai", "workspace.json");
    }

    /** JUSTAI_WORKSPACE фиксирует папку: переключение из интерфейса выключено. */
    public get fixedByEnv(): boolean {
        return Boolean(this.env.JUSTAI_WORKSPACE);
    }

    /** Папка проекта: JUSTAI_WORKSPACE, иначе последняя открытая (если она ещё существует), иначе папка установки. */
    public currentRoot(): string {
        if (this.env.JUSTAI_WORKSPACE) {
            return path.resolve(this.env.JUSTAI_WORKSPACE);
        }

        const current = this.read().current;
        return current && isDirectory(current) ? current : this.installRoot;
    }

    /** Недавние папки; папка установки — всегда последней, чтобы к ней можно было вернуться. */
    public recent(): string[] {
        const recent = this.read().recent.filter(isDirectory);

        return recent.some(item => samePath(item, this.installRoot))
            ? recent
            : [...recent, this.installRoot];
    }

    /**
     * Проверяет папку и запоминает её как текущую. Возвращает нормализованный путь.
     */
    public open(target: string): string {
        if (this.fixedByEnv) {
            throw new BadRequestError("The project folder is fixed by JUSTAI_WORKSPACE in server/.env.");
        }

        const root = validateProjectFolder(target);
        const stored = this.read();

        this.write({
            current: root,
            recent: [root, ...stored.recent.filter(item => !samePath(item, root))].slice(0, MAX_RECENT),
        });

        return root;
    }

    private read(): StoredSettings {
        try {
            const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<StoredSettings>;

            return {
                ...(typeof parsed.current === "string" ? { current: parsed.current } : {}),
                recent: Array.isArray(parsed.recent) ? parsed.recent.filter((item): item is string => typeof item === "string") : [],
            };
        }
        catch {
            return { recent: [] };
        }
    }

    private write(settings: StoredSettings): void {
        mkdirSync(path.dirname(this.file), { recursive: true });
        writeFileSync(this.file, JSON.stringify(settings, null, 2), "utf8");
    }
}

/**
 * Папка проекта: абсолютный путь к существующей папке, не корень диска и не служебная папка JustAI.
 */
export function validateProjectFolder(target: string): string {
    const trimmed = target.trim().replace(/^"(.*)"$/, "$1");

    if (!trimmed || !path.isAbsolute(trimmed)) {
        throw new BadRequestError("Enter the full path to a folder, for example C:\\Projects\\my-app.");
    }

    const root = path.resolve(trimmed);

    if (path.dirname(root) === root) {
        throw new BadRequestError("A whole drive cannot be a project folder. Choose a folder inside it.");
    }

    if (root.split(path.sep).some(part => part.toLowerCase() === ".justai")) {
        throw new BadRequestError("The .justai folder holds JustAI's own state and cannot be a project.");
    }

    if (!isDirectory(root)) {
        throw new BadRequestError(`Folder not found: ${root}`);
    }

    return root;
}

function isDirectory(target: string): boolean {
    try {
        return existsSync(target) && statSync(target).isDirectory();
    }
    catch {
        return false;
    }
}

function samePath(a: string, b: string): boolean {
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
