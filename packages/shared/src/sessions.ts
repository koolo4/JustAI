import type { Usage } from "./messages.js";

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
    status: SessionStatus;
    createdAt: string;
    updatedAt: string;
    usage: Usage;
    steps: number;
    /** Последняя ошибка или причина остановки. */
    lastError?: string;
}
