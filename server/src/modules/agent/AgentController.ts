import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";

import {
    PERMISSION_MODES,
    type PermissionMode,
} from "@justai/shared";
import type {
    AgentProfileListResponse,
    CreateSessionResponse,
    ProviderListResponse,
    SessionDetails,
    SessionListResponse,
} from "@justai/shared";

import { BadRequestError } from "../../core/errors/BadRequestError.js";
import type { AgentProfiles } from "./profiles.js";
import type { ProviderRegistry } from "./providers/ProviderRegistry.js";
import type { SessionManager } from "./runtime/SessionManager.js";

const createSessionSchema = z.object({
    profile: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    mode: z.enum(PERMISSION_MODES as [PermissionMode, ...PermissionMode[]]).optional(),
});

const modeSchema = z.enum(PERMISSION_MODES as [PermissionMode, ...PermissionMode[]]);

const updateSessionSchema = z.object({
    mode: modeSchema,
});

const resolvePermissionSchema = z.object({
    decision: z.enum(["allow", "allow_always", "deny"]),
    note: z.string().max(2000).optional(),
});

const sendMessageSchema = z.object({
    text: z.string().trim().min(1, "Message text is required.").max(200_000),
    activeFile: z.string().max(1000).optional(),
});

export class AgentController {

    constructor(
        private readonly sessions: SessionManager,
        private readonly providers: ProviderRegistry,
        private readonly profiles: AgentProfiles,
    ) {}

    public listProviders: RequestHandler = (_req, res) => {
        const body: ProviderListResponse = {
            providers: this.providers.list(),
            defaultProvider: this.providers.defaultProvider,
        };

        res.json(body);
    };

    public listProfiles: RequestHandler = (_req, res) => {
        const body: AgentProfileListResponse = { profiles: this.profiles.list() };
        res.json(body);
    };

    public listSessions = handle(async (_req, res) => {
        const body: SessionListResponse = { sessions: await this.sessions.list() };
        res.json(body);
    });

    public createSession = handle(async (req, res) => {
        const input = parse(createSessionSchema, req.body);
        const body: CreateSessionResponse = { session: await this.sessions.create(input) };
        res.status(201).json(body);
    });

    public getSession = handle(async (req, res) => {
        const body: SessionDetails = await this.sessions.get(sessionId(req));
        res.json(body);
    });

    public sendMessage = handle(async (req, res) => {
        const input = parse(sendMessageSchema, req.body);
        const session = await this.sessions.send(sessionId(req), input);
        res.status(202).json({ session });
    });

    public updateSession = handle(async (req, res) => {
        const input = parse(updateSessionSchema, req.body);
        const session = await this.sessions.setMode(sessionId(req), input.mode);
        res.json({ session });
    });

    public resolvePermission = handle(async (req, res) => {
        const input = parse(resolvePermissionSchema, req.body);
        const requestId = req.params.requestId;

        if (typeof requestId !== "string" || !requestId) {
            throw new BadRequestError("Request id is required.");
        }

        await this.sessions.resolvePermission(sessionId(req), requestId, input.decision, input.note);
        res.status(204).end();
    });

    public sessionChanges = handle(async (req, res) => {
        res.json(await this.sessions.changes(sessionId(req)));
    });

    public revertSession = handle(async (req, res) => {
        res.json(await this.sessions.revert(sessionId(req)));
    });

    public stopSession = handle(async (req, res) => {
        const session = await this.sessions.stop(sessionId(req));
        res.json({ session });
    });
}

/** Express 4 не ловит ошибки async-обработчиков сам. */
function handle(
    action: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        action(req, res).catch(next);
    };
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
    const result = schema.safeParse(body ?? {});

    if (!result.success) {
        throw new BadRequestError(z.prettifyError(result.error));
    }

    return result.data;
}

function sessionId(req: Request): string {
    const id = req.params.id;

    if (typeof id !== "string" || !id) {
        throw new BadRequestError("Session id is required.");
    }

    return id;
}
