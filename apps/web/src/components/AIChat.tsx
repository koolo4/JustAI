import type React from "react";

import {
    useEffect,
    useMemo,
    useState,
} from "react";

import {
    askAI,
    fetchAIProviders,
    fetchAIAgents,
    type AIProviderInfo,
    type AIAgentInfo,
} from "../services/aiApi";

import {
    fetchIntegrationStatus,
    getMicrosoftConnectUrl,
    disconnectMicrosoft,
    type MicrosoftStatus,
} from "../services/integrationsApi";

import { useIDEContext } from "../context/useIDEContext";
import type { ChatMessage } from "../types/chat";

export function AIChat() {

    const {
        activeFile,
        activeContent,
        openedFiles,
        projectTree,
    } = useIDEContext();

    const [messages, setMessages] =
        useState<ChatMessage[]>([]);

    const [prompt, setPrompt] =
        useState("");

    const [loading, setLoading] =
        useState(false);

    const [providers, setProviders] =
        useState<AIProviderInfo[]>([]);

    const [provider, setProvider] =
        useState("mock");

    const [agents, setAgents] =
        useState<AIAgentInfo[]>([]);

    const [agent, setAgent] =
        useState("general");

    const [microsoft, setMicrosoft] =
        useState<MicrosoftStatus | null>(null);

    const [error, setError] =
        useState("");

    useEffect(() => {
        Promise.all([
            fetchAIProviders(),
            fetchAIAgents(),
            fetchIntegrationStatus(),
        ])
            .then(([loadedProviders, loadedAgents, microsoftStatus]) => {
                setProviders(loadedProviders);
                setAgents(loadedAgents);
                setMicrosoft(microsoftStatus);

                const configured =
                    loadedProviders.find(
                        item => item.configured,
                    );

                if (configured) {
                    setProvider(configured.id);
                }
            })
            .catch((reason: unknown) => {
                setError(
                    reason instanceof Error
                        ? reason.message
                        : String(reason),
                );
            });
    }, []);

    const selectedProvider =
        useMemo(
            () =>
                providers.find(
                    item => item.id === provider,
                ),
            [providers, provider],
        );

    async function send() {

        if (!prompt.trim() || loading) {
            return;
        }

        const text = prompt.trim();

        setMessages(previous => [
            ...previous,
            {
                id: crypto.randomUUID(),
                role: "user",
                text,
                createdAt: Date.now(),
            },
        ]);

        setPrompt("");
        setLoading(true);
        setError("");

        try {
            const answer =
                await askAI({
                    prompt: text,
                    provider,
                    agent,
                    activeFile,
                    activeContent,
                    openedFiles,
                    projectTree,
                });

            setMessages(previous => [
                ...previous,
                {
                    id: crypto.randomUUID(),
                    role: "assistant",
                    text: answer,
                    createdAt: Date.now(),
                },
            ]);
        }
        catch (reason: unknown) {
            const message =
                reason instanceof Error
                    ? reason.message
                    : String(reason);

            setError(message);
        }
        finally {
            setLoading(false);
        }
    }

    function handleKeyDown(
        event: React.KeyboardEvent<HTMLTextAreaElement>,
    ) {
        if (
            event.key === "Enter" &&
            (event.ctrlKey || event.metaKey)
        ) {
            event.preventDefault();
            void send();
        }
    }

    async function refreshMicrosoft() {
        try {
            setMicrosoft(
                await fetchIntegrationStatus(),
            );
        }
        catch {
            // The panel can remain usable if the status endpoint is temporarily unavailable.
        }
    }

    async function disconnect() {
        await disconnectMicrosoft();
        await refreshMicrosoft();
    }

    return (
        <div className="ai-chat">

            <div className="ai-header">
                <div className="ai-title-row">
                    <div>
                        <h2>Agent</h2>
                        <div className="muted">
                            {selectedProvider
                                ? `${selectedProvider.label} · ${selectedProvider.model}`
                                : "AI agent"}
                        </div>
                    </div>

                    <div className="ai-selects">
                        <select
                            value={agent}
                            onChange={event =>
                                setAgent(event.target.value)
                            }
                        >
                            {agents.map(item => (
                                <option
                                    key={item.id}
                                    value={item.id}
                                >
                                    {item.label}
                                </option>
                            ))}
                        </select>

                        <select
                            value={provider}
                            onChange={event =>
                                setProvider(event.target.value)
                            }
                        >
                            {providers.map(item => (
                                <option
                                    key={item.id}
                                    value={item.id}
                                >
                                    {item.label}
                                    {item.configured ? "" : " (not configured)"}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>

                <div className="integration-card">
                    <div>
                        <strong>Microsoft Word / OneDrive</strong>
                        <div className="muted">
                            {microsoft?.connected
                                ? "Connected"
                                : "Not connected"}
                        </div>
                    </div>

                    {microsoft?.connected ? (
                        <button
                            className="secondary-button"
                            onClick={() => void disconnect()}
                        >
                            Disconnect
                        </button>
                    ) : (
                        <a
                            className="secondary-button"
                            href={getMicrosoftConnectUrl()}
                            target="_blank"
                            rel="noreferrer"
                        >
                            Connect
                        </a>
                    )}
                </div>

                {!microsoft?.configured && (
                    <div className="notice">
                        Add Microsoft OAuth settings to server/.env to enable Word.
                    </div>
                )}

                {error && (
                    <div className="error">
                        {error}
                    </div>
                )}
            </div>

            <div className="ai-messages">
                {messages.length === 0 && (
                    <div className="ai-placeholder">
                        <strong>Agent ready.</strong>
                        <p>
                            Ask it to read or edit project files, inspect
                            the workspace, or work with a connected Word document.
                        </p>
                        <p>
                            Ctrl/Cmd + Enter — send.
                        </p>
                    </div>
                )}

                {messages.map(message => (
                    <div
                        key={message.id}
                        className={`message ${message.role}`}
                    >
                        <div className="role">
                            {message.role === "user"
                                ? "You"
                                : "JustAI"}
                        </div>

                        <pre>
                            {message.text}
                        </pre>
                    </div>
                ))}
            </div>

            <div className="ai-input">
                <textarea
                    rows={5}
                    value={prompt}
                    onChange={event =>
                        setPrompt(event.target.value)
                    }
                    onKeyDown={handleKeyDown}
                    placeholder="Например: прочитай README.md и объясни проект"
                />

                <button
                    onClick={() => void send()}
                    disabled={
                        loading ||
                        !prompt.trim()
                    }
                >
                    {loading
                        ? "Agent working..."
                        : "Run agent"}
                </button>
            </div>

        </div>
    );
}
