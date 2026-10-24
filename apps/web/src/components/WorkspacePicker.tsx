import { useEffect, useState } from "react";

import type { WorkspaceInfo } from "@justai/shared";

import { apiFetch, readApiError as readError, waitForServer } from "../services/http";
import { socketBus } from "../services/socket";

/**
 * Папка проекта в верхней панели: показать текущую, открыть другую или недавнюю.
 */
export function WorkspacePicker() {
    const [info, setInfo] = useState<WorkspaceInfo | null>(null);
    const [open, setOpen] = useState(false);
    const [path, setPath] = useState("");
    const [error, setError] = useState("");
    const [switching, setSwitching] = useState(false);
    // Новый проект: пустой (папка + git) или клон репозитория GitHub.
    const [creating, setCreating] = useState(false);
    const [parent, setParent] = useState("");
    const [name, setName] = useState("");
    const [repo, setRepo] = useState("");
    const [useForBridge, setUseForBridge] = useState(true);

    useEffect(() => {
        apiFetch("/workspace/info")
            .then(async response => response.ok ? setInfo(await response.json() as WorkspaceInfo) : setError(await readError(response)))
            .catch(reason => setError(String(reason)));
    }, []);

    // Папку могли сменить в другой вкладке или через API: после переподключения сверяемся с сервером.
    // Иначе открытая сессия и дерево файлов остаются от старого проекта, а ответы агента не видны.
    useEffect(() => {
        let wasOpen = true;

        return socketBus.onStatus(status => {
            if (status === "open" && !wasOpen && info) {
                apiFetch("/workspace/info")
                    .then(async response => {
                        const current = response.ok ? await response.json() as WorkspaceInfo : null;

                        if (current && current.root !== info.root) {
                            window.location.reload();
                        }
                    })
                    .catch(() => undefined);
            }

            wasOpen = status === "open";
        });
    }, [info]);

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

    async function createProject() {
        setError("");
        setSwitching(true);

        try {
            const response = await apiFetch("/workspace/create", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    parent: parent.trim() || parentOf(info?.root ?? ""),
                    name: name.trim() || repo.trim().split("/").pop() || "",
                    ...(repo.trim() ? { repo: repo.trim(), bridge: useForBridge } : {}),
                }),
            });

            if (!response.ok) {
                throw new Error(await readError(response));
            }

            await waitForServer();
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

                    {!creating && (
                        <button type="button" className="link-button workspace-new-toggle" onClick={() => setCreating(true)} disabled={switching}>
                            ＋ Новый проект
                        </button>
                    )}

                    {creating && (
                        <form
                            className="workspace-create"
                            onSubmit={event => {
                                event.preventDefault();
                                void createProject();
                            }}
                        >
                            <strong>Новый проект</strong>
                            <label>
                                <span className="muted">Где создать</span>
                                <input value={parent} placeholder={parentOf(info.root)} onChange={event => setParent(event.target.value)} disabled={switching} />
                            </label>
                            <label>
                                <span className="muted">Название папки</span>
                                <input value={name} placeholder={repo.split("/").pop() || "my-app"} onChange={event => setName(event.target.value)} disabled={switching} />
                            </label>
                            <label>
                                <span className="muted">Репозиторий GitHub (владелец/имя) — необязательно: пусто — пустой проект с git</span>
                                <input value={repo} placeholder="koolo4/new-site" onChange={event => setRepo(event.target.value)} disabled={switching} />
                            </label>
                            {repo.trim() && (
                                <label className="checkbox-label">
                                    <input type="checkbox" checked={useForBridge} onChange={event => setUseForBridge(event.target.checked)} disabled={switching} />
                                    <span className="muted">Брать задачи моста GitHub из этого репозитория</span>
                                </label>
                            )}
                            {repo.trim() && (
                                <p className="muted workspace-hint">
                                    Репозиторий сначала создайте на GitHub (с README) и дайте к нему доступ токену
                                    (GitHub → Settings → Developer settings → Fine-grained tokens → ваш токен → Repository access).
                                    Для открытого репозитория включите «Разрешить публичный репозиторий» в ⚙ Настройки → GitHub.
                                </p>
                            )}
                            <div className="workspace-create-actions">
                                <button className="secondary-button" type="submit" disabled={switching || (!name.trim() && !repo.trim())}>
                                    {switching ? "Создаю…" : repo.trim() ? "Клонировать и открыть" : "Создать и открыть"}
                                </button>
                                <button type="button" className="link-button" onClick={() => setCreating(false)} disabled={switching}>отмена</button>
                            </div>
                        </form>
                    )}

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

/** Папка, в которой лежит текущий проект — по умолчанию новый создаётся рядом. */
function parentOf(root: string): string {
    const parts = root.split(/[\\/]+/).filter(Boolean);
    if (parts.length <= 1) return root;
    const separator = root.includes("\\") ? "\\" : "/";
    return `${root.startsWith("/") ? "/" : ""}${parts.slice(0, -1).join(separator)}`;
}
