import { useEffect, useRef, useState } from 'react';
import type { WorkspaceEvent } from '../types/workspace';

export function useWorkspaceSocket(
    onEvent: (event: WorkspaceEvent) => void,
): 'connecting' | 'open' | 'closed' {

    const [status, setStatus] =
        useState<'connecting' | 'open' | 'closed'>('connecting');

    const onEventRef = useRef(onEvent);

    useEffect(() => {
        onEventRef.current = onEvent;
    }, [onEvent]);

    useEffect(() => {

        const socket =
            new WebSocket('ws://localhost:4302');

        socket.onopen = () => {
            setStatus('open');
        };

        socket.onmessage = (message) => {
            try {
                const event =
                    JSON.parse(
                        message.data,
                    ) as WorkspaceEvent;

                onEventRef.current(event);
            }
            catch {
                // ignore malformed messages
            }
        };

        socket.onclose = () => {
            setStatus('closed');
        };

        socket.onerror = () => {
            setStatus('closed');
        };

        return () => {
            socket.close();
        };

    }, []);

    return status;
}