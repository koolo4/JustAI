import { useEffect, useRef, useState } from 'react';

import { getSocketUrl, resetToken } from '../services/http';
import type { WorkspaceEvent } from '../types/workspace';

const RECONNECT_DELAY_MS = 2000;

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

        let socket: WebSocket | null = null;
        let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
        let disposed = false;

        const scheduleReconnect = () => {
            if (disposed) {
                return;
            }

            setStatus('closed');
            // после перезапуска сервера токен другой
            resetToken();
            reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        };

        async function connect() {
            setStatus('connecting');

            let url: string;

            try {
                url = await getSocketUrl();
            }
            catch {
                scheduleReconnect();
                return;
            }

            if (disposed) {
                return;
            }

            socket = new WebSocket(url);

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

            socket.onclose = scheduleReconnect;
        }

        void connect();

        return () => {
            disposed = true;
            clearTimeout(reconnectTimer);
            socket?.close();
        };

    }, []);

    return status;
}
