import express, {
    type Express,
} from 'express';

import cors from 'cors';
import http from 'node:http';

import { createAIRouter } from '../modules/ai/index.js';

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

    private configure(): void {

        this.app.use(
            cors(),
        );

        this.app.use(
            express.json(),
        );

    }

    private routes(): void {

        const aiRouter =
            createAIRouter(
                this.container.aiController,
            );

        this.app.use(
            '/api/ai',
            aiRouter,
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
                    web: "http://localhost:3000/",
                    health: "http://localhost:4302/api/health",
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

    public start(
        port: number,
    ): void {

        const logger =
            this.container.getLogger();

        const httpServer =
            http.createServer(
                this.app,
            );

        this.container.webSocketConnectionManager.attach(
            httpServer,
        );

        httpServer.listen(
            port,
            () => {

                logger.info(
                    `🚀 JustAI Server running on http://localhost:${port}`,
                );

            },
        );

    }

}