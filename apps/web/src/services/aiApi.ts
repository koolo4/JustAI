import { apiFetch } from "./http";

export interface AIRequest {

    prompt: string;

    provider?: string;

    agent?: string;

    activeFile: string;

    activeContent: string;

    openedFiles: string[];

    projectTree: unknown;

}

export interface AIProviderInfo {

    id: string;

    label: string;

    configured: boolean;

    model: string;

}

export interface AIAgentInfo {

    id: string;

    label: string;

    description: string;

}


export async function askAI(
    context: AIRequest,
): Promise<string> {
    const response = await apiFetch(
        `/ai/chat`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(context),
        },
    );

    if (!response.ok) {
        const text = await response.text();
        throw new Error(
            text || "AI request failed",
        );
    }

    const json =
        await response.json() as {
            answer: string;
        };

    return json.answer;
}

export async function fetchAIProviders():
Promise<AIProviderInfo[]> {
    const response =
        await apiFetch(
            `/ai/providers`,
        );

    if (!response.ok) {
        throw new Error(
            "Failed to load AI providers",
        );
    }

    const json =
        await response.json() as {
            providers: AIProviderInfo[];
        };

    return json.providers;
}

export async function fetchAIAgents():
Promise<AIAgentInfo[]> {
    const response =
        await apiFetch(
            `/ai/agents`,
        );

    if (!response.ok) {
        throw new Error(
            "Failed to load AI agents",
        );
    }

    const json =
        await response.json() as {
            agents: AIAgentInfo[];
        };

    return json.agents;
}
