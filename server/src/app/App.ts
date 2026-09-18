import { Container } from './Container.js';
import { Server } from './Server.js';

import {
    FileCreatedEvent,
    FileSavedEvent,
    FileDeletedEvent,
    FileMovedEvent,
    FileRenamedEvent,
} from '../core/events/index.js';

import { WorkspaceLogger } from '../core/events/workspace/WorkspaceLogger.js';

export class App {

    private readonly container: Container;

    private readonly server: Server;

    constructor() {

        this.container = new Container();

        this.server = new Server(
            this.container,
        );

    }

    public async start(): Promise<void> {

        await this.container.initialize();

        this.container.webSocketGateway.initialize();

        const logger =
            new WorkspaceLogger();

        this.container.eventBus.subscribe(
            FileCreatedEvent,
            logger,
        );

        this.container.eventBus.subscribe(
            FileSavedEvent,
            logger,
        );

        this.container.eventBus.subscribe(
            FileDeletedEvent,
            logger,
        );

        this.container.eventBus.subscribe(
            FileMovedEvent,
            logger,
        );

        this.container.eventBus.subscribe(
            FileRenamedEvent,
            logger,
        );

        const config =
            this.container
                .getConfigService()
                .get();

        this.server.start(
            config.port,
        );

    }

}