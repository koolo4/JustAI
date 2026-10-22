import { Router } from "express";

import type { AgentController } from "./AgentController.js";

export function createAgentRouter(controller: AgentController): Router {
    const router = Router();

    router.get("/providers", controller.listProviders);
    router.get("/profiles", controller.listProfiles);

    router.get("/sessions", controller.listSessions);
    router.post("/sessions", controller.createSession);
    router.get("/sessions/:id", controller.getSession);
    router.patch("/sessions/:id", controller.updateSession);
    router.post("/sessions/:id/permissions/:requestId", controller.resolvePermission);
    router.post("/sessions/:id/messages", controller.sendMessage);
    router.post("/sessions/:id/stop", controller.stopSession);
    router.get("/sessions/:id/changes", controller.sessionChanges);
    router.post("/sessions/:id/revert", controller.revertSession);
    router.post("/sessions/:id/accept", controller.acceptSession);

    return router;
}
