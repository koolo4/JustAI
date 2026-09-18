import { Router } from "express";
import type { IntegrationsController } from "./IntegrationsController.js";

export function createIntegrationsRouter(
    controller: IntegrationsController,
): Router {
    const router = Router();

    router.get(
        "/status",
        controller.status,
    );

    router.get(
        "/microsoft/connect",
        controller.connectMicrosoft,
    );

    router.get(
        "/microsoft/callback",
        controller.microsoftCallback,
    );

    router.post(
        "/microsoft/disconnect",
        controller.disconnectMicrosoft,
    );

    return router;
}
