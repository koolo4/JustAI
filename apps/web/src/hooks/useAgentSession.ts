import { useCallback, useEffect, useRef, useState } from "react";

import {
    isAgentEvent,
    type AgentEvent,
    type CreateSessionRequest,
    type Message,
    type PermissionDecision,
    type PermissionMode,
    type PermissionRequest,
    type SessionSummary,
    type Todo,
    type Usage,
} from "@justai/shared";

import {
    createSession,
    fetchSession,
    resolvePermission,
    sendMessage,
    stopSession,
    updateSession,
} from "../services/agentApi";
import { socketBus } from "../services/socket";

export interface ToolProgress {
    status: "running" | "done" | "error";
    preview?: string;
    /** Живой вывод команды (хвост). */
    output?: string;
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
    permissions: PermissionRequest[];
    todos: Todo[];
    run: RunStats | null;
    error: string;
}

const INITIAL: AgentSessionState = {
    session: null,
    messages: [],
    streamingText: "",
    streamingThinking: "",
    tools: {},
    permissions: [],
    todos: [],
    run: null,
    error: "",
};

const MAX_LIVE_OUTPUT = 20_000;

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
            permissions: details.pendingPermissions,
            todos: details.todos,
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

    const fail = useCallback((error: unknown) => {
        setState(previous => ({ ...previous, error: errorText(error) }));
    }, []);

    const open = useCallback(async (id: string) => {
        sessionIdRef.current = id;
        setState({ ...INITIAL });

        try {
            await reload(id);
        }
        catch (error) {
            fail(error);
        }
    }, [reload, fail]);

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
                    ...(options.mode ? { mode: options.mode } : {}),
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
            fail(error);
        }
    }, [fail]);

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
            fail(error);
        }
    }, [reload, fail]);

    const setMode = useCallback(async (mode: PermissionMode) => {
        const id = sessionIdRef.current;

        if (!id) {
            return;
        }

        try {
            const session = await updateSession(id, { mode });
            setState(previous => ({ ...previous, session }));
        }
        catch (error) {
            fail(error);
        }
    }, [fail]);

    const answer = useCallback(async (requestId: string, decision: PermissionDecision, note?: string) => {
        const id = sessionIdRef.current;

        if (!id) {
            return;
        }

        try {
            await resolvePermission(id, requestId, note ? { decision, note } : { decision });
        }
        catch (error) {
            fail(error);
            // Запрос мог истечь — синхронизируемся с сервером.
            await reload(id).catch(() => undefined);
        }
    }, [reload, fail]);

    return { ...state, open, reset, send, stop, setMode, answer };
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

        case "tool.progress": {
            const current = state.tools[event.toolUseId] ?? { status: "running" as const };
            const output = ((current.output ?? "") + event.chunk).slice(-MAX_LIVE_OUTPUT);

            return { ...state, tools: { ...state.tools, [event.toolUseId]: { ...current, output } } };
        }

        case "tool.finished": {
            const current = state.tools[event.toolUseId];

            return {
                ...state,
                tools: {
                    ...state.tools,
                    [event.toolUseId]: {
                        ...current,
                        status: event.isError ? "error" : "done",
                        preview: event.preview,
                    },
                },
            };
        }

        case "file.changed":
            // Дифф уже есть в результате инструмента; дерево и редактор обновляются по FILE_* событиям.
            return state;

        case "todo.updated":
            return { ...state, todos: event.todos };

        case "permission.request":
            return state.permissions.some(item => item.requestId === event.request.requestId)
                ? state
                : { ...state, permissions: [...state.permissions, event.request] };

        case "permission.resolved":
            return { ...state, permissions: state.permissions.filter(item => item.requestId !== event.requestId) };

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
