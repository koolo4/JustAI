import express, {
    type Express,
} from 'express';

import cors from 'cors';
import http from 'node:http';

import { createAgentRouter } from '../modules/agent/AgentRoutes.js';

import type { SettingsResponse, WorkspaceInfo } from '@justai/shared';

import { Container } from './Container.js';
import { createProject } from './ProjectCreator.js';

import { BadRequestError } from '../core/errors/BadRequestError.js';
import { ErrorHandlerMiddleware } from '../core/middleware/ErrorHandlerMiddleware.js';

import { createWorkspaceRouter } from '../modules/workspace/WorkspaceRoutes.js';
import { createIntegrationsRouter } from "../modules/integrations/index.js";

/** Смена папки проекта и настроек: решает App, потому что для них пересоздаётся контейнер. */
export interface WorkspaceHooks {
    info(): WorkspaceInfo;
    /** Проверить и запомнить папку (ошибка — 400/409). */
    select(target: string): WorkspaceInfo;
    settings(): SettingsResponse;
    /** Проверить и сохранить настройки (ошибка — 400/409). */
    updateSettings(values: Record<string, string | null>): SettingsResponse;
    /** Перезапуститься с новой папкой/настройками; вызывается после отправки ответа. */
    restart(): void;
}

export class Server {

    private readonly app: Express;

    private readonly errorHandler: ErrorHandlerMiddleware;

    private httpServer?: http.Server;

    constructor(
        private readonly container: Container,
        private readonly workspace?: WorkspaceHooks,
    ) {

        this.app = express();

        this.errorHandler =
            new ErrorHandlerMiddleware();

        this.configure();
        this.routes();
        this.errors();

    }

    /**
     * Express-приложение без запуска сервера (для тестов).
     */
    public getApp(): Express {
        return this.app;
    }

    private configure(): void {

        const guard =
            this.container.accessGuard;

        this.app.disable(
            'x-powered-by',
        );

        this.app.use(
            guard.perimeter(),
        );

        this.app.use(
            cors({
                origin: guard.allowedOrigins,
                allowedHeaders: [
                    'Authorization',
                    'Content-Type',
                ],
            }),
        );

        this.app.use(
            express.json({
                limit: '5mb',
            }),
        );

        this.app.get(
            '/api/auth/token',
            guard.tokenEndpoint(),
        );

        this.app.use(
            guard.authenticate(),
        );

    }

