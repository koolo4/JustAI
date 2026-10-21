import type { NextFunction, Request, Response } from "express";

import { AIService } from "./AIService.js";
import { ProviderFactory } from "./providers/ProviderFactory.js";
import { AgentProfileService } from "./agents/AgentProfileService.js";

import type { AIChatRequest } from "./contracts/AIChatRequest.js";

export class AIController {
    constructor(
        private readonly aiService: AIService,
        private readonly providerFactory: ProviderFactory,
        private readonly profiles: AgentProfileService,
    ) {}

    public agents = (_req: Request, res: Response): void => {
        res.json({ agents: this.profiles.list() });
    };

    public chat = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const request = req.body as AIChatRequest;
            if (!request.prompt?.trim()) {
                res.status(400).json({ error: "Prompt is required." });
                return;
            }
            res.json(await this.aiService.chat(request));
        } catch (error) {
            next(error);
        }
    };

    public providers = (_req: Request, res: Response): void => {
        res.json({ providers: this.providerFactory.list() });
    };
}
