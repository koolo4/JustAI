import type { IncomingMessage } from "node:http";

import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";

import { Container } from "../../../src/app/Container.js";
import { Server } from "../../../src/app/Server.js";
import { AccessGuard } from "../../../src/core/security/AccessGuard.js";

const TOKEN = "test-token-0123456789";
const HOST = "localhost:4302";
const FRONTEND = "http://localhost:3000";

describe("server perimeter", () => {
    let app: ReturnType<Server["getApp"]>;

    beforeAll(() => {
        process.env.JUSTAI_TOKEN = TOKEN;
        delete process.env.PORT;
        delete process.env.JUSTAI_ALLOWED_ORIGINS;
        app = new Server(new Container()).getApp();
    });

    it("rejects API calls without a token", async () => {
        const response = await request(app).get("/api/ai/agents").set("Host", HOST);
        expect(response.status).toBe(401);
    });

    it("rejects API calls with a wrong token", async () => {
        const response = await request(app)
            .get("/api/ai/agents")
            .set("Host", HOST)
            .set("Authorization", "Bearer wrong");
        expect(response.status).toBe(401);
    });

    it("accepts API calls with the token", async () => {
        const response = await request(app)
            .get("/api/ai/agents")
            .set("Host", HOST)
            .set("Origin", FRONTEND)
            .set("Authorization", `Bearer ${TOKEN}`);
        expect(response.status).toBe(200);
        expect(response.headers["access-control-allow-origin"]).toBe(FRONTEND);
    });

    it("rejects a foreign Origin even with a valid token", async () => {
        const response = await request(app)
            .post("/api/ai/chat")
            .set("Host", HOST)
            .set("Origin", "https://evil.example")
            .set("Authorization", `Bearer ${TOKEN}`)
            .send({ prompt: "hi" });
        expect(response.status).toBe(403);
    });

    it("rejects an unknown Host header (DNS rebinding)", async () => {
        const response = await request(app)
            .get("/api/health")
            .set("Host", "evil.example:4302");
        expect(response.status).toBe(403);
    });

    it("keeps health public", async () => {
        const response = await request(app).get("/api/health").set("Host", HOST);
        expect(response.status).toBe(200);
    });

    it("issues the token only to the allowed frontend origin", async () => {
        const allowed = await request(app)
            .get("/api/auth/token")
            .set("Host", HOST)
            .set("Origin", FRONTEND);
        expect(allowed.status).toBe(200);
        expect(allowed.body).toEqual({ token: TOKEN });

        const noOrigin = await request(app).get("/api/auth/token").set("Host", HOST);
        expect(noOrigin.status).toBe(403);

        const foreign = await request(app)
            .get("/api/auth/token")
            .set("Host", HOST)
            .set("Origin", "https://evil.example");
        expect(foreign.status).toBe(403);
    });
});

describe("AccessGuard.verifyUpgrade", () => {
    const guard = new AccessGuard({
        token: TOKEN,
        allowedOrigins: [FRONTEND],
        allowedHosts: [HOST],
        publicPaths: [],
    });

    function upgrade(url: string, headers: Record<string, string>): IncomingMessage {
        return { url, headers } as unknown as IncomingMessage;
    }

    it("accepts the frontend with a valid token", () => {
        expect(guard.verifyUpgrade(upgrade(`/?token=${TOKEN}`, { host: HOST, origin: FRONTEND }))).toBe(true);
    });

    it("rejects missing token, foreign origin, missing origin and wrong host", () => {
        expect(guard.verifyUpgrade(upgrade("/", { host: HOST, origin: FRONTEND }))).toBe(false);
        expect(guard.verifyUpgrade(upgrade(`/?token=${TOKEN}`, { host: HOST, origin: "https://evil.example" }))).toBe(false);
        expect(guard.verifyUpgrade(upgrade(`/?token=${TOKEN}`, { host: HOST }))).toBe(false);
        expect(guard.verifyUpgrade(upgrade(`/?token=${TOKEN}`, { host: "evil.example:4302", origin: FRONTEND }))).toBe(false);
    });
});
