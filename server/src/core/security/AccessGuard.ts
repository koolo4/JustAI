import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { ForbiddenError } from '../errors/ForbiddenError.js';
import { UnauthorizedError } from '../errors/UnauthorizedError.js';

export interface AccessGuardOptions {

    /** Секрет сессии сервера; все /api запросы обязаны его предъявить. */
    token: string;

    /** Origin'ы фронта, которым разрешено обращаться к API. */
    allowedOrigins: string[];

    /** Допустимые значения заголовка Host (защита от DNS rebinding). */
    allowedHosts: string[];

    /** Пути без токена (OAuth-редиректы, health). Точное совпадение. */
    publicPaths: string[];

}

/**
 * Периметр локального сервера: агент умеет менять файлы и (в будущем) запускать команды,
 * поэтому любой сайт, открытый в браузере пользователя, не должен до него дотянуться.
 */
export class AccessGuard {

    private readonly tokenBuffer: Buffer;

    constructor(
        private readonly options: AccessGuardOptions,
    ) {
        this.tokenBuffer = Buffer.from(options.token);
    }

    public static generateToken(): string {
        return randomBytes(32).toString('hex');
    }

    public get token(): string {
        return this.options.token;
    }

    public get allowedOrigins(): string[] {
        return [...this.options.allowedOrigins];
    }

    public isHostAllowed(host: string | undefined): boolean {
        return host !== undefined &&
            this.options.allowedHosts.includes(host.toLowerCase());
    }

    /** Запрос без Origin (curl, навигация) допустим; чужой Origin — нет. */
    public isOriginAllowed(origin: string | undefined): boolean {
        return origin === undefined ||
            this.options.allowedOrigins.includes(origin);
    }

    public isTokenValid(candidate: string | undefined): boolean {
        if (!candidate) {
            return false;
        }

        const buffer = Buffer.from(candidate);

        return buffer.length === this.tokenBuffer.length &&
            timingSafeEqual(buffer, this.tokenBuffer);
    }

    /**
     * Проверка Host и Origin для всех запросов. Ставится до cors().
     */
    public perimeter(): RequestHandler {
        return (req: Request, _res: Response, next: NextFunction) => {
            if (!this.isHostAllowed(req.headers.host)) {
                next(new ForbiddenError('Host is not allowed.'));
                return;
            }

            if (!this.isOriginAllowed(req.headers.origin)) {
                next(new ForbiddenError('Origin is not allowed.'));
                return;
            }

            next();
        };
    }

    /**
     * Требует Bearer-токен для всех путей, кроме публичных.
     */
    public authenticate(): RequestHandler {
        return (req: Request, _res: Response, next: NextFunction) => {
            if (this.options.publicPaths.includes(req.path)) {
                next();
                return;
            }

            const header = req.headers.authorization;
            const token = header?.startsWith('Bearer ')
                ? header.slice('Bearer '.length)
                : undefined;

            if (!this.isTokenValid(token)) {
                next(new UnauthorizedError('Missing or invalid access token.'));
                return;
            }

            next();
        };
    }

    /**
     * Выдаёт токен фронту. Требует явный разрешённый Origin:
     * браузер всегда ставит его на cross-origin fetch, а чужой сайт подделать его не может.
     */
    public tokenEndpoint(): RequestHandler {
        return (req: Request, res: Response, next: NextFunction) => {
            const origin = req.headers.origin;

            if (!origin || !this.options.allowedOrigins.includes(origin)) {
                next(new ForbiddenError('Token is only issued to the JustAI frontend.'));
                return;
            }

            res.setHeader('Cache-Control', 'no-store');
            res.json({ token: this.options.token });
        };
    }

    /**
     * Проверка WebSocket upgrade: Host, обязательный разрешённый Origin и ?token=.
     */
    public verifyUpgrade(request: IncomingMessage): boolean {
        if (!this.isHostAllowed(request.headers.host)) {
            return false;
        }

        const origin = request.headers.origin;

        if (!origin || !this.options.allowedOrigins.includes(origin)) {
            return false;
        }

        const url = new URL(request.url ?? '/', 'http://localhost');

        return this.isTokenValid(url.searchParams.get('token') ?? undefined);
    }

}
