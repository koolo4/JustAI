import type {
    AgentProfileListResponse,
    ApiErrorBody,
    CreateSessionRequest,
    CreateSessionResponse,
    ProviderListResponse,
    ResolvePermissionRequest,
    RevertResponse,
    SessionChangesResponse,
    SendMessageRequest,
    UpdateSessionRequest,
    SessionDetails,
    SessionListResponse,
    SessionSummary,
} from "@justai/shared";

import { apiFetch } from "./http";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await apiFetch(path, {
        ...init,
        headers: {
            "Content-Type": "application/json",
            ...init?.headers,
        },
    });

    if (!response.ok) {
        let message = `${response.status} ${response.statusText}`;

        try {
            const body = await response.json() as Partial<ApiErrorBody>;
            message = body.error?.message ?? message;
        }
        catch {
            // тело не JSON — оставляем статус
        }

        throw new Error(message);
    }

    return response.json() as Promise<T>;
}

export function fetchProviders(): Promise<ProviderListResponse> {
    return request("/agent/providers");
}

export function fetchProfiles(): Promise<AgentProfileListResponse> {
    return request("/agent/profiles");
}

export async function fetchSessions(): Promise<SessionSummary[]> {
    return (await request<SessionListResponse>("/agent/sessions")).sessions;
}

export async function createSession(body: CreateSessionRequest): Promise<SessionSummary> {
    const response = await request<CreateSessionResponse>("/agent/sessions", {
        method: "POST",
        body: JSON.stringify(body),
    });

    return response.session;
}

export function fetchSession(id: string): Promise<SessionDetails> {
    return request(`/agent/sessions/${encodeURIComponent(id)}`);
}

export async function sendMessage(id: string, body: SendMessageRequest): Promise<SessionSummary> {
    const response = await request<{ session: SessionSummary }>(
        `/agent/sessions/${encodeURIComponent(id)}/messages`,
        { method: "POST", body: JSON.stringify(body) },
    );

    return response.session;
}

export async function updateSession(id: string, body: UpdateSessionRequest): Promise<SessionSummary> {
    const response = await request<{ session: SessionSummary }>(
        `/agent/sessions/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(body) },
    );

    return response.session;
}

export async function resolvePermission(
    id: string,
    requestId: string,
    body: ResolvePermissionRequest,
): Promise<void> {
    const response = await apiFetch(
        `/agent/sessions/${encodeURIComponent(id)}/permissions/${encodeURIComponent(requestId)}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        },
    );

    if (!response.ok) {
        const body = await response.json().catch(() => null) as Partial<ApiErrorBody> | null;
        throw new Error(body?.error?.message ?? `${response.status} ${response.statusText}`);
    }
}

export function fetchSessionChanges(id: string): Promise<SessionChangesResponse> {
    return request(`/agent/sessions/${encodeURIComponent(id)}/changes`);
}

export function revertSession(id: string): Promise<RevertResponse> {
    return request(`/agent/sessions/${encodeURIComponent(id)}/revert`, { method: "POST" });
}

export async function stopSession(id: string): Promise<SessionSummary> {
    const response = await request<{ session: SessionSummary }>(
        `/agent/sessions/${encodeURIComponent(id)}/stop`,
        { method: "POST" },
    );

    return response.session;
}
