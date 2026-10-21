import { API_URL, apiFetch } from "./http";

export interface MicrosoftStatus {
    configured: boolean;
    connected: boolean;
}

export async function fetchIntegrationStatus():
Promise<MicrosoftStatus> {
    const response =
        await apiFetch(
            `/integrations/status`,
        );

    if (!response.ok) {
        throw new Error(
            "Failed to load integrations",
        );
    }

    const json =
        await response.json() as {
            microsoft: MicrosoftStatus;
        };

    return json.microsoft;
}

export function getMicrosoftConnectUrl(): string {
    return `${API_URL}/integrations/microsoft/connect`;
}

export async function disconnectMicrosoft():
Promise<void> {
    const response =
        await apiFetch(
            `/integrations/microsoft/disconnect`,
            {
                method: "POST",
            },
        );

    if (!response.ok) {
        throw new Error(
            "Failed to disconnect Microsoft",
        );
    }
}
