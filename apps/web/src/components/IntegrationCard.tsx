import { useEffect, useState } from "react";

import {
    disconnectMicrosoft,
    fetchIntegrationStatus,
    getMicrosoftConnectUrl,
    type MicrosoftStatus,
} from "../services/integrationsApi";

/**
 * Подключение Microsoft Word / OneDrive. Показывается, только если OAuth настроен на сервере.
 */
export function IntegrationCard() {
    const [microsoft, setMicrosoft] = useState<MicrosoftStatus | null>(null);

    async function refresh() {
        try {
            setMicrosoft(await fetchIntegrationStatus());
        }
        catch {
            // панель агента работает и без статуса интеграций
        }
    }

    useEffect(() => {
        void refresh();
    }, []);

    if (!microsoft?.configured) {
        return null;
    }

    return (
        <div className="integration-card">
            <div>
                <strong>Microsoft Word / OneDrive</strong>
                <div className="muted">{microsoft.connected ? "Connected" : "Not connected"}</div>
            </div>

            {microsoft.connected ? (
                <button
                    className="secondary-button"
                    onClick={() => void disconnectMicrosoft().then(refresh)}
                >
                    Disconnect
                </button>
            ) : (
                <a
                    className="secondary-button"
                    href={getMicrosoftConnectUrl()}
                    target="_blank"
                    rel="noreferrer"
                >
                    Connect
                </a>
            )}
        </div>
    );
}
