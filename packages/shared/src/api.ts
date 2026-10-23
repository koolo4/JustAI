import type { Message } from "./messages.js";
import type { PermissionDecision, PermissionMode, PermissionRequest } from "./permissions.js";
import type { SessionSummary, Todo } from "./sessions.js";

/** REST API агента (MASTER_PLAN, раздел 5.5). */

export interface CreateSessionRequest {
    profile?: string;
    provider?: string;
    model?: string;
    mode?: PermissionMode;
    /** Для профиля «планировщик»: провайдер и модель исполнителя. */
    executorProvider?: string;
    executorModel?: string;
    verify?: boolean;
}

export interface UpdateSessionRequest {
    mode?: PermissionMode;
    verify?: boolean;
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
    /** Текущий план агента (последний todo_write). */
    todos: Todo[];
}

export interface FileChange {
    path: string;
    status: "added" | "modified" | "deleted";
}

/** Изменения рабочей папки с момента первой правки агента в сессии. */
export interface SessionChangesResponse {
    /** false — git не найден, снапшоты и откат недоступны. */
    available: boolean;
    files: FileChange[];
    diff: string;
}

export interface RevertResponse {
    files: FileChange[];
}

/** Текущая папка проекта и недавние. */
export interface WorkspaceInfo {
    root: string;
    name: string;
    recent: string[];
    /** false — папка задана JUSTAI_WORKSPACE, переключение из интерфейса выключено. */
    switchable: boolean;
}

export interface OpenWorkspaceRequest {
    path: string;
}

/** Ошибка компилятора или линтера (GET /api/workspace/diagnostics). */
export interface DiagnosticItem {
    /** Путь от корня проекта через «/». */
    path: string;
    line: number;
    column: number;
    severity: "error" | "warning";
    code?: string;
    message: string;
}

export interface DiagnosticsResponse {
    checks: Array<{ cwd: string; command: string; ok: boolean }>;
    diagnostics: DiagnosticItem[];
    /** Вывод упавших проверок, если ошибки не удалось разобрать построчно. */
    unparsed: string;
}

/** Настройка из интерфейса (переменная окружения сервера). */
export interface SettingField {
    key: string;
    label: string;
    group: string;
    /** provider — выбор из списка провайдеров; secret — значение никогда не отдаётся целиком. */
    kind: "text" | "number" | "secret" | "provider";
    placeholder?: string;
    /** Для secret — маска вида «••••abcd». */
    value: string;
    isSet: boolean;
    /** ui — задано в интерфейсе, env — в server/.env, default — не задано. */
    source: "ui" | "env" | "default";
}

export interface SettingsResponse {
    fields: SettingField[];
}

export interface UpdateSettingsRequest {
    /** null — убрать значение из интерфейса (вернётся значение из server/.env). */
    values: Record<string, string | null>;
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
