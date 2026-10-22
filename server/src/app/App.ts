import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { WorkspaceInfo } from '@justai/shared';

import { Container, resolveInstallRoot } from './Container.js';
import { Server } from './Server.js';
import { SettingsStore } from './SettingsStore.js';
import { WorkspaceSettings } from './WorkspaceSettings.js';

import { configureProxy } from '../infrastructure/network/proxy.js';

import { ConflictError } from '../core/errors/ConflictError.js';
import {
    FileCreatedEvent,
    FileSavedEvent,
    FileDeletedEvent,
    FileMovedEvent,
    FileRenamedEvent,
} from '../core/events/index.js';

import { WorkspaceLogger } from '../core/events/workspace/WorkspaceLogger.js';

export class App {

    private readonly settings =
        new WorkspaceSettings(resolveInstallRoot());

    private readonly config =
        new SettingsStore(resolveInstallRoot());

    private container: Container;

    private server: Server;

    private restarting?: Promise<void>;

    constructor() {

        this.applyConfig();
        this.container = new Container({ workspaceRoot: this.settings.currentRoot() });
        this.server = this.createServer();

    }

    public async start(): Promise<void> {

        // Фоновые процессы агента (dev-серверы) не должны пережить сервер.
        for (const signal of ['SIGINT', 'SIGTERM'] as const) {

            process.once(signal, () => {
                void this.container.dispose().finally(() => process.exit(0));
            });

        }

        await this.launch();

    }

    private createServer(): Server {

        return new Server(this.container, {
            info: () => this.info(),
            select: target => {
                if (this.container.sessionManager.busy) {
                    throw new ConflictError('Stop the agent before opening another folder.');
                }

                this.settings.open(target);
                return this.info();
            },
            settings: () => this.config.view(),
            updateSettings: values => {
                if (this.container.sessionManager.busy) {
                    throw new ConflictError('Stop the agent before changing settings.');
                }

                this.config.update(values);
                return this.config.view();
            },
            restart: () => {
                this.restarting ??= this.switchWorkspace()
                    .catch(error => console.error('Could not switch the project folder:', error))
                    .finally(() => { this.restarting = undefined; });
            },
        });

    }

    /** Настройки из интерфейса поверх server/.env, затем прокси (он зависит от настроек). */
    private applyConfig(): void {

        this.config.apply();

        const proxy = configureProxy(process.env);

        if (proxy) {
            console.log(`Outgoing requests go through proxy ${proxy.url} (except ${proxy.noProxy})`);
        }

    }

    private info(): WorkspaceInfo {

        const root = this.settings.currentRoot();

        return {
            root,
            name: path.basename(root),
            recent: this.settings.recent(),
            switchable: !this.settings.fixedByEnv,
        };

    }

    /**
     * Пересобрать контейнер на выбранной папке. Токен прежний — открытые вкладки продолжают работать.
     */
    private async switchWorkspace(): Promise<void> {

        const token = this.container.accessGuard.token;

        await this.server.stop();
        await this.container.dispose();

        this.applyConfig();
        this.container = new Container({ workspaceRoot: this.settings.currentRoot(), token });
        this.server = this.createServer();

        await this.launch();

    }

    private async launch(): Promise<void> {

        await this.container.initialize();

        this.container.webSocketGateway.initialize();

        const logger =
            new WorkspaceLogger();

        for (const event of [FileCreatedEvent, FileSavedEvent, FileDeletedEvent, FileMovedEvent, FileRenamedEvent]) {
            this.container.eventBus.subscribe(event, logger);
        }

        const config =
            this.container
                .getConfigService()
                .get();

        await this.writeRuntimeFile(
            config.port,
        );

        this.container.getLogger().info(`Project folder: ${this.container.getWorkspaceRoot()}`);

        this.server.start(
            config.port,
            config.host,
        );

    }

    /**
     * .justai/runtime.json — токен для локальных клиентов (CLI, скрипты).
     * Папка закрыта для инструментов агента; свой .gitignore не даёт ей попасть в git проекта.
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
            path.join(directory, '.gitignore'),
            '*\n',
            'utf8',
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
