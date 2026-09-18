export type CouncilProviderId = "chatgpt" | "claude" | "deepseek";

export interface CouncilProviderStatus {
    id: CouncilProviderId;
    label: string;
    url: string;
    connected: boolean;
    open: boolean;
    message?: string;
}

export interface CouncilOpinion {
    provider: CouncilProviderId;
    role: string;
    answer: string;
    durationMs: number;
}

export interface CouncilRunResponse {
    opinions: CouncilOpinion[];
    chair: CouncilOpinion;
    executionPolicy: string;
}

const BASE = "http://localhost:4302/api/ai/council";

export async function fetchCouncilStatus(): Promise<CouncilProviderStatus[]> {
    const response = await fetch(`${BASE}/status`);
    const json = await response.json() as { providers?: CouncilProviderStatus[]; error?: string };
    if (!response.ok) throw new Error(json.error ?? `Council status failed: ${response.status}`);
    return json.providers ?? [];
}

export async function connectCouncilProvider(provider: CouncilProviderId): Promise<CouncilProviderStatus> {
    const response = await fetch(`${BASE}/connect/${provider}`, { method: "POST" });
    const json = await response.json() as CouncilProviderStatus & { error?: string };
    if (!response.ok) throw new Error(json.error ?? `Could not open ${provider}`);
    return json;
}

export async function runCouncil(request: {
    prompt: string;
    providers: CouncilProviderId[];
    chair: CouncilProviderId;
    roles?: Partial<Record<CouncilProviderId, string>>;
    projectContext?: string;
    activeFile?: string;
    activeContent?: string;
}): Promise<CouncilRunResponse> {
    const response = await fetch(`${BASE}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
    });
    const json = await response.json() as CouncilRunResponse & { error?: string };
    if (!response.ok) throw new Error(json.error ?? `Council failed: ${response.status}`);
    return json;
}
