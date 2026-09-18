import { Router } from "express";
import type { AIController } from "./AIController.js";

export function createAIRouter(controller: AIController): Router {
    const router = Router();

    router.get("/providers", controller.providers);
    router.get("/agents", controller.agents);
    router.post("/chat", controller.chat);

    router.get("/council/status", controller.councilStatus);
    router.post("/council/connect/:provider", controller.councilConnect);
    router.post("/council/run", controller.councilRun);

    return router;
}
