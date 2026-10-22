import { useEffect, useMemo, useState } from "react";

import type { FileChange, SessionChangesResponse } from "@justai/shared";

import { acceptSession, fetchSessionChanges, revertSession } from "../../services/agentApi";
import { parseUnifiedDiff, type FileDiff } from "./parseUnifiedDiff";

interface Props {
    sessionId: string;
    sessionTitle: string;
    /** Агент работает — откат недоступен. */
    busy: boolean;
    onOpenFile(path: string): void;
    onClose(): void;
}

/**
 * Обзор изменений сессии: файлы, цветной дифф по каждому, откат всего.
 */
export function DiffReview({ sessionId, sessionTitle, busy, onOpenFile, onClose }: Props) {
    const [changes, setChanges] = useState<SessionChangesResponse | null>(null);
    const [selected, setSelected] = useState<string>("");
    const [error, setError] = useState("");
    const [reverting, setReverting] = useState(false);

    const load = () => {
        fetchSessionChanges(sessionId)
            .then(result => {
                setChanges(result);
                setSelected(current => result.files.some(file => file.path === current) ? current : result.files[0]?.path ?? "");
            })
            .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
    };

    useEffect(load, [sessionId]);

    const diffs = useMemo(() => new Map(parseUnifiedDiff(changes?.diff ?? "").map(file => [file.path, file])), [changes?.diff]);
    const current = diffs.get(selected);
    const status = changes?.files.find(file => file.path === selected);

    async function act(question: string, action: () => Promise<unknown>) {
        if (!window.confirm(question)) {
            return;
        }

        try {
            setReverting(true);
            setError("");
            await action();
            load();
        }
        catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        }
        finally {
            setReverting(false);
        }
    }

    const revertAll = () => act(
        `Revert all ${changes?.files.length ?? 0} file(s) changed in this session?`,
        () => revertSession(sessionId),
    );

    const revertFile = (path: string) => act(
        `Revert ${path} to its state before this session's first change?`,
        () => revertSession(sessionId, [path]),
    );

    const acceptAll = () => act(
        "Accept all changes? They will stay as they are and can no longer be reverted from JustAI.",
        () => acceptSession(sessionId),
    );

    return (
        <div className="diff-review">
            <div className="diff-header">
                <div>
                    <strong>Changes</strong>
                    <span className="muted"> — {sessionTitle}</span>
                </div>
                <div className="diff-actions">
                    <button className="secondary-button" onClick={load}>Refresh</button>
                    <button
                        className="allow-button"
                        disabled={busy || reverting || !changes?.files.length}
                        title={busy ? "Stop the agent first" : "Keep all changes and forget the session snapshot"}
                        onClick={() => void acceptAll()}
                    >
                        Accept all
                    </button>
                    <button
                        className="deny-button"
                        disabled={busy || reverting || !changes?.files.length}
                        title={busy ? "Stop the agent first" : "Restore all files to their state before the session's first change"}
                        onClick={() => void revertAll()}
                    >
                        {reverting ? "Reverting…" : "Revert all"}
                    </button>
                    <button className="secondary-button" onClick={onClose}>Close</button>
                </div>
            </div>

            {error && <div className="error">{error}</div>}

            {changes && !changes.available && (
                <div className="notice">Git was not found on this computer, so changes cannot be tracked or reverted.</div>
            )}

            {changes?.available && changes.files.length === 0 && (
                <div className="diff-empty muted">No changes in this session yet.</div>
            )}

            {changes && changes.files.length > 0 && (
                <div className="diff-body">
                    <ul className="diff-files">
                        {changes.files.map(file => (
                            <FileRow
                                key={file.path}
                                file={file}
                                diff={diffs.get(file.path)}
                                selected={file.path === selected}
                                onSelect={() => setSelected(file.path)}
                            />
                        ))}
                    </ul>

                    <div className="diff-view">
                        {status && (
                            <div className="diff-file-header">
                                <code>{status.path}</code>
                                <div className="diff-actions">
                                    {status.status !== "deleted" && (
                                        <button className="secondary-button" onClick={() => onOpenFile(status.path)}>Open in editor</button>
                                    )}
                                    <button
                                        className="deny-button"
                                        disabled={busy || reverting}
                                        onClick={() => void revertFile(status.path)}
                                    >
                                        Revert file
                                    </button>
                                </div>
                            </div>
                        )}

                        {current?.binary && <div className="muted">Binary file.</div>}

                        {current && !current.binary && (
                            <table className="diff-table">
                                <tbody>
                                    {current.lines.map((line, index) => (
                                        <tr key={index} className={`diff-line ${line.kind}`}>
                                            <td className="diff-num">{line.oldNumber ?? ""}</td>
                                            <td className="diff-num">{line.newNumber ?? ""}</td>
                                            <td className="diff-sign">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : ""}</td>
                                            <td className="diff-text">{line.text || " "}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

function FileRow({ file, diff, selected, onSelect }: { file: FileChange; diff: FileDiff | undefined; selected: boolean; onSelect(): void }) {
    return (
        <li className={selected ? "selected" : ""} onClick={onSelect} title={file.path}>
            <span className={`change-status ${file.status}`}>{file.status[0]!.toUpperCase()}</span>
            <span className="diff-file-name">{file.path}</span>
            {diff && (
                <span className="diff-stats">
                    <span className="added">+{diff.added}</span> <span className="removed">−{diff.removed}</span>
                </span>
            )}
        </li>
    );
}
