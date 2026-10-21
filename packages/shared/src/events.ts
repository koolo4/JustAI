import type { Message, Usage } from "./messages.js";
import type { PermissionDecision, PermissionRequest } from "./permissions.js";
import type { SessionStatus, Todo } from "./sessions.js";

/**
 * События сессии агента, передаются во фронт по WebSocket (MASTER_PLAN, раздел 5.4).
 */
export type AgentEvent =
    | { type: "session.status"; sessionId: string; status: SessionStatus; error?: string }
    | { type: "assistant.delta"; sessionId: string; text: string }
    | { type: "assistant.thinking_delta"; sessionId: string; text: string }
    | { type: "message.added"; sessionId: string; message: Message }
    | { type: "tool.started"; sessionId: string; toolUseId: string; name: string; input: unknown }
    | { type: "tool.progress"; sessionId: string; toolUseId: string; chunk: string }
    | { type: "tool.finished"; sessionId: string; toolUseId: string; isError: boolean; preview: string }
    | { type: "budget.updated"; sessionId: string; usage: Usage; steps: number }
    /** Агент изменил файл. diff — unified diff. */
    | { type: "file.changed"; sessionId: string; path: string; diff: string }
    | { type: "todo.updated"; sessionId: string; todos: Todo[] }
    | { type: "permission.request"; sessionId: string; request: PermissionRequest }
    | { type: "permission.resolved"; sessionId: string; requestId: string; decision: PermissionDecision };

export type AgentEventType = AgentEvent["type"];

export function isAgentEvent(value: unknown): value is AgentEvent {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const record = value as { type?: unknown; sessionId?: unknown };

    return typeof record.type === "string" &&
        typeof record.sessionId === "string" &&
        /^(session|assistant|message|tool|budget|file|todo|permission)\./.test(record.type);
}
