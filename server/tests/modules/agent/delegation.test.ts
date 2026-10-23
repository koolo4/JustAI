import { existsSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentEvent } from "@justai/shared";

import { EventBus } from "../../../src/core/events/index.js";
import { PermissionService } from "../../../src/modules/agent/permissions/PermissionService.js";
import { AgentProfiles } from "../../../src/modules/agent/profiles.js";
import { MockProvider, type MockScript } from "../../../src/modules/agent/providers/MockProvider.js";
import type { ModelProvider } from "../../../src/modules/agent/providers/ModelProvider.js";
import { ProviderRegistry } from "../../../src/modules/agent/providers/ProviderRegistry.js";
import { DEFAULT_BUDGET } from "../../../src/modules/agent/runtime/Budget.js";
import { ExecutorRunner } from "../../../src/modules/agent/runtime/ExecutorRunner.js";
import { SessionManager } from "../../../src/modules/agent/runtime/SessionManager.js";
import { SessionStore } from "../../../src/modules/agent/runtime/SessionStore.js";
import { AgentFileSystem } from "../../../src/modules/agent/tools/AgentFileSystem.js";
import { createDelegateTool } from "../../../src/modules/agent/tools/delegateTool.js";
import { createFileTools } from "../../../src/modules/agent/tools/fileTools.js";
import { createTodoTool } from "../../../src/modules/agent/tools/todoTool.js";
import { ToolRegistry } from "../../../src/modules/agent/tools/ToolRegistry.js";
import { createTempWorkspace, type TempWorkspace } from "../../helpers/tempWorkspace.js";

/** Реестр, где «облачный» планировщик и «локальный» исполнитель — скриптовые mock-модели. */
class ScriptedRegistry extends ProviderRegistry {
    constructor(private readonly scripts: Record<string, MockScript>) {
        super({});
    }

    public override create(id: string, model?: string): ModelProvider {
        const script = this.scripts[id];

        if (!script) {
            return super.create(id, model);
        }

        const mock = new MockProvider(script);
        return Object.assign(mock, { id, model: model ?? `${id}-model` }) as ModelProvider;
    }
}

describe("planner → executor delegation", () => {
    let workspace: TempWorkspace;
    let events: AgentEvent[];
    let sessions: SessionManager;
    let permissions: PermissionService;

    function setup(scripts: Record<string, MockScript>) {
        events = [];
        const emit = (event: AgentEvent) => {
            events.push(event);
        };

        const providers = new ScriptedRegistry(scripts);
        const profiles = new AgentProfiles();
        const tools = new ToolRegistry();
        const files = new AgentFileSystem(workspace.root, new EventBus(), emit);

        permissions = new PermissionService({ rulesFile: path.join(workspace.root, ".justai", "permissions.json"), emit });

        for (const tool of [
            ...createFileTools(files, () => false),
            createTodoTool(),
            createDelegateTool(() => (input, context) => sessions.delegate(input, context)),
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
            executor: {
                defaultProvider: "local",
                runner: new ExecutorRunner({
                    providers, tools, profiles, permissions,
                    workspaceRoot: workspace.root,
                    shouldIgnore: () => false,
                    limits: { ...DEFAULT_BUDGET, maxSteps: 5 },
                }),
            },
            emit,
        });
    }

    beforeEach(async () => {
        workspace = await createTempWorkspace();
    });

    afterEach(async () => {
        await workspace.dispose();
    });

    it("delegates a step, reports real actions back to the planner, streams progress", async () => {
        setup({
            cloud: [
                { toolCalls: [{ name: "delegate_task", input: { task: "Create docs/hello.md with the text 'hello' and nothing else." } }] },
                { text: "Done: docs/hello.md was created by the executor." },
            ],
            local: [
                { toolCalls: [{ name: "write_file", input: { path: "docs/hello.md", content: "hello\n" } }] },
                { text: "Created docs/hello.md." },
            ],
        });

        const session = await sessions.create({ profile: "planner", provider: "cloud", mode: "full-auto" });
        expect(session.executor).toEqual({ provider: "local", model: "local-model" });

        await sessions.send(session.id, { text: "Add a hello doc" });
        await sessions.waitForIdle(session.id);

        const details = await sessions.get(session.id);
        expect(details.session.status).toBe("completed");
        expect(existsSync(path.join(workspace.root, "docs/hello.md"))).toBe(true);

        const result = details.messages[2]!.content[0];
        expect(result).toMatchObject({ type: "tool_result", isError: false });
        const text = (result as { content: string }).content;
        expect(text).toContain("Executor local/local-model: completed");
        expect(text).toContain("- OK write_file docs/hello.md — Created docs/hello.md");
        expect(text).toContain("Executor's report:\nCreated docs/hello.md.");

        const progress = events
            .filter(event => event.type === "tool.progress")
            .map(event => (event as { chunk: string }).chunk)
            .join("");
        expect(progress).toContain("→ write_file docs/hello.md");
        expect(progress).toContain("✓ write_file");

        // История исполнителя не попадает в сессию: только планировщик и результат делегирования.
        expect(details.messages).toHaveLength(4);
    });

    it("executor actions go through the planner session's permissions", async () => {
        setup({
            cloud: [
                { toolCalls: [{ name: "delegate_task", input: { task: "Create notes.txt containing a short note for the user." } }] },
                { text: "The user did not allow the change." },
            ],
            local: [
                { toolCalls: [{ name: "write_file", input: { path: "notes.txt", content: "note" } }] },
                { text: "I could not write the file: permission denied." },
            ],
        });

        const session = await sessions.create({ profile: "planner", provider: "cloud", mode: "ask" });

        // «Пользователь» отклоняет запрос, пришедший от имени сессии планировщика.
        const deny = setInterval(() => {
            for (const request of permissions.pendingFor(session.id)) {
                permissions.resolve(session.id, request.requestId, "deny", "not now");
            }
        }, 10);

        try {
            await sessions.send(session.id, { text: "Write a note" });
            await sessions.waitForIdle(session.id);
        }
        finally {
            clearInterval(deny);
        }

        expect(existsSync(path.join(workspace.root, "notes.txt"))).toBe(false);
        expect(events.some(event => event.type === "permission.request" && event.sessionId === session.id)).toBe(true);

        const text = ((await sessions.get(session.id)).messages[2]!.content[0] as { content: string }).content;
        expect(text).toContain("- ERROR write_file notes.txt — The user denied this action: not now.");
    });

    it("rejects planner sessions with an unknown executor provider", async () => {
        setup({ cloud: [] });

        await expect(sessions.create({ profile: "planner", provider: "cloud", executorProvider: "nope" }))
            .rejects.toThrow("Unknown AI provider");
    });

    it("hides the executor profile from the profile list", () => {
        expect(new AgentProfiles().list().map(profile => profile.id)).toEqual(["coder", "planner", "architect", "docs", "general", "office"]);
    });
});
