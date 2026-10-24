import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { Message, ToolResultBlock } from "@justai/shared";

import { fetchSession } from "../services/agentApi";
import { apiFetch, readApiError } from "../services/http";

interface BridgeEvent {
    id: string;
    time: string;
    kind: "task" | "feedback" | "start" | "done" | "failed" | "paused" | "stop-request" | "merged" | "command" | "waiting" | "error" | "gap" | "note";
    issue?: number;
    title?: string;
    text: string;
    sessionId?: string;
    url?: string;
}

interface RunnerStatus {
    state: "idle" | "working" | "error" | "stopped";
    currentIssue?: number;
    currentSessionId?: string;
}

interface Props {
    /** Открыть полную сессию агента во вкладке «Чат». */
    onOpenSession(sessionId: string): void;
}

const POLL_MS = 3_000;
const LIVE_STEPS = 8;

const ICONS: Record<BridgeEvent["kind"], string> = {
    task: "📥",
    feedback: "📝",
    start: "▶",
    done: "✅",
    failed: "⚠️",
    paused: "⏸",
    "stop-request": "✋",
    merged: "🔀",
    command: "⚙",
    waiting: "⏳",
    error: "❗",
    gap: "💤",
    note: "💬",
};

const LABELS: Record<BridgeEvent["kind"], string> = {
    task: "Получена задача",
    feedback: "Новое указание",
    start: "Выполняю",
    done: "Готово",
    failed: "Не удалось",
    paused: "Остановлено",
    "stop-request": "Команда остановки",
    merged: "Слито",
    command: "Команда",
    waiting: "Ждёт",
    error: "Ошибка моста",
    gap: "Перерыв",
    note: "Вы",
};

/**
 * Лента моста: одна хронология всех задач — что пришло с GitHub и что делает этот ПК.
 * У задачи, которая выполняется сейчас, видны живые шаги агента. Внизу — сообщение в задачу (комментарий на GitHub).
 */
