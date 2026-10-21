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
