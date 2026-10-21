import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentEvent } from "@justai/shared";

import { ConflictError } from "../../../src/core/errors/ConflictError.js";
import { AgentProfiles } from "../../../src/modules/agent/profiles.js";
import { ProviderRegistry } from "../../../src/modules/agent/providers/ProviderRegistry.js";
import { createMessage } from "../../../src/modules/agent/runtime/AgentLoop.js";
import { DEFAULT_BUDGET } from "../../../src/modules/agent/runtime/Budget.js";
import { repairHistory, SessionManager } from "../../../src/modules/agent/runtime/SessionManager.js";
import { SessionStore } from "../../../src/modules/agent/runtime/SessionStore.js";
import { EventBus } from "../../../src/core/events/index.js";
import { AgentFileSystem } from "../../../src/modules/agent/tools/AgentFileSystem.js";
import { createFileTools } from "../../../src/modules/agent/tools/fileTools.js";
import { ToolRegistry } from "../../../src/modules/agent/tools/ToolRegistry.js";
import { createTempWorkspace, type TempWorkspace } from "../../helpers/tempWorkspace.js";

describe("SessionManager", () => {
    let workspace: TempWorkspace;
    let events: AgentEvent[];

    beforeEach(async () => {
        workspace = await createTempWorkspace();
        await workspace.write("AGENTS.md", "Always write tests.");
        await workspace.write("src/index.ts", "export const answer = 42;\n");
        events = [];
    });

    afterEach(async () => {
        await workspace.dispose();
    });

    function manager(): SessionManager {
        const tools = new ToolRegistry();
        const files = new AgentFileSystem(workspace.root, new EventBus(), event => events.push(event));
        createFileTools(files, () => false).forEach(tool => tools.register(tool));

        return new SessionManager({
            store: new SessionStore(path.join(workspace.root, ".justai", "sessions")),
            providers: new ProviderRegistry({}),
            tools,
            profiles: new AgentProfiles(),
            workspaceRoot: workspace.root,
            shouldIgnore: name => name === ".justai",
            limits: DEFAULT_BUDGET,
            emit: event => events.push(event),
        });
    }

    it("creates a session with a frozen system prompt that includes project rules", async () => {
        const sessions = manager();
        const summary = await sessions.create({ provider: "mock" });

        expect(summary).toMatchObject({ provider: "mock", profile: "coder", status: "idle" });

        const store = new SessionStore(path.join(workspace.root, ".justai", "sessions"));
        const stored = await store.load(summary.id);

        expect(stored?.system).toContain("Always write tests.");
        expect(stored?.system).toContain("src/");
    });

    it("runs the agent, persists messages and resumes after a restart", async () => {
        const first = manager();
        const { id } = await first.create({ provider: "mock" });

        await first.send(id, { text: "прочитай src/index.ts" });
        await first.waitForIdle(id);

        const details = await first.get(id);
        expect(details.session.status).toBe("completed");
        expect(details.session.title).toBe("прочитай src/index.ts");
        expect(details.messages.map(m => m.role)).toEqual(["user", "assistant", "user", "assistant"]);

        const toolResult = details.messages[2]!.content[0];
        expect(toolResult).toMatchObject({ type: "tool_result", isError: false, content: expect.stringContaining("answer = 42") });

        const types = events.map(event => event.type);
        expect(types).toContain("tool.started");
        expect(types.at(-1)).toBe("session.status");

        // «Перезапуск сервера»: новый менеджер читает ту же сессию с диска.
        const second = manager();
        const restored = await second.get(id);
        expect(restored.messages).toHaveLength(4);

        await second.send(id, { text: "hello again" });
        await second.waitForIdle(id);

        expect((await second.get(id)).messages).toHaveLength(6);
        expect((await second.list()).map(s => s.id)).toEqual([id]);
    });

    it("rejects a second message while the agent is running", async () => {
        const sessions = manager();
        const { id } = await sessions.create({ provider: "mock" });

        const first = sessions.send(id, { text: "one" });
        await expect(sessions.send(id, { text: "two" })).rejects.toBeInstanceOf(ConflictError);

        await first;
        await sessions.waitForIdle(id);
    });

    it("rejects unknown providers and profiles", async () => {
        const sessions = manager();

        await expect(sessions.create({ provider: "nope" })).rejects.toThrow("Unknown AI provider");
        await expect(sessions.create({ profile: "nope" })).rejects.toThrow("Unknown agent profile");
    });

    it("never exposes providerRaw to clients", async () => {
        const sessions = manager();
        const { id } = await sessions.create({ provider: "mock" });

        await sessions.send(id, { text: "hi" });
        await sessions.waitForIdle(id);

        const added = events.filter(event => event.type === "message.added");
        expect(added.length).toBeGreaterThan(0);
        expect(JSON.stringify(added)).not.toContain("providerRaw");
    });
});

describe("repairHistory", () => {
    it("answers dangling tool calls left by an interrupted run", () => {
        const assistant = createMessage("assistant", [
            { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } },
        ]);

        const repair = repairHistory([assistant]);

        expect(repair?.role).toBe("user");
        expect(repair?.content).toEqual([
            expect.objectContaining({ type: "tool_result", toolUseId: "t1", isError: true }),
        ]);
        expect(repairHistory([createMessage("assistant", [{ type: "text", text: "ok" }])])).toBeNull();
    });
});
