import { useCallback, useEffect, useRef, useState } from "react";

import {
    isAgentEvent,
    type AgentEvent,
    type CreateSessionRequest,
    type Message,
    type SessionSummary,
    type Usage,
} from "@justai/shared";

import {
    createSession,
    fetchSession,
    sendMessage,
    stopSession,
} from "../services/agentApi";
import { socketBus } from "../services/socket";

export interface ToolProgress {
    status: "running" | "done" | "error";
    preview?: string;
}

export interface RunStats {
    steps: number;
    usage: Usage;
}

export interface AgentSessionState {
    session: SessionSummary | null;
    messages: Message[];
    /** Текст ответа, который модель стримит прямо сейчас. */
    streamingText: string;
    streamingThinking: string;
    tools: Record<string, ToolProgress>;
    run: RunStats | null;
    error: string;
}

const INITIAL: AgentSessionState = {
    session: null,
    messages: [],
    streamingText: "",
    streamingThinking: "",
    tools: {},
    run: null,
    error: "",
};

export function useAgentSession() {
    const [state, setState] = useState<AgentSessionState>(INITIAL);
    const sessionIdRef = useRef<string | null>(null);

    const reload = useCallback(async (id: string) => {
        const details = await fetchSession(id);

        if (sessionIdRef.current !== id) {
            return;
        }

        setState(previous => ({
            ...previous,
            session: details.session,
            messages: details.messages,
            ...(details.session.status === "running"
                ? {}
                : { streamingText: "", streamingThinking: "" }),
        }));
    }, []);

    useEffect(() => socketBus.subscribe(message => {
        if (!isAgentEvent(message) || message.sessionId !== sessionIdRef.current) {
            return;
        }

        setState(previous => applyEvent(previous, message));

        if (message.type === "session.status" && message.status !== "running") {
            void reload(message.sessionId).catch(() => undefined);
        }
    }), [reload]);

    // События, пришедшие во время обрыва сокета, потеряны — после переподключения
    // состояние берётся с сервера (в том числе «прервано рестартом сервера»).
    useEffect(() => {
        let wasOpen = false;

        return socketBus.onStatus(status => {
            const id = sessionIdRef.current;

            if (status === "open" && wasOpen === false && id) {
                void reload(id).catch(() => undefined);
            }

            wasOpen = status === "open";
        });
    }, [reload]);

    const open = useCallback(async (id: string) => {
        sessionIdRef.current = id;
        setState({ ...INITIAL });

        try {
            await reload(id);
        }
        catch (error) {
            setState(previous => ({ ...previous, error: errorText(error) }));
        }
    }, [reload]);

    const reset = useCallback(() => {
        sessionIdRef.current = null;
        setState({ ...INITIAL });
    }, []);

    const send = useCallback(async (
        text: string,
        options: CreateSessionRequest & { activeFile?: string },
    ) => {
        try {
            let id = sessionIdRef.current;

            if (!id) {
                const session = await createSession({
                    ...(options.profile ? { profile: options.profile } : {}),
                    ...(options.provider ? { provider: options.provider } : {}),
                    ...(options.model ? { model: options.model } : {}),
                });

                id = session.id;
                sessionIdRef.current = id;
                setState({ ...INITIAL, session });
            }

            setState(previous => ({ ...previous, error: "", run: null, tools: {} }));

            const session = await sendMessage(id, {
                text,
                ...(options.activeFile ? { activeFile: options.activeFile } : {}),
            });

            setState(previous => ({ ...previous, session }));
        }
        catch (error) {
            setState(previous => ({ ...previous, error: errorText(error) }));
        }
    }, []);

    const stop = useCallback(async () => {
        const id = sessionIdRef.current;

        if (!id) {
            return;
        }

        try {
            await stopSession(id);
            await reload(id);
        }
        catch (error) {
            setState(previous => ({ ...previous, error: errorText(error) }));
        }
    }, [reload]);

    return { ...state, open, reset, send, stop };
}

function applyEvent(state: AgentSessionState, event: AgentEvent): AgentSessionState {
    switch (event.type) {
        case "assistant.delta":
            return { ...state, streamingText: state.streamingText + event.text };

        case "assistant.thinking_delta":
            return { ...state, streamingThinking: state.streamingThinking + event.text };

        case "message.added": {
            if (state.messages.some(message => message.id === event.message.id)) {
                return state;
            }

            const isAssistant = event.message.role === "assistant";

            return {
                ...state,
                messages: [...state.messages, event.message],
                ...(isAssistant ? { streamingText: "", streamingThinking: "" } : {}),
            };
        }

        case "tool.started":
            return { ...state, tools: { ...state.tools, [event.toolUseId]: { status: "running" } } };

        case "tool.finished":
            return {
                ...state,
                tools: {
                    ...state.tools,
                    [event.toolUseId]: { status: event.isError ? "error" : "done", preview: event.preview },
                },
            };

        case "tool.progress":
            return state;

        case "budget.updated":
            return { ...state, run: { steps: event.steps, usage: event.usage } };

        case "session.status":
            if (!state.session) {
                return state;
            }

            return {
                ...state,
                session: {
                    ...state.session,
                    status: event.status,
                    ...(event.error ? { lastError: event.error } : {}),
                },
            };
    }
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