export function BridgeFeed({ onOpenSession }: Props) {
    const [events, setEvents] = useState<BridgeEvent[]>([]);
    const [runner, setRunner] = useState<RunnerStatus | null>(null);
    const [live, setLive] = useState<Message[]>([]);
    const [filter, setFilter] = useState<number | "all">("all");
    const [target, setTarget] = useState<number | "new" | "auto">("auto");
    const [text, setText] = useState("");
    const [sending, setSending] = useState(false);
    const [error, setError] = useState("");
    const lastId = useRef<string | undefined>(undefined);
    const scrollRef = useRef<HTMLDivElement>(null);
    const stick = useRef(true);

    // События: сначала последние 200, дальше — только новые.
    useEffect(() => {
        let stopped = false;

        const load = () => {
            const query = lastId.current ? `?after=${encodeURIComponent(lastId.current)}` : "?limit=200";

            apiFetch(`/github/feed${query}`)
                .then(async response => {
                    if (!response.ok || stopped) return;
                    const { events: fresh } = await response.json() as { events: BridgeEvent[] };
                    if (!fresh.length) return;
                    lastId.current = fresh.at(-1)!.id;
                    setEvents(current => [...current, ...fresh].slice(-500));
                })
                .catch(() => undefined);

            apiFetch("/github/status")
                .then(async response => {
                    if (!response.ok || stopped) return;
                    setRunner((await response.json() as { runner: RunnerStatus | null }).runner);
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

    // Живые шаги текущей задачи.
    const liveSession = runner?.state === "working" ? runner.currentSessionId : undefined;

    useEffect(() => {
        if (!liveSession) {
            setLive([]);
            return;
        }

        let stopped = false;
        const load = () => fetchSession(liveSession).then(details => !stopped && setLive(details.messages)).catch(() => undefined);
        load();
        const timer = window.setInterval(load, POLL_MS);

        return () => {
            stopped = true;
            window.clearInterval(timer);
        };
    }, [liveSession]);

    const shown = useMemo(() => filter === "all" ? events : events.filter(event => event.issue === filter), [events, filter]);
    const issues = useMemo(() => {
        const map = new Map<number, string>();
        for (const event of events) if (event.issue !== undefined && (event.title || !map.has(event.issue))) map.set(event.issue, event.title ?? map.get(event.issue) ?? "");
        return [...map.entries()].sort(([a], [b]) => b - a);
    }, [events]);
    const steps = useMemo(() => recentSteps(live), [live]);

    // Прокрутка вниз, если пользователь и так внизу.
    useEffect(() => {
        const element = scrollRef.current;
        if (element && stick.current) element.scrollTop = element.scrollHeight;
    }, [shown.length, steps.length]);

    const autoTarget = runner?.currentIssue ?? (filter !== "all" ? filter : undefined);
    // План от планировщика (блоки «### ISSUE») — создаются все issues сразу, а не одно сообщение.
    const planBlocks = (text.match(/^\s*#{2,3}\s*ISSUE\b/gim) ?? []).length;
    const sendTo = planBlocks ? undefined : target === "auto" ? autoTarget : target === "new" ? undefined : target;

    async function send() {
        const message = text.trim();
        if (!message || sending) return;

        setSending(true);
        setError("");

        try {
            if (planBlocks) {
                const response = await apiFetch("/github/import", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text: message }),
                });

                if (!response.ok) throw new Error(await readApiError(response));
                setText("");
                return;
            }

            const response = await apiFetch("/github/message", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: message, ...(sendTo ? { issue: sendTo } : {}) }),
            });

            if (!response.ok) throw new Error(await readApiError(response));
            setText("");
        }
        catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        }
        finally {
            setSending(false);
        }
    }

    function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void send();
        }
    }

    return (
        <div className="bridge-feed">
            <div className="bridge-feed__toolbar">
                <select value={filter} onChange={event => setFilter(event.target.value === "all" ? "all" : Number(event.target.value))}>
                    <option value="all">Все задачи</option>
                    {issues.map(([issue, title]) => <option key={issue} value={issue}>#{issue} {title}</option>)}
                </select>
                <span className="muted">
                    {runner?.state === "working" ? `выполняется #${runner.currentIssue}` : runner ? "ждёт задачи" : "мост на этом ПК выключен"}
                </span>
            </div>

            <div
                className="bridge-feed__events"
                ref={scrollRef}
                onScroll={event => {
                    const element = event.currentTarget;
                    stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
                }}
            >
                {shown.length === 0 && (
                    <div className="ai-placeholder">
                        <strong>Лента моста пуста.</strong>
                        <p>Здесь появятся задачи из GitHub и всё, что этот ПК по ним делает.</p>
                    </div>
                )}

                {shown.map(event => {
                    const current = event.kind === "start" && event.sessionId !== undefined && event.sessionId === liveSession;

                    return (
                        <div key={event.id} className={`bridge-event bridge-event--${event.kind}`}>
                            <span className="bridge-event__time">{time(event.time)}</span>
                            <span className="bridge-event__icon">{ICONS[event.kind]}</span>
                            <div className="bridge-event__body">
                                <div className="bridge-event__head">
                                    <strong>{LABELS[event.kind]}</strong>
                                    {event.issue !== undefined && (
                                        <button type="button" className="link-button" onClick={() => setFilter(event.issue!)} title="Показать только эту задачу">
                                            #{event.issue}
                                        </button>
                                    )}
                                    {event.title && <span>«{event.title}»</span>}
                                    {event.url && <a href={event.url} target="_blank" rel="noreferrer">GitHub</a>}
                                    {event.sessionId && (
                                        <button type="button" className="link-button" onClick={() => onOpenSession(event.sessionId!)}>шаги агента</button>
                                    )}
                                </div>
                                <div className="bridge-event__text">{event.text}</div>

                                {current && steps.length > 0 && (
                                    <ul className="bridge-event__steps">
                                        {steps.map(step => (
                                            <li key={step.id} className={step.state}>
                                                <span>{step.state === "ok" ? "✓" : step.state === "error" ? "✕" : "…"}</span>
                                                <code>{step.name}</code> {step.brief}
                                                {step.error && <span className="error-text"> — {step.error}</span>}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            <div className="bridge-feed__composer">
                <div className="bridge-feed__target">
                    <span className="muted">Куда:</span>
                    <select value={target} onChange={event => setTarget(event.target.value === "auto" || event.target.value === "new" ? event.target.value : Number(event.target.value))}>
                        <option value="auto">{autoTarget ? `в задачу #${autoTarget}` : "новая задача"}</option>
                        <option value="new">новая задача</option>
                        {issues.map(([issue, title]) => <option key={issue} value={issue}>в #{issue} {title}</option>)}
                    </select>
                    <span className="muted">— уйдёт комментарием на GitHub; мост и планировщик его увидят</span>
                </div>
                <textarea
                    value={text}
                    placeholder={sendTo
                        ? `Указание к задаче #${sendTo} (Ctrl+Enter — отправить)`
                        : "Новая задача (первая строка — заголовок), команда «/justai …» или план планировщика с блоками «### ISSUE» (Ctrl+Enter — отправить)"}
                    onChange={event => setText(event.target.value)}
                    onKeyDown={handleKeyDown}
                    rows={3}
                />
                {error && <div className="error">{error}</div>}
                <button className="send-button" disabled={!text.trim() || sending} onClick={() => void send()}>
                    {sending ? "Отправляю…" : planBlocks ? `Создать ${planBlocks} issues из плана` : sendTo ? `Отправить в #${sendTo}` : "Поставить задачу"}
                </button>
            </div>
        </div>
    );
}

interface LiveStep {
    id: string;
    name: string;
    brief: string;
    state: "ok" | "error" | "running";
    error?: string;
}

/** Последние действия агента из сессии: инструмент, главный аргумент, ✓/✕/… */
function recentSteps(messages: Message[]): LiveStep[] {
    const results = new Map<string, ToolResultBlock>();

    for (const message of messages) {
        for (const block of message.content) {
            if (block.type === "tool_result") results.set(block.toolUseId, block);
        }
    }

    const steps: LiveStep[] = [];

    for (const message of messages) {
        for (const block of message.content) {
            if (block.type !== "tool_use" || block.name === "todo_write") continue;

            const result = results.get(block.id);
            const input = block.input as { path?: unknown; command?: unknown; selector?: unknown; url?: unknown; code?: unknown } | null;
            const main = input?.path ?? input?.command ?? input?.selector ?? input?.url ?? input?.code;
            const errorText = result?.isError
                ? (typeof result.content === "string" ? result.content : result.content.map(part => part.type === "text" ? part.text : "").join(" ")).split("\n")[0]
                : undefined;

            steps.push({
                id: block.id,
                name: block.name,
                brief: typeof main === "string" ? (main.length > 70 ? `${main.slice(0, 69)}…` : main) : "",
                state: !result ? "running" : result.isError ? "error" : "ok",
                ...(errorText ? { error: errorText.length > 120 ? `${errorText.slice(0, 119)}…` : errorText } : {}),
            });
        }
    }

    return steps.slice(-LIVE_STEPS);
}

function time(value: string): string {
    const date = new Date(value);
    const today = new Date().toDateString() === date.toDateString();
    return date.toLocaleString("ru-RU", today ? { hour: "2-digit", minute: "2-digit" } : { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
