import express, {
    type Express,
} from 'express';

import cors from 'cors';
import http from 'node:http';

import { createAgentRouter } from '../modules/agent/AgentRoutes.js';

import { Container } from './Container.js';

import { ErrorHandlerMiddleware } from '../core/middleware/ErrorHandlerMiddleware.js';

import { createWorkspaceRouter } from '../modules/workspace/WorkspaceRoutes.js';
import { createIntegrationsRouter } from "../modules/integrations/index.js";

export class Server {

    private readonly app: Express;

    private readonly errorHandler: ErrorHandlerMiddleware;

    constructor(
        private readonly container: Container,
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

}
