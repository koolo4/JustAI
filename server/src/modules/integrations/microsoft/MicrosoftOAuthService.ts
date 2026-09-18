import crypto from "node:crypto";
import type { MicrosoftTokenStore } from "./MicrosoftTokenStore.js";
import type { StoredToken } from "./MicrosoftTokenStore.js";

interface MicrosoftOAuthConfig {
    clientId: string;
    clientSecret: string;
    tenant: string;
    redirectUri: string;
}

export class MicrosoftOAuthService {

    private readonly stateStore =
        new Map<string, number>();

    constructor(
        private readonly config: MicrosoftOAuthConfig,
        private readonly tokenStore: MicrosoftTokenStore,
    ) {}

    public isConfigured(): boolean {
        return Boolean(
            this.config.clientId &&
            this.config.clientSecret &&
            this.config.redirectUri,
        );
    }

    public createAuthorizationUrl(): string {
        if (!this.isConfigured()) {
            throw new Error(
                "Microsoft OAuth is not configured. Set MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET and MICROSOFT_REDIRECT_URI.",
            );
        }

        const state =
            crypto.randomBytes(24).toString("hex");

        this.stateStore.set(
            state,
            Date.now() + 10 * 60 * 1000,
        );

        const params = new URLSearchParams({
            client_id: this.config.clientId,
            response_type: "code",
            redirect_uri: this.config.redirectUri,
            response_mode: "query",
            scope: [
                "openid",
                "profile",
                "offline_access",
                "User.Read",
                "Files.ReadWrite",
            ].join(" "),
            state,
        });

        return `https://login.microsoftonline.com/${encodeURIComponent(this.config.tenant)}/oauth2/v2.0/authorize?${params.toString()}`;
    }

    public async handleCallback(
        code: string,
        state: string,
    ): Promise<void> {
        const expires =
            this.stateStore.get(state);

        this.stateStore.delete(state);

        if (!expires || expires < Date.now()) {
            throw new Error("Microsoft OAuth state is invalid or expired.");
        }

        const tokenResponse =
            await fetch(
                `https://login.microsoftonline.com/${encodeURIComponent(this.config.tenant)}/oauth2/v2.0/token`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    body: new URLSearchParams({
                        client_id: this.config.clientId,
                        client_secret: this.config.clientSecret,
                        grant_type: "authorization_code",
                        code,
                        redirect_uri: this.config.redirectUri,
                        scope: [
                            "openid",
                            "profile",
                            "offline_access",
                            "User.Read",
                            "Files.ReadWrite",
                        ].join(" "),
                    }),
                },
            );

        if (!tokenResponse.ok) {
            throw new Error(
                `Microsoft token exchange failed: ${await tokenResponse.text()}`,
            );
        }

        const data =
            await tokenResponse.json() as {
                access_token: string;
                refresh_token?: string;
                expires_in?: number;
            };

        if (!data.access_token || !data.refresh_token) {
            throw new Error(
                "Microsoft did not return the access/refresh token required by JustAI.",
            );
        }

        await this.tokenStore.save({
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresAt:
                Date.now() +
                Math.max(
                    60,
                    data.expires_in ?? 3600,
                ) *
                1000,
        });
    }

    public async getAccessToken(): Promise<string> {
        const stored =
            await this.tokenStore.load();

        if (!stored) {
            throw new Error(
                "Microsoft account is not connected.",
            );
        }

        if (stored.expiresAt > Date.now() + 60_000) {
            return stored.accessToken;
        }

        const response =
            await fetch(
                `https://login.microsoftonline.com/${encodeURIComponent(this.config.tenant)}/oauth2/v2.0/token`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    body: new URLSearchParams({
                        client_id: this.config.clientId,
                        client_secret: this.config.clientSecret,
                        grant_type: "refresh_token",
                        refresh_token: stored.refreshToken,
                        scope: [
                            "openid",
                            "profile",
                            "offline_access",
                            "User.Read",
                            "Files.ReadWrite",
                        ].join(" "),
                    }),
                },
            );

        if (!response.ok) {
            throw new Error(
                `Microsoft token refresh failed: ${await response.text()}`,
            );
        }

        const data =
            await response.json() as {
                access_token: string;
                refresh_token?: string;
                expires_in?: number;
            };

        const next: StoredToken = {
            accessToken: data.access_token,
            refreshToken:
                data.refresh_token ??
                stored.refreshToken,
            expiresAt:
                Date.now() +
                Math.max(
                    60,
                    data.expires_in ?? 3600,
                ) *
                1000,
        };

        await this.tokenStore.save(next);

        return next.accessToken;
    }

    public async status(): Promise<{
        configured: boolean;
        connected: boolean;
    }> {
        return {
            configured: this.isConfigured(),
            connected: Boolean(await this.tokenStore.load()),
        };
    }

    public async disconnect(): Promise<void> {
        await this.tokenStore.clear();
    }
}
