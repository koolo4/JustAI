import type { AddressInfo } from "node:net";
import type http from "node:http";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { isAgentEvent, type AgentEvent } from "@justai/shared";

import { Container } from "../../../src/app/Container.js";
import { Server } from "../../../src/app/Server.js";
import { createTempWorkspace, type TempWorkspace } from "../../helpers/tempWorkspace.js";

const TOKEN = "agent-api-test-token";
const HOST = "localhost:4302";
const ORIGIN = "http://localhost:3000";

describe("agent REST + WebSocket", () => {
    let workspace: TempWorkspace;
    let httpServer: http.Server;
    let socket: WebSocket;
    const events: AgentEvent[] = [];

    const api = () => ({
        get: (url: string) => request(httpServer).get(url).set("Host", HOST).set("Authorization", `Bearer ${TOKEN}`),
        post: (url: string) => request(httpServer).post(url).set("Host", HOST).set("Authorization", `Bearer ${TOKEN}`),
    });

    beforeAll(async () => {
        workspace = await createTempWorkspace();
        await workspace.write("README.md", "# Demo project\n");

        process.env.JUSTAI_TOKEN = TOKEN;
        process.env.JUSTAI_WORKSPACE = workspace.root;
        process.env.JUSTAI_PROVIDER = "mock";
        delete process.env.PORT;

        const container = new Container();
        await container.initialize();

        httpServer = new Server(container).createHttpServer();
        await new Promise<void>(resolve => httpServer.listen(0, "127.0.0.1", resolve));

        const { port } = httpServer.address() as AddressInfo;

        socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`, {
            headers: { Host: HOST },
            origin: ORIGIN,
        });

        socket.on("message", data => {
            const parsed: unknown = JSON.parse(String(data));
            if (isAgentEvent(parsed)) {
                events.push(parsed);
            }
        });

        await new Promise<void>((resolve, reject) => {
            socket.once("open", () => resolve());
            socket.once("error", reject);
        });
    });

    afterAll(async () => {
        socket?.close();
        await new Promise(resolve => httpServer?.close(resolve));
        delete process.env.JUSTAI_WORKSPACE;
        delete process.env.JUSTAI_PROVIDER;
        await workspace.dispose();
    });

    it("lists providers and profiles", async () => {
        const providers = await api().get("/api/agent/providers");
        expect(providers.status).toBe(200);
        expect(providers.body.defaultProvider).toBe("mock");

        const profiles = await api().get("/api/agent/profiles");
        expect(profiles.body.profiles.map((p: { id: string }) => p.id)).toContain("coder");
    });

    it("runs a session end to end and streams events over WebSocket", async () => {
        const created = await api().post("/api/agent/sessions").send({});
        expect(created.status).toBe(201);
        const id: string = created.body.session.id;

        const sent = await api().post(`/api/agent/sessions/${id}/messages`).send({ text: "прочитай README.md" });
        expect(sent.status).toBe(202);

        await waitFor(() =>
            events.some(event => event.type === "session.status" && event.sessionId === id && event.status === "completed"),
        );

        const types = events.filter(event => event.sessionId === id).map(event => event.type);
        expect(types).toContain("assistant.delta");
        expect(types).toContain("tool.started");
        expect(types).toContain("tool.finished");
        expect(types).toContain("message.added");

        const details = await api().get(`/api/agent/sessions/${id}`);
        expect(details.body.session.status).toBe("completed");
        expect(JSON.stringify(details.body.messages)).toContain("# Demo project");

        const list = await api().get("/api/agent/sessions");
        expect(list.body.sessions.map((s: { id: string }) => s.id)).toContain(id);
    });

    it("validates input and reports unknown sessions", async () => {
        const created = await api().post("/api/agent/sessions").send({ provider: "nope" });
        expect(created.status).toBe(400);

        const empty = await api().post("/api/agent/sessions/missing/messages").send({ text: "" });
        expect(empty.status).toBe(400);

        const missing = await api().get("/api/agent/sessions/does-not-exist");
        expect(missing.status).toBe(404);
    });
});

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
    const started = Date.now();

    while (!condition()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error("Timed out waiting for condition.");
        }

        await new Promise(resolve => setTimeout(resolve, 20));
    }
}
