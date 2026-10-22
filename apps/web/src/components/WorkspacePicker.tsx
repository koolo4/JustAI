import { useEffect, useState } from "react";

import type { WorkspaceInfo } from "@justai/shared";

import { API_URL, apiFetch } from "../services/http";

async function readError(response: Response): Promise<string> {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    return body?.error?.message ?? `${response.status} ${response.statusText}`;
}

/** Ждём, пока сервер поднимется на новой папке. */
async function waitForServer(): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 500));

        try {
            if ((await fetch(`${API_URL}/health`)).ok) {
                return;
            }
        }
        catch {
            // сервер ещё перезапускается
        }
    }

    throw new Error("The server did not come back after switching folders.");
}

/**
 * Папка проекта в верхней панели: показать текущую, открыть другую или недавнюю.
 */
export function WorkspacePicker() {
    const [info, setInfo] = useState<WorkspaceInfo | null>(null);
    const [open, setOpen] = useState(false);
    const [path, setPath] = useState("");
    const [error, setError] = useState("");
    const [switching, setSwitching] = useState(false);

    useEffect(() => {
        apiFetch("/workspace/info")
            .then(async response => response.ok ? setInfo(await response.json() as WorkspaceInfo) : setError(await readError(response)))
            .catch(reason => setError(String(reason)));
    }, []);

    async function openFolder(target: string) {
        setError("");
        setSwitching(true);

        try {
            const response = await apiFetch("/workspace/open", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: target }),
            });

            if (!response.ok) {
                throw new Error(await readError(response));
            }

            await waitForServer();
            // Дерево файлов, вкладки и сессии принадлежат старой папке — проще начать с чистого листа.
            window.location.reload();
        }
        catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
            setSwitching(false);
        }
    }

    if (!info) {
        return null;
    }

    return (
        <div className="workspace-picker">
            <button
                className="workspace-current"
                title={info.root}
                onClick={() => setOpen(value => !value)}
                disabled={!info.switchable}
            >
                📁 {info.name}
            </button>

            {open && (
                <div className="workspace-popover">
                    <div className="muted workspace-root">{info.root}</div>

                    <form
                        className="workspace-form"
                        onSubmit={event => {
                            event.preventDefault();
                            void openFolder(path);
                        }}
                    >
                        <input
                            autoFocus
                            placeholder="C:\Projects\my-app"
                            value={path}
                            onChange={event => setPath(event.target.value)}
                            disabled={switching}
                        />
                        <button className="secondary-button" type="submit" disabled={switching || !path.trim()}>
                            {switching ? "Opening…" : "Open"}
                        </button>
                    </form>

                    {error && <div className="error">{error}</div>}

                    {info.recent.filter(item => item !== info.root).length > 0 && (
                        <>
                            <div className="muted workspace-recent-title">Recent</div>
                            <ul className="workspace-recent">
                                {info.recent.filter(item => item !== info.root).map(item => (
                                    <li key={item}>
                                        <button disabled={switching} onClick={() => void openFolder(item)} title={item}>
                                            {item}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