    private routes(): void {

        this.app.use(
            '/api/agent',
            createAgentRouter(
                this.container.agentController,
            ),
        );

        const hooks =
            this.workspace;

        if (hooks) {

            this.app.get(
                '/api/workspace/info',
                (_req, res) => {
                    res.json(hooks.info());
                },
            );

            this.app.post(
                '/api/workspace/open',
                (req, res, next) => {
                    try {
                        const target = (req.body as { path?: unknown } | undefined)?.path;

                        if (typeof target !== 'string') {
                            throw new BadRequestError('Pass the folder path as "path".');
                        }

                        const info = hooks.select(target);
                        res.on('finish', () => hooks.restart());
                        res.status(202).json(info);
                    }
                    catch (error) {
                        next(error);
                    }
                },
            );

            // Новый проект: пустая папка с git или клон репозитория GitHub; сразу открывается.
            // bridge — сделать этот репозиторий репозиторием моста GitHub (настройка JUSTAI_GITHUB_REPO).
            this.app.post(
                '/api/workspace/create',
                (req, res, next) => {
                    void (async () => {
                        const body = (req.body ?? {}) as { parent?: unknown; name?: unknown; repo?: unknown; bridge?: unknown };

                        if (typeof body.parent !== 'string' || typeof body.name !== 'string') {
                            throw new BadRequestError('Pass "parent" (folder for the project) and "name".');
                        }

                        const repo = typeof body.repo === 'string' && body.repo.trim() ? body.repo.trim() : undefined;
                        const target = await createProject(
                            { parent: body.parent, name: body.name, ...(repo ? { repo } : {}) },
                            this.container.gitService,
                            process.env.JUSTAI_GITHUB_TOKEN,
                        );

                        const info = hooks.select(target);

                        if (repo && body.bridge === true) {
                            hooks.updateSettings({ JUSTAI_GITHUB_REPO: repo });
                        }

                        res.on('finish', () => hooks.restart());
                        res.status(202).json(info);
                    })().catch(next);
                },
            );

            this.app.get(
                '/api/settings',
                (_req, res) => {
                    res.json(hooks.settings());
                },
            );

            this.app.put(
                '/api/settings',
                (req, res, next) => {
                    try {
                        const values = (req.body as { values?: unknown } | undefined)?.values;

                        if (
                            !values || typeof values !== 'object' || Array.isArray(values) ||
                            !Object.values(values).every(value => value === null || typeof value === 'string')
                        ) {
                            throw new BadRequestError('Pass { values: { NAME: "value" | null } }.');
                        }

                        const result = hooks.updateSettings(values as Record<string, string | null>);
                        res.on('finish', () => hooks.restart());
                        res.status(202).json(result);
                    }
                    catch (error) {
                        next(error);
                    }
                },
            );

        }

        // Автодополнение в редакторе (локальная модель). Ошибки не показываются: просто нет подсказки.
        this.app.post('/api/completion', (req, res) => {
            const body = req.body as { path?: unknown; prefix?: unknown; suffix?: unknown } | undefined;

            if (typeof body?.prefix !== 'string' || typeof body.suffix !== 'string') {
                res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Pass prefix and suffix.' } });
                return;
            }

            const controller = new AbortController();
            res.on('close', () => controller.abort());

            this.container.completion
                .complete({ path: String(body.path ?? ''), prefix: body.prefix, suffix: body.suffix }, controller.signal)
                .then(completion => res.json({ completion, model: this.container.completion.model }))
                .catch(() => {
                    if (!res.headersSent) {
                        res.json({ completion: '', model: this.container.completion.model });
                    }
                });
        });

        // Терминалы пользователя: вывод приходит событиями terminal.output по WebSocket.
        const terminals =
            this.container.terminals;

        const size = (body: unknown) => {
            const value = body as { cols?: unknown; rows?: unknown } | undefined;
            return { cols: Number(value?.cols) || 80, rows: Number(value?.rows) || 24 };
        };

        const terminalId = (req: express.Request) => String(req.params.id ?? '');

        this.app.get('/api/terminals', (_req, res) => {
            res.json({ terminals: terminals.list() });
        });

        this.app.post('/api/terminals', (req, res, next) => {
            const { cols, rows } = size(req.body);

            terminals.create(cols, rows)
                .then(info => res.status(201).json(info))
                .catch(next);
        });

        this.app.post('/api/terminals/:id/input', (req, res, next) => {
            try {
                const data = (req.body as { data?: unknown } | undefined)?.data;

                if (typeof data !== 'string' || data.length > 100_000) {
                    throw new BadRequestError('Pass the typed text as "data" (at most 100 000 characters).');
                }

                terminals.write(terminalId(req), data);
                res.status(204).end();
            }
            catch (error) {
                next(error);
            }
        });

        this.app.post('/api/terminals/:id/resize', (req, res, next) => {
            try {
                const { cols, rows } = size(req.body);
                terminals.resize(terminalId(req), cols, rows);
                res.status(204).end();
            }
            catch (error) {
                next(error);
            }
        });

        this.app.delete('/api/terminals/:id', (req, res) => {
            terminals.close(terminalId(req));
            res.status(204).end();
        });

        // Мост GitHub: состояние исполнителя задач и ручная проверка.
        this.app.get('/api/github/status', (_req, res) => {
            const client = this.container.githubClient;
            const runner = this.container.githubRunner;

            res.json({
                configured: client !== null,
                repo: client?.repo ?? null,
                runner: runner?.getStatus() ?? null,
            });
        });

        this.app.post('/api/github/check', (_req, res, next) => {
            const runner = this.container.githubRunner;

            if (!runner) {
                next(new BadRequestError('The GitHub task runner is off: set the token and repository and enable it in Settings → GitHub.'));
                return;
            }

            void runner.check();
            res.status(202).json(runner.getStatus());
        });

        // Лента моста: события всех задач по порядку (after — id последнего полученного события).
        this.app.get('/api/github/feed', (req, res, next) => {
            const log = this.container.bridgeLog;

            if (!log) {
                res.json({ events: [] });
                return;
            }

            log.list({
                ...(typeof req.query.after === 'string' ? { after: req.query.after } : {}),
                ...(Number(req.query.limit) > 0 ? { limit: Number(req.query.limit) } : {}),
            }).then(events => res.json({ events }), next);
        });

        // Сообщение из ленты: комментарий в задачу (как от владельца токена — мост примет его как указание)
        // или, без номера, новая задача.
        this.app.post('/api/github/message', (req, res, next) => {
            void (async () => {
                const client = this.container.githubClient;
                const body = req.body as { issue?: unknown; text?: unknown };
                const text = typeof body.text === 'string' ? body.text.trim() : '';
                const issue = typeof body.issue === 'number' && Number.isInteger(body.issue) && body.issue > 0 ? body.issue : undefined;

                if (!client) throw new BadRequestError('GitHub is not configured: set the token and repository in Settings → GitHub.');
                if (!text || text.length > 30_000) throw new BadRequestError('Pass the message as "text" (1–30 000 characters).');

                if (issue) {
                    await client.comment(issue, text, false);
                    this.container.bridgeLog?.add({ kind: 'note', issue, text: `Вы: ${text.slice(0, 600)}` });
                    res.json({ issue, url: `https://github.com/${client.repo}/issues/${issue}` });
                    return;
                }

                const label = this.container.githubTaskLabel;
                const title = text.split('\n')[0]!.slice(0, 120);
                const created = await client.createIssue(title, `${text}\n\n/${label}`, [label]);
                this.container.bridgeLog?.add({ kind: 'note', issue: created.number, url: created.url, text: `Вы поставили задачу: ${title}` });
                res.json({ issue: created.number, url: created.url });
            })().catch(next);
        });

        // Подключённые MCP-серверы и их инструменты.
        this.app.get(
            '/api/agent/mcp',
            (_req, res) => {
                res.json({ configFiles: this.container.mcp.configFiles, servers: this.container.mcp.status() });
            },
        );

        // Ошибки компилятора и линтера для редактора (те же проверки, что у инструмента diagnostics).
        this.app.get(
            '/api/workspace/diagnostics',
            (req, res, next) => {
                const controller = new AbortController();
                res.on('close', () => controller.abort());

                this.container.diagnostics.run(controller.signal)
                    .then(result => res.json(result))
                    .catch(next);
            },
        );

        const workspaceRouter =
            createWorkspaceRouter(
                this.container.workspaceController,
            );

        this.app.use(
            '/api/workspace',
            workspaceRouter,
        );

        const integrationsRouter =
            createIntegrationsRouter(
                this.container.integrationsController,
            );

        this.app.use(
            "/api/integrations",
            integrationsRouter,
        );

        this.app.get(
            '/',
            (_, res) => {
                res.json({
                    name: "JustAI",
                    status: "ok",
                });
            },
        );

        this.app.get(
            '/api/health',
            (_, res) => {

                res.json({

                    status: 'ok',

                    version: '0.2.0',

                });

            },
        );

    }

