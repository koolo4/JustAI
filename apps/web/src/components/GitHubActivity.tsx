import { useEffect, useState } from "react";

import { apiFetch } from "../services/http";

interface RunnerStatus {
    state: "idle" | "working" | "error" | "stopped";
    currentIssue?: number;
    currentSessionId?: string;
    lastSessionId?: string;
    lastIssue?: number;
    lastCheck?: string;
    lastError?: string;
}

interface Props {
    /** Сессия, открытая в панели агента. */
    activeSessionId: string | undefined;
    onWatch(sessionId: string): void;
}

const POLL_MS = 5_000;

/** Мост опрашивает GitHub раз в минуту; дольше трёх минут тишины — что-то не так (ПК спал, нет сети). */
const STALE_MS = 3 * 60_000;

/**
 * Мост GitHub работает в фоновой сессии. Плашка видна всегда, пока мост включён на этом ПК:
 * что он делает сейчас, когда последний раз проверял GitHub, и кнопка «Смотреть» — текущая сессия
 * или, между задачами, последняя.
 */
export function GitHubActivity({ activeSessionId, onWatch }: Props) {
    const [runner, setRunner] = useState<RunnerStatus | null>(null);
    const [repo, setRepo] = useState("");
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        let stopped = false;

        const load = () => {
            setNow(Date.now());
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

    // Мост на этом ПК выключен (здесь только ставят задачи) — показывать нечего.
    if (!runner || runner.state === "stopped") {
        return null;
    }

    const working = runner.state === "working";
    const sessionId = working ? runner.currentSessionId : runner.lastSessionId;
    const issue = working ? runner.currentIssue : runner.lastIssue;
    const watching = sessionId !== undefined && sessionId === activeSessionId;
    const checkedAt = runner.lastCheck ? Date.parse(runner.lastCheck) : NaN;
    const stale = !working && Number.isFinite(checkedAt) && now - checkedAt > STALE_MS;

    const text = working ? `выполняет задачу #${runner.currentIssue}`
        : runner.state === "error" ? `ошибка: ${runner.lastError ?? "неизвестно"}`
            : stale ? `не проверял GitHub с ${time(checkedAt)} — ПК спал или нет сети?`
                : `ждёт задачи${Number.isFinite(checkedAt) ? ` · проверено в ${time(checkedAt)}` : ""}`;

    return (
        <div className={`github-activity${runner.state === "error" || stale ? " error" : ""}${working ? "" : " idle"}`} title={runner.lastError}>
            {working && <span className="github-activity__pulse" />}
            <span>🔗 Мост GitHub ({repo}): {text}</span>
            {sessionId && !watching && (
                <button className="link-button" onClick={() => onWatch(sessionId)}>
                    {working ? "Смотреть" : `Смотреть последнюю${issue ? ` (#${issue})` : ""}`}
                </button>
            )}
            {watching && <span className="muted">— вы смотрите {working ? "эту" : "последнюю"} сессию</span>}
        </div>
    );
}

function time(value: number): string {
    return new Date(value).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}
