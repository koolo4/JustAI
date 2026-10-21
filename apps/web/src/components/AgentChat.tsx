import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
    AgentProfileInfo,
    Message,
    PermissionDecision,
    PermissionMode,
    PermissionRequest,
    ProviderInfo,
    SessionSummary,
    ToolOutput,
    ToolResultBlock,
    ToolUseBlock,
} from "@justai/shared";

import { useIDEContext } from "../context/useIDEContext";
import { useAgentSession, type ToolProgress } from "../hooks/useAgentSession";
import { fetchProfiles, fetchProviders, fetchSessions } from "../services/agentApi";
import { IntegrationCard } from "./IntegrationCard";

export function AgentChat() {
    const { activeFile } = useIDEContext();
    const agent = useAgentSession();

    const [providers, setProviders] = useState<ProviderInfo[]>([]);
    const [profiles, setProfiles] = useState<AgentProfileInfo[]>([]);
    const [sessions, setSessions] = useState<SessionSummary[]>([]);
    const [provider, setProvider] = useState("");
    const [profile, setProfile] = useState("coder");
    const [mode, setMode] = useState<PermissionMode>("ask");
    const [prompt, setPrompt] = useState("");
    const [loadError, setLoadError] = useState("");

    const running = agent.session?.status === "running";

    useEffect(() => {
        Promise.all([fetchProviders(), fetchProfiles(), fetchSessions()])
            .then(([providerList, profileList, sessionList]) => {
                setProviders(providerList.providers);
                setProfiles(profileList.profiles);
                setSessions(sessionList);

                const preferred = providerList.providers.find(item => item.id === providerList.defaultProvider);
                setProvider(
                    preferred?.configured
                        ? preferred.id
                        : providerList.providers.find(item => item.configured)?.id ?? "mock",
                );
            })
            .catch(error => setLoadError(error instanceof Error ? error.message : String(error)));
    }, []);

    // Обновить список сессий, когда агент закончил работу.
    useEffect(() => {
        if (agent.session && !running) {
            fetchSessions().then(setSessions).catch(() => undefined);
        }
    }, [agent.session?.id, running]);

    const results = useMemo(() => collectResults(agent.messages), [agent.messages]);

    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const element = scrollRef.current;
        if (element) {
            element.scrollTop = element.scrollHeight;
        }
    }, [agent.messages.length, agent.streamingText, agent.streamingThinking]);

    const current = agent.session
        ? `${agent.session.provider} · ${agent.session.model}`
        : providers.find(item => item.id === provider)?.model ?? "";

    async function submit() {
        const text = prompt.trim();

        if (!text || running) {
            return;
        }

        setPrompt("");
        await agent.send(text, {
            profile,
            provider,
            mode,
            ...(activeFile ? { activeFile } : {}),
        });
    }

    function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void submit();
        }
    }

    return (
        <div className="ai-chat">
            <div className="ai-header">
                <div className="ai-title-row">
                    <div>
                        <h2>Agent</h2>
                        <div className="muted">{current}</div>
                    </div>

                    <div className="ai-actions">
                        <button
                            className="secondary-button"
                            onClick={agent.reset}
                            disabled={running}
                        >
                            New session
                        </button>
                    </div>
                </div>

                <div className="ai-selects">
                    <label>
                        <span className="muted">Profile</span>
                        <select
                            value={profile}
                            onChange={event => setProfile(event.target.value)}
                            disabled={Boolean(agent.session)}
                        >
                            {profiles.map(item => (
                                <option key={item.id} value={item.id} title={item.description}>
                                    {item.label}
                                </option>
                            ))}
                        </select>
                    </label>

                    <label>
                        <span className="muted">Provider</span>
                        <select
                            value={provider}
                            onChange={event => setProvider(event.target.value)}
                            disabled={Boolean(agent.session)}
                        >
                            {providers.map(item => (
                                <option key={item.id} value={item.id} disabled={!item.configured}>
                                    {item.label}{item.configured ? "" : " (no API key)"}
                                </option>
                            ))}
                        </select>
                    </label>

                    <label>
                        <span className="muted">Permissions</span>
                        <select
                            value={agent.session?.mode ?? mode}
                            onChange={event => {
                                const next = event.target.value as PermissionMode;
                                setMode(next);
                                void agent.setMode(next);
                            }}
                            title={MODE_HINTS[agent.session?.mode ?? mode]}
                        >
                            <option value="ask">Ask every change</option>
                            <option value="auto-edit">Auto: edits + safe commands</option>
                            <option value="full-auto">Full auto (asks for dangerous)</option>
                        </select>
                    </label>

                    <label>
                        <span className="muted">History</span>
                        <select
                            value={agent.session?.id ?? ""}
                            onChange={event => {
                                if (event.target.value) {
                                    void agent.open(event.target.value);
                                }
                                else {
                                    agent.reset();
                                }
                            }}
                            disabled={running}
                        >
                            <option value="">— new —</option>
                            {sessions.map(item => (
                                <option key={item.id} value={item.id}>
                                    {item.title}
                                </option>
                            ))}
                        </select>
                    </label>
                </div>

                <IntegrationCard />

                {(loadError || agent.error) && (
                    <div className="error">{agent.error || loadError}</div>
                )}
            </div>

            <div className="ai-messages" ref={scrollRef}>
                {agent.messages.length === 0 && !running && (
                    <div className="ai-placeholder">
                        <strong>Agent ready.</strong>
                        <p>Ask it to explore the project, read or edit files.</p>
                        <p>Ctrl/Cmd + Enter — send.</p>
                    </div>
                )}

                {agent.messages.map(message => (
                    <MessageView
                        key={message.id}
                        message={message}
                        results={results}
                        tools={agent.tools}
                    />
                ))}

                {agent.permissions.map(request => (
                    <PermissionCard
                        key={request.requestId}
                        request={request}
                        onAnswer={(decision, note) => void agent.answer(request.requestId, decision, note)}
                    />
                ))}

                {running && agent.permissions.length === 0 && (
                    <div className="message assistant streaming">
                        <div className="role">JustAI</div>
                        {agent.streamingThinking && (
                            <details className="thinking" open>
                                <summary>Thinking</summary>
                                <pre>{agent.streamingThinking}</pre>
                            </details>
                        )}
                        {agent.streamingText
                            ? <pre>{agent.streamingText}</pre>
                            : <div className="muted">Working…</div>}
                    </div>
                )}

                {agent.session && !running && agent.session.lastError && (
                    <div className={agent.session.status === "failed" ? "error" : "notice"}>
                        {agent.session.status === "failed" ? "Error: " : ""}
                        {agent.session.lastError}
                    </div>
                )}
            </div>

            <div className="ai-input">
                {agent.run && (
                    <div className="muted run-stats">
                        Steps: {agent.run.steps} · tokens in {agent.run.usage.inputTokens}
                        {" "}(cached {agent.run.usage.cacheReadTokens}) · out {agent.run.usage.outputTokens}
                    </div>
                )}

                <textarea
                    rows={4}
                    value={prompt}
                    onChange={event => setPrompt(event.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Например: прочитай README.md и объясни проект"
                />

                {running ? (
                    <button className="stop-button" onClick={() => void agent.stop()}>
                        Stop
                    </button>
                ) : (
                    <button onClick={() => void submit()} disabled={!prompt.trim()}>
                        Send
                    </button>
                )}
            </div>
        </div>
    );
}

function MessageView({
    message,
    results,
    tools,
}: {
    message: Message;
    results: Map<string, ToolResultBlock>;
    tools: Record<string, ToolProgress>;
}) {
    if (message.role === "user") {
        const text = message.content
            .map(block => block.type === "text" ? block.text : "")
            .join("\n")
            .trim();

        // Сообщения только с результатами инструментов показываются внутри карточек.
        if (!text) {
            return null;
        }

        return (
            <div className="message user">
                <div className="role">You</div>
                <pre>{text}</pre>
            </div>
        );
    }

    return (
        <div className="message assistant">
            <div className="role">JustAI</div>
            {message.content.map((block, index) => {
                switch (block.type) {
                    case "thinking":
                        return (
                            <details className="thinking" key={index}>
                                <summary>Thinking</summary>
                                <pre>{block.text}</pre>
                            </details>
                        );
                    case "text":
                        return <pre key={index}>{block.text}</pre>;
                    case "tool_use":
                        return (
                            <ToolCard
                                key={block.id}
                                use={block}
                                result={results.get(block.id)}
                                progress={tools[block.id]}
                            />
                        );
                    default:
                        return null;
                }
            })}
        </div>
    );
}

function ToolCard({
    use,
    result,
    progress,
}: {
    use: ToolUseBlock;
    result: ToolResultBlock | undefined;
    progress: ToolProgress | undefined;
}) {
    const status = result
        ? (result.isError ? "error" : "done")
        : progress?.status ?? "running";

    const live = !result && progress?.output;

    return (
        <details className={`tool-card ${status}`} open={Boolean(live)}>
            <summary>
                <span className="tool-status">{status === "running" ? "…" : status === "error" ? "✕" : "✓"}</span>
                <strong>{use.name}</strong>
                <span className="tool-input">{inputSummary(use.input)}</span>
            </summary>
            <pre className="tool-detail">{JSON.stringify(use.input, null, 2)}</pre>
            {live && <pre className="tool-detail">{progress.output}</pre>}
            {result && <pre className="tool-detail">{outputText(result.content)}</pre>}
        </details>
    );
}

const MODE_HINTS: Record<PermissionMode, string> = {
    "ask": "The agent asks before changing files, running commands or using external services.",
    "auto-edit": "File edits and known safe commands (tests, builds, git status) run without asking.",
    "full-auto": "Everything runs without asking, except potentially destructive commands and external services.",
};

function PermissionCard({
    request,
    onAnswer,
}: {
    request: PermissionRequest;
    onAnswer: (decision: PermissionDecision, note?: string) => void;
}) {
    const [note, setNote] = useState("");

    return (
        <div className={`permission-card${request.dangerous ? " dangerous" : ""}`}>
            <div className="permission-title">
                <strong>{request.dangerous ? "⚠ Confirm a potentially destructive action" : "Allow this action?"}</strong>
                <span className="muted">{request.tool}</span>
            </div>
            <pre className="permission-summary">{request.summary}</pre>
            <div className="muted">{request.reason}</div>
            <input
                className="permission-note"
                value={note}
                onChange={event => setNote(event.target.value)}
                placeholder="Optional note for the agent if you deny"
            />
            <div className="permission-actions">
                <button onClick={() => onAnswer("allow")}>Allow</button>
                {!request.dangerous && (
                    <button className="secondary-button" onClick={() => onAnswer("allow_always")}>
                        Always allow
                    </button>
                )}
                <button className="deny-button" onClick={() => onAnswer("deny", note.trim() || undefined)}>
                    Deny
                </button>
            </div>
        </div>
    );
}

function collectResults(messages: Message[]): Map<string, ToolResultBlock> {
    const results = new Map<string, ToolResultBlock>();

    for (const message of messages) {
        for (const block of message.content) {
            if (block.type === "tool_result") {
                results.set(block.toolUseId, block);
            }
        }
    }

    return results;
}

function inputSummary(input: unknown): string {
    if (input && typeof input === "object" && "path" in input && typeof input.path === "string") {
        return input.path;
    }

    const text = JSON.stringify(input) ?? "";
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function outputText(output: ToolOutput): string {
    const text = typeof output === "string"
        ? output
        : output.map(block => block.type === "text" ? block.text : "[image]").join("\n");

    return text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text;
}