    private errors(): void {

        this.app.use(
            this.errorHandler.handle.bind(
                this.errorHandler,
            ),
        );

    }

    /**
     * HTTP-сервер с WebSocket, без запуска (тесты слушают на случайном порту).
     */
    public createHttpServer(): http.Server {

        const httpServer =
            http.createServer(
                this.app,
            );

        this.container.webSocketConnectionManager.attach(
            httpServer,
            request =>
                this.container.accessGuard.verifyUpgrade(
                    request,
                ),
        );

        return httpServer;

    }

    public start(
        port: number,
        host: string,
    ): void {

        const logger =
            this.container.getLogger();

        const httpServer =
            this.createHttpServer();

        this.httpServer =
            httpServer;

        httpServer.listen(
            port,
            host,
            () => {

                logger.info(
                    `🚀 JustAI Server running on http://${host}:${port}`,
                );

            },
        );

    }

    /** Закрыть HTTP и WebSocket, чтобы порт освободился для нового контейнера. */
    public async stop(): Promise<void> {

        const httpServer =
            this.httpServer;

        if (!httpServer) {
            return;
        }

        this.container.webSocketConnectionManager.close();

        await new Promise<void>(resolve => {
            httpServer.close(() => resolve());
            httpServer.closeAllConnections();
        });

        this.httpServer = undefined;

    }

}
