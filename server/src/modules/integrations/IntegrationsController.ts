import type {
    Request,
    Response,
    NextFunction,
} from "express";

import { MicrosoftOAuthService } from "./microsoft/MicrosoftOAuthService.js";

export class IntegrationsController {

    constructor(
        private readonly microsoft: MicrosoftOAuthService,
    ) {}

    public status = async (
        _req: Request,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            res.json({
                microsoft: await this.microsoft.status(),
            });
        }
        catch (error) {
            next(error);
        }
    };

    public connectMicrosoft = (
        _req: Request,
        res: Response,
        next: NextFunction,
    ): void => {
        try {
            res.redirect(
                this.microsoft.createAuthorizationUrl(),
            );
        }
        catch (error) {
            next(error);
        }
    };

    public microsoftCallback = async (
        req: Request,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            const code =
                String(req.query.code ?? "");

            const state =
                String(req.query.state ?? "");

            if (!code || !state) {
                throw new Error(
                    "Microsoft OAuth callback did not contain code/state.",
                );
            }

            await this.microsoft.handleCallback(
                code,
                state,
            );

            res.type("html").send(`
<!doctype html>
<html>
<head><meta charset="utf-8"><title>JustAI</title></head>
<body style="font-family: sans-serif; padding: 40px">
<h2>Microsoft connected</h2>
<p>You can close this window and return to JustAI.</p>
<script>window.close()</script>
</body>
</html>
`);
        }
        catch (error) {
            next(error);
        }
    };

    public disconnectMicrosoft = async (
        _req: Request,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            await this.microsoft.disconnect();

            res.json({
                success: true,
            });
        }
        catch (error) {
            next(error);
        }
    };
}
