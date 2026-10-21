/**
 * Разрешения на действия агента (MASTER_PLAN, раздел 6.2).
 *
 * ask        — подтверждать запись файлов, команды и сеть;
 * auto-edit  — файлы и безопасные команды без вопросов, остальные команды и сеть — с подтверждением;
 * full-auto  — всё без вопросов, кроме опасных команд и сети.
 */
export type PermissionMode = "ask" | "auto-edit" | "full-auto";

export const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "auto-edit", "full-auto"];

export type PermissionDecision = "allow" | "allow_always" | "deny";

export interface PermissionRequest {
    requestId: string;
    sessionId: string;
    toolUseId: string;
    tool: string;
    input: unknown;
    /** Коротко, что будет сделано: команда или путь. */
    summary: string;
    /** Почему требуется подтверждение. */
    reason: string;
    /** Опасное действие: «разрешить всегда» действует только один раз. */
    dangerous: boolean;
    createdAt: string;
}
