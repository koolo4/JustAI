import { useEffect, useRef, useState } from 'react';

import { socketBus, type SocketStatus } from '../services/socket';
import type { WorkspaceEvent } from '../types/workspace';

const WORKSPACE_EVENT_TYPES = new Set<string>([
    'FILE_CREATED',
    'FILE_SAVED',
    'FILE_DELETED',
    'FILE_MOVED',
    'FILE_RENAMED',
]);

export function useWorkspaceSocket(
    onEvent: (event: WorkspaceEvent) => void,
): SocketStatus {

    const [status, setStatus] =
        useState<SocketStatus>('connecting');

    const onEventRef = useRef(onEvent);

    useEffect(() => {
        onEventRef.current = onEvent;
    }, [onEvent]);

    useEffect(() => socketBus.onStatus(setStatus), []);

    useEffect(() => socketBus.subscribe(message => {
        const type = (message as { type?: unknown }).type;

        if (typeof type === 'string' && WORKSPACE_EVENT_TYPES.has(type)) {
            onEventRef.current(message as WorkspaceEvent);
        }
    }), []);

    return status;
}
