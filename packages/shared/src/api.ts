import type { Message } from "./messages.js";
import type { PermissionDecision, PermissionMode, PermissionRequest } from "./permissions.js";
import type { SessionSummary } from "./sessions.js";

/** REST API агента (MASTER_PLAN, раздел 5.5). */

export interface CreateSessionRequest {
    profile?: string;
    provider?: string;
    model?: string;
    mode?: PermissionMode;
}

export interface UpdateSessionRequest {
    mode: PermissionMode;
}

export interface ResolvePermissionRequest {
    decision: PermissionDecision;
    /** Пояснение для агента при отказе. */
    note?: string;
}

export interface CreateSessionResponse {
    session: SessionSummary;
}

export interface SendMessageRequest {
    text: string;
    /** Файл, открытый в редакторе, — подсказка агенту, с чего начать. */
    activeFile?: string;
}

export interface SessionDetails {
    session: SessionSummary;
    messages: Message[];
    pendingPermissions: PermissionRequest[];
}

export interface SessionListResponse {
    sessions: SessionSummary[];
}

export interface ProviderInfo {
    id: string;
    label: string;
    configured: boolean;
    model: string;
}

export interface ProviderListResponse {
    providers: ProviderInfo[];
    defaultProvider: string;
}

export interface AgentProfileInfo {
    id: string;
    label: string;
    description: string;
    tools: string[];
}

export interface AgentProfileListResponse {
    profiles: AgentProfileInfo[];
}

export interface ApiErrorBody {
    success: false;
    error: {
        code: string;
        message: string;
    };
}
