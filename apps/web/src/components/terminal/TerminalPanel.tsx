import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";

import { apiFetch, readApiError } from "../../services/http";
import { socketBus } from "../../services/socket";

interface TerminalInfo {
    id: string;
    title: string;
    alive: boolean;
    buffer?: string;
}

interface Props {
    onClose(): void;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await apiFetch(path, init?.body ? { ...init, headers: { "Content-Type": "application/json" } } : init);

    if (!response.ok) {
        throw new Error(await readApiError(response));
    }

    return (response.status === 204 ? undefined : await response.json()) as T;
}

/**
 * Терминалы пользователя под редактором (xterm.js). Терминалы живут на сервере:
 * после перезагрузки страницы вкладки и экран восстанавливаются.
 */
export function TerminalPanel({ onClose }: Props) {
    const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
    const [active, setActive] = useState("");
    const [error, setError] = useState("");

    useEffect(() => {
        api<{ terminals: TerminalInfo[] }>("/terminals")
            .then(async ({ terminals: existing }) => {
                if (existing.length > 0) {
                    setTerminals(existing);
                    setActive(existing[0]!.id);
                    return;
                }

                const created = await api<TerminalInfo>("/terminals", { method: "POST", body: JSON.stringify({ cols: 100, rows: 20 }) });
                setTerminals([created]);
                setActive(created.id);
            })
            .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
    }, []);

    useEffect(() => socketBus.subscribe(message => {
        const event = message as { type?: string; terminalId?: string };

        if (event.type === "terminal.exit") {
            setTerminals(list => list.map(item => item.id === event.terminalId ? { ...item, alive: false } : item));
        }
    }), []);

    async function add() {
        try {
            const created = await api<TerminalInfo>("/terminals", { method: "POST", body: JSON.stringify({ cols: 100, rows: 20 }) });
            setTerminals(list => [...list, created]);
            setActive(created.id);
        }
        catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        }
    }

    async function close(id: string) {
        await api(`/terminals/${id}`, { method: "DELETE" }).catch(() => undefined);
        const rest = terminals.filter(item => item.id !== id);
        setTerminals(rest);

        if (active === id) {
            setActive(rest.at(-1)?.id ?? "");
        }

        if (rest.length === 0) {
            onClose();
        }
    }

    return (
        <div className="terminal-panel">
            <div className="terminal-tabs">
                {terminals.map(item => (
                    <div
                        key={item.id}
                        className={`terminal-tab${item.id === active ? " active" : ""}${item.alive ? "" : " exited"}`}
                        onClick={() => setActive(item.id)}
                    >
                        {item.title}{item.alive ? "" : " (exited)"}
                        <button
                            className="tab-close"
                            title="Close terminal"
                            onClick={event => {
                                event.stopPropagation();
                                void close(item.id);
                            }}
                        >
                            ×
                        </button>
                    </div>
                ))}
                <button className="link-button" title="New terminal" onClick={() => void add()}>+ New</button>
                <button className="link-button terminal-hide" onClick={onClose}>hide</button>
            </div>

            {error && <div className="error">{error}</div>}

            <div className="terminal-views">
                {terminals.map(item => (
                    <TerminalView key={item.id} info={item} visible={item.id === active} />
                ))}
            </div>
        </div>
    );
}

function TerminalView({ info, visible }: { info: TerminalInfo; visible: boolean }) {
    const host = useRef<HTMLDivElement>(null);
    const fitRef = useRef<FitAddon | null>(null);

    useEffect(() => {
        const element = host.current;

        if (!element) {
            return;
        }

        const term = new Terminal({
            fontSize: 13,
            fontFamily: "Consolas, 'Cascadia Mono', monospace",
            cursorBlink: true,
            scrollback: 5_000,
            theme: { background: "#0c0f12" },
        });
        const fit = new FitAddon();
        fitRef.current = fit;
        term.loadAddon(fit);
        term.open(element);

        if (info.buffer) {
            term.write(info.buffer);
        }

        // Ввод копится и отправляется пачкой: на каждую клавишу — не больше одного запроса за кадр.
        let pending = "";
        let timer: number | undefined;

        const flush = () => {
            timer = undefined;
            const data = pending;
            pending = "";
            void apiFetch(`/terminals/${info.id}/input`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ data }),
            });
        };

        const input = term.onData(data => {
            pending += data;
            timer ??= window.setTimeout(flush, 16);
        });

        const unsubscribe = socketBus.subscribe(message => {
            const event = message as { type?: string; terminalId?: string; data?: string; exitCode?: number };

            if (event.terminalId !== info.id) return;
            if (event.type === "terminal.output" && event.data) term.write(event.data);
            if (event.type === "terminal.exit") term.write(`\r\n[process exited with code ${event.exitCode}]\r\n`);
        });

        let resizeTimer: number | undefined;
        const observer = new ResizeObserver(() => {
            if (!element.offsetParent) return;

            fit.fit();
            window.clearTimeout(resizeTimer);
            resizeTimer = window.setTimeout(() => {
                void apiFetch(`/terminals/${info.id}/resize`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ cols: term.cols, rows: term.rows }),
                });
            }, 150);
        });
        observer.observe(element);

        return () => {
            observer.disconnect();
            unsubscribe();
            input.dispose();
            window.clearTimeout(timer);
            window.clearTimeout(resizeTimer);
            term.dispose();
        };
    }, [info.id]);

    useEffect(() => {
        if (visible) {
            requestAnimationFrame(() => fitRef.current?.fit());
        }
    }, [visible]);

    return <div ref={host} className="terminal-view" style={{ display: visible ? "block" : "none" }} />;
}
