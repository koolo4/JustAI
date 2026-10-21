import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentEvent, ToolResultBlock } from "@justai/shared";

import { EventBus } from "../../../src/core/events/index.js";
import { PermissionService } from "../../../src/modules/agent/permissions/PermissionService.js";
import { AgentProfiles } from "../../../src/modules/agent/profiles.js";
import type { MockScript } from "../../../src/modules/agent/providers/MockProvider.js";
import { DEFAULT_BUDGET } from "../../../src/modules/agent/runtime/Budget.js";
import { ExecutorRunner } from "../../../src/modules/agent/runtime/ExecutorRunner.js";
import { SessionManager } from "../../../src/modules/agent/runtime/SessionManager.js";
import { SessionStore } from "../../../src/modules/agent/runtime/SessionStore.js";
import { AgentFileSystem } from "../../../src/modules/agent/tools/AgentFileSystem.js";
import { createFileTools } from "../../../src/modules/agent/tools/fileTools.js";
import { createSpawnTool } from "../../../src/modules/agent/tools/spawnTool.js";
import { ToolRegistry } from "../../../src/modules/agent/tools/ToolRegistry.js";
import { ScriptedRegistry } from "../../helpers/scriptedProviders.js";
import { createTempWorkspace, type TempWorkspace } from "../../helpers/tempWorkspace.js";

describe("spawn_agent helpers", () => {
    let workspace: TempWorkspace;
    let events: AgentEvent[];

    beforeEach(async () => {
        workspace = await createTempWorkspace();
        await workspace.write("src/auth.ts", "export function login() {}\n");
        await workspace.write("src/db.ts", "export const pool = {};\n");
        events = [];
    });

    afterEach(async () => {
        await workspace.dispose();
    });

    function setup(main: MockScript, helper: MockScript) {
        const emit = (event: AgentEvent) => {
            events.push(event);
        };

        const providers = new ScriptedRegistry({ main, helper });
        const profiles = new AgentProfiles();
        const tools = new ToolRegistry();
        const permissions = new PermissionService({ rulesFile: path.join(workspace.root, ".justai", "p.json"), emit });
        let sessions: SessionManager;

        for (const tool of [
            ...createFileTools(new AgentFileSystem(workspace.root, new EventBus(), emit), () => false),
            createSpawnTool(() => (input, context) => sessions.spawn(input, context)),
        ]) {
            tools.register(tool);
        }

        sessions = new SessionManager({
            store: new SessionStore(path.join(workspace.root, ".justai", "sessions")),
            providers,
            tools,
            profiles,
            workspaceRoot: workspace.root,
            shouldIgnore: () => false,
            limits: DEFAULT_BUDGET,
            permissions,
            subagentProvider: "helper",
            executor: {
                defaultProvider: "helper",
                runner: new ExecutorRunner({
                    providers, tools, profiles, permissions,
                    workspaceRoot: workspace.root,
                    shouldIgnore: () => false,
                    limits: { ...DEFAULT_BUDGET, maxSteps: 5 },
                }),
            },
            emit,
        });

        return { sessions, providers };
    }

    it("runs two helpers in parallel and returns both answers", async () => {
        const { sessions, providers } = setup(
            [
                {
                    toolCalls: [
                        { name: "spawn_agent", input: { kind: "explore", task: "Where is login implemented?" } },
                        { name: "spawn_agent", input: { kind: "explore", task: "Where is the database pool defined?" } },
                    ],
                },
                { text: "login is in src/auth.ts, the pool in src/db.ts." },
            ],
            // Каждый помощник отвечает на свой вопрос; задержка проверяет параллельность.
            request => {
                const task = JSON.stringify(request.messages[0]?.content);
                return { delayMs: 400, text: task.includes("login") ? "login() is in src/auth.ts:1" : "pool is in src/db.ts:1" };
            },
        );

        const { id } = await sessions.create({ provider: "main" });
        const started = Date.now();
        await sessions.send(id, { text: "Explain the project" });
        await sessions.waitForIdle(id);
        const elapsed = Date.now() - started;

        const details = await sessions.get(id);
        expect(details.session.status).toBe("completed");

        const results = details.messages[2]!.content as ToolResultBlock[];
        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({ isError: false, content: expect.stringContaining("login() is in src/auth.ts:1") });
        expect(results[1]).toMatchObject({ isError: false, content: expect.stringContaining("pool is in src/db.ts:1") });

        // Два помощника по 400 мс параллельно: заметно меньше 800 мс последовательной работы.
        expect(elapsed).toBeLessThan(750);

        // Помощники использовали отдельную модель (subagentProvider) и read-only профиль.
        const helperRequests = providers.created.filter(mock => (mock.id as string) === "helper").flatMap(mock => mock.requests);
        expect(helperRequests).toHaveLength(2);
        expect(helperRequests[0]!.tools.map(tool => tool.name)).not.toContain("write_file");
        expect(helperRequests[0]!.system).toContain("read-only research helper");

        const progress = events.filter(event => event.type === "tool.progress").map(event => (event as { chunk: string }).chunk).join("");
        expect(progress).toContain("Explorer helper / helper-model started.");
    });

    it("reports a helper without an answer as a tool error", async () => {
        const { sessions } = setup(
            [
                { toolCalls: [{ name: "spawn_agent", input: { kind: "review", task: "Review the current changes please." } }] },
                { text: "The reviewer failed." },
            ],
            [{ toolCalls: [] }],
        );

        const { id } = await sessions.create({ provider: "main" });
        await sessions.send(id, { text: "review" });
        await sessions.waitForIdle(id);

        const result = (await sessions.get(id)).messages[2]!.content[0];
        expect(result).toMatchObject({ isError: true, content: expect.stringContaining("did not produce an answer") });
    });
});
