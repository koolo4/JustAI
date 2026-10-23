import { useEffect, useState } from "react";

import { apiFetch } from "../services/http";

interface RunnerStatus {
    state: "idle" | "working" | "error" | "stopped";
    currentIssue?: number;
    currentSessionId?: string;
    lastError?: string;
}

interface Props {
    /** Сессия, открытая в панели агента. */
    activeSessionId: string | undefined;
    onWatch(sessionId: string): void;
}

const POLL_MS = 5_000;

/**
 * Мост GitHub работает в фоновой сессии: плашка показывает, что он делает, и открывает его сессию,
 * чтобы шаги агента были видны вживую.
 */
export function GitHubActivity({ activeSessionId, onWatch }: Props) {
    const [runner, setRunner] = useState<RunnerStatus | null>(null);
    const [repo, setRepo] = useState("");

    useEffect(() => {
        let stopped = false;

        const load = () => {
            apiFetch("/github/status")
                .then(async response => {
                    if (!response.ok || stopped) return;
                    const body = await response.json() as { repo: string | null; runner: RunnerStatus | null };
                    setRunner(body.runner);
                    setRepo(body.repo ?? "");
                })
                .catch(() => undefined);
        };

        load();
        const timer = window.setInterval(load, POLL_MS);

        return () => {
            stopped = true;
            window.clearInterval(timer);
        };
    }, []);

    if (!runner || (runner.state !== "working" && runner.state !== "error")) {
        return null;
    }

    if (runner.state === "error") {
        return (
            <div className="github-activity error" title={runner.lastError}>
                🔗 Мост GitHub ({repo}): {runner.lastError}
            </div>
        );
    }

    const watching = runner.currentSessionId !== undefined && runner.currentSessionId === activeSessionId;

    return (
        <div className="github-activity">
            <span className="github-activity__pulse" />
            <span>🔗 Мост GitHub выполняет задачу #{runner.currentIssue} ({repo})</span>
            {runner.currentSessionId && !watching && (
                <button className="link-button" onClick={() => onWatch(runner.currentSessionId!)}>Смотреть</button>
            )}
            {watching && <span className="muted">— вы смотрите эту сессию</span>}
        </div>
    );
}
