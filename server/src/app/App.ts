import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

        // Фоновые процессы агента (dev-серверы) не должны пережить сервер.
        for (const signal of ['SIGINT', 'SIGTERM'] as const) {

            process.once(signal, () => {

                void this.container.processManager
                    .killAll()
                    .finally(() => process.exit(0));

            });

        }

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

        await this.writeRuntimeFile(
            config.port,
        );

        this.server.start(
            config.port,
            config.host,
        );

    }

    /**
     * .justai/runtime.json — токен для локальных клиентов (CLI, скрипты).
     * Папка в .gitignore и закрыта для инструментов агента.
     */
    private async writeRuntimeFile(
        port: number,
    ): Promise<void> {

        const directory =
            path.join(
                this.container.getWorkspaceRoot(),
                '.justai',
            );

        await mkdir(
            directory,
            {
                recursive: true,
            },
        );

        await writeFile(
            path.join(
                directory,
                'runtime.json',
            ),
            JSON.stringify(
                {
                    port,
                    pid: process.pid,
                    token: this.container.accessGuard.token,
                },
                null,
                2,
            ),
            {
                encoding: 'utf8',
                mode: 0o600,
            },
        );

    }

}