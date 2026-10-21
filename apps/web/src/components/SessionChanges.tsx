import { useEffect, useState } from "react";

import type { SessionChangesResponse } from "@justai/shared";

import { fetchSessionChanges, revertSession } from "../services/agentApi";

/**
 * Изменения файлов за сессию (с момента первой правки агента) и откат.
 * Полноценный DiffReview с откатом по файлам — задача P4-03.
 */
export function SessionChanges({
    sessionId,
    refreshKey,
    disabled,
}: {
    sessionId: string;
    /** Меняется, когда стоит перечитать изменения (например, агент закончил работу). */
    refreshKey: string;
    disabled: boolean;
}) {
    const [changes, setChanges] = useState<SessionChangesResponse | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (disabled) {
            return;
        }

        fetchSessionChanges(sessionId)
            .then(setChanges)
            .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
    }, [sessionId, refreshKey, disabled]);

    if (!changes?.available || changes.files.length === 0) {
        return null;
    }

    async function revert() {
        if (!window.confirm(`Revert ${changes!.files.length} file(s) to their state before this session's first change?`)) {
            return;
        }

        try {
            setBusy(true);
            await revertSession(sessionId);
            setChanges(await fetchSessionChanges(sessionId));
        }
        catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        }
        finally {
            setBusy(false);
        }
    }

    return (
        <details className="session-changes">
            <summary>
                <strong>Changes in this session</strong>
                <span className="muted">{changes.files.length} file(s)</span>
            </summary>

            <ul className="change-list">
                {changes.files.map(file => (
                    <li key={file.path}>
                        <span className={`change-status ${file.status}`}>{file.status[0]!.toUpperCase()}</span>
                        {file.path}
                    </li>
                ))}
            </ul>

            <pre className="tool-detail">{changes.diff.length > 20_000 ? `${changes.diff.slice(0, 20_000)}\n…` : changes.diff}</pre>

            {error && <div className="error">{error}</div>}

            <div className="permission-actions">
                <button className="deny-button" onClick={() => void revert()} disabled={busy || disabled}>
                    {busy ? "Reverting…" : "Revert all"}
                </button>
            </div>
        </details>
    );
}
