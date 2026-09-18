import { EventBus } from '../../core/events/index.js';
import {
    FileCreatedEvent,
    FileSavedEvent,
    FileDeletedEvent,
    FileMovedEvent,
    FileRenamedEvent,
} from '../../core/events/index.js';

import { WebSocketConnectionManager } from './WebSocketConnectionManager.js';

export class WebSocketGateway {

    constructor(
        private readonly eventBus: EventBus,
        private readonly connectionManager: WebSocketConnectionManager,
    ) {}

    public initialize(): void {

        this.eventBus.subscribe(
            FileCreatedEvent,
            {
                handle: async (event) => {
                    this.connectionManager.broadcast({
                        type: 'FILE_CREATED',
                        path: event.path,
                        timestamp: event.timestamp,
                    });
                },
            },
        );

        this.eventBus.subscribe(
            FileSavedEvent,
            {
                handle: async (event) => {
                    this.connectionManager.broadcast({
                        type: 'FILE_SAVED',
                        path: event.path,
                        timestamp: event.timestamp,
                    });
                },
            },
        );

        this.eventBus.subscribe(
            FileDeletedEvent,
            {
                handle: async (event) => {
                    this.connectionManager.broadcast({
                        type: 'FILE_DELETED',
                        path: event.path,
                        timestamp: event.timestamp,
                    });
                },
            },
        );

        this.eventBus.subscribe(
            FileRenamedEvent,
            {
                handle: async (event) => {
                    this.connectionManager.broadcast({
                        type: 'FILE_RENAMED',
                        oldPath: event.oldPath,
                        newPath: event.newPath,
                        timestamp: event.timestamp,
                    });
                },
            },
        );

        this.eventBus.subscribe(
            FileMovedEvent,
            {
                handle: async (event) => {
                    this.connectionManager.broadcast({
                        type: 'FILE_MOVED',
                        source: event.source,
                        destination: event.destination,
                        timestamp: event.timestamp,
                    });
                },
            },
        );

    }

}