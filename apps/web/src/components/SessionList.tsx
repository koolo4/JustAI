import { useMemo, useState } from "react";

import type { SessionSummary } from "@justai/shared";

interface Props {
    sessions: SessionSummary[];
    activeId: string | undefined;
    disabled: boolean;
    onOpen(id: string): void;
    onNew(): void;
}

const STATUS_LABEL: Record<SessionSummary["status"], string> = {
    idle: "new",
    running: "running",
    completed: "done",
    stopped: "stopped",
    failed: "failed",
};

/**
 * История сессий с поиском: продолжить любую прошлую работу агента.
 */
export function SessionList({ sessions, activeId, disabled, onOpen, onNew }: Props) {
    const [query, setQuery] = useState("");

    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();

        return needle
            ? sessions.filter(session =>
                session.title.toLowerCase().includes(needle) ||
                session.provider.toLowerCase().includes(needle) ||
                session.model.toLowerCase().includes(needle))
            : sessions;
    }, [sessions, query]);

    return (
        <div className="session-list">
            <div className="session-list-header">
                <input
                    className="session-search"
                    placeholder="Search sessions"
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                />
                <button className="secondary-button" onClick={onNew} disabled={disabled}>New</button>
            </div>

            <ul>
                {filtered.length === 0 && <li className="muted session-empty">No sessions.</li>}

                {filtered.map(session => (
                    <li
                        key={session.id}
                        className={`${session.id === activeId ? "active" : ""}${disabled ? " disabled" : ""}`}
                        onClick={() => !disabled && session.id !== activeId && onOpen(session.id)}
                        title={`${session.title}\n${session.provider} · ${session.model}`}
                    >
                        <span className={`session-dot ${session.status}`} />
                        <span className="session-title">{session.title}</span>
                        <span className="muted session-meta">
                            {STATUS_LABEL[session.status]} · {relativeTime(session.updatedAt)}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

function relativeTime(iso: string): string {
    const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);

    if (seconds < 60) return "now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h`;

    return new Date(iso).toLocaleDateString();
}
