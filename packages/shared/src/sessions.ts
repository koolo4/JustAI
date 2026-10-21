import type { Usage } from "./messages.js";
import type { PermissionMode } from "./permissions.js";

export type SessionStatus =
    | "idle"
    | "running"
    | "completed"
    | "stopped"
    | "failed";

export interface SessionSummary {
    id: string;
    title: string;
    profile: string;
    provider: string;
    model: string;
    mode: PermissionMode;
    /** Исполнитель для профиля «планировщик» (delegate_task). */
    executor?: ExecutorConfig;
    /** Автоматически запускать проверки проекта после правок (по умолчанию да). */
    verify?: boolean;
    status: SessionStatus;
    createdAt: string;
    updatedAt: string;
    usage: Usage;
    steps: number;
    /** Последняя ошибка или причина остановки. */
    lastError?: string;
}

/** Пункт плана, который ведёт агент (инструмент todo_write). */
export interface Todo {
    content: string;
    status: "pending" | "in_progress" | "completed";
}

export interface ExecutorConfig {
    provider: string;
    model: string;
}

export interface VerificationCheck {
    /** Папка проекта относительно workspace. */
    cwd: string;
    command: string;
    ok: boolean;
    exitCode: number | null;
    /** Почему проверка не запускалась (например, пользователь не разрешил). */
    skipped?: string;
}
