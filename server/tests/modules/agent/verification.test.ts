import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentEvent } from "@justai/shared";

import { EventBus } from "../../../src/core/events/index.js";
import { ProcessManager } from "../../../src/infrastructure/process/ProcessManager.js";
import { PermissionService } from "../../../src/modules/agent/permissions/PermissionService.js";
import { AgentProfiles } from "../../../src/modules/agent/profiles.js";
import type { MockScript } from "../../../src/modules/agent/providers/MockProvider.js";
import { DEFAULT_BUDGET } from "../../../src/modules/agent/runtime/Budget.js";
import { SessionManager } from "../../../src/modules/agent/runtime/SessionManager.js";
import { SessionStore } from "../../../src/modules/agent/runtime/SessionStore.js";
import { planChecks, Verifier, verifyKindsFromEnv } from "../../../src/modules/agent/runtime/Verifier.js";
import { AgentFileSystem } from "../../../src/modules/agent/tools/AgentFileSystem.js";
import { createFileTools } from "../../../src/modules/agent/tools/fileTools.js";
import { createShellTools } from "../../../src/modules/agent/tools/shellTools.js";
import { ToolRegistry } from "../../../src/modules/agent/tools/ToolRegistry.js";
import { ScriptedRegistry } from "../../helpers/scriptedProviders.js";
import { createTempWorkspace, type TempWorkspace } from "../../helpers/tempWorkspace.js";

const processes = new ProcessManager();

describe("automatic verification", () => {
    let workspace: TempWorkspace;
    let events: AgentEvent[];

    beforeEach(async () => {
        workspace = await createTempWorkspace();
        // «typecheck» проекта: падает, если в src.js есть слово BUG.
        await workspace.write("package.json", JSON.stringify({ scripts: { typecheck: "node check.js" } }));
        await workspace.write("check.js", [
            "const src = require('fs').readFileSync('src.js', 'utf8');",
            "if (src.includes('BUG')) { console.error('src.js:1 error TS2322: BUG is not allowed'); process.exit(2); }",
            "console.log('ok');",
        ].join("\n"));
        await workspace.write("src.js", "module.exports = 1;\n");
        events = [];
    });

    afterEach(async () => {
        await workspace.dispose();
    });

    afterAll(async () => {
        await processes.killAll();
    });

    function manager(script: MockScript, options: { verifier?: boolean } = {}) {
        const emit = (event: AgentEvent) => {
            events.push(event);
        };
        const tools = new ToolRegistry();
        const files = new AgentFileSystem(workspace.root, new EventBus(), emit);

        for (const tool of [...createFileTools(files, () => false), ...createShellTools(files, processes)]) {
            tools.register(tool);
        }

        return new SessionManager({
            store: new SessionStore(path.join(workspace.root, ".justai", "sessions")),
            providers: new ScriptedRegistry({ model: script }),
            tools,
            profiles: new AgentProfiles(),
            workspaceRoot: workspace.root,
            shouldIgnore: () => false,
            limits: DEFAULT_BUDGET,
            permissions: new PermissionService({ rulesFile: path.join(workspace.root, ".justai", "permissions.json"), emit }),
            ...(options.verifier === false ? {} : {
                verifier: new Verifier({ processes, workspaceRoot: workspace.root, kinds: ["typecheck", "test"], timeoutMs: 60_000 }),
            }),
            emit,
        });
    }

    async function run(sessions: SessionManager, mode: "full-auto" | "ask" = "full-auto", verify = true) {
        const { id } = await sessions.create({ provider: "model", mode, verify });
        await sessions.send(id, { text: "change src.js" });
        await sessions.waitForIdle(id);
        return sessions.get(id);
    }

    it("catches a broken change, lets the agent fix it and finishes green", async () => {
        const sessions = manager([
            { toolCalls: [{ name: "read_file", input: { path: "src.js" } }] },
            { toolCalls: [{ name: "write_file", input: { path: "src.js", content: "module.exports = 'BUG';\n" } }] },
            { text: "Done." },
            { toolCalls: [{ name: "write_file", input: { path: "src.js", content: "module.exports = 2;\n" } }] },
            { text: "Fixed the type error." },
        ]);

        const details = await run(sessions);

        expect(details.session.status).toBe("completed");
        expect(details.session.lastError).toBeUndefined();
        expect(await readFile(path.join(workspace.root, "src.js"), "utf8")).toBe("module.exports = 2;\n");

        const feedback = details.messages.find(message =>
            message.role === "user" && message.content.some(block => block.type === "text" && block.text.includes("[JustAI automatic check")));
        const text = (feedback?.content[0] as { text: string }).text;
        expect(text).toContain("attempt 1 of 3");
        expect(text).toContain("`npm run typecheck` in . (exit code 2)");
        expect(text).toContain("BUG is not allowed");

        const statuses = events.filter(event => event.type === "verification").map(event => (event as { status: string }).status);
        expect(statuses).toEqual(["running", "failed", "running", "passed"]);
    }, 60_000);

    it("stops after the attempt limit and reports it", async () => {
        // Модель каждый раз «исправляет» неправильно; цикл не должен крутиться вечно.
        const scripted = manager((_request, index) => index === 0
            ? { toolCalls: [{ name: "read_file", input: { path: "src.js" } }] }
            : index % 2 === 1
                ? { toolCalls: [{ name: "write_file", input: { path: "src.js", content: `module.exports = 'BUG ${index}';\n` } }] }
                : { text: "Done." });

        const details = await run(scripted);

        expect(details.session.status).toBe("completed");
        expect(details.session.lastError).toBe("Automatic checks still fail after 3 attempts.");
        expect(events.filter(event => event.type === "verification" && event.status === "failed")).toHaveLength(3);
    }, 60_000);

    it("does not verify when nothing was changed or when disabled", async () => {
        const unchanged = await run(manager([{ text: "Nothing to do." }]));
        expect(unchanged.session.status).toBe("completed");

        const disabled = await run(manager([
            { toolCalls: [{ name: "write_file", input: { path: "src.js", content: "BUG\n" } }] },
            { text: "Done." },
        ]), "full-auto", false);
        expect(disabled.session.lastError).toBeUndefined();

        expect(events.some(event => event.type === "verification")).toBe(false);
    }, 60_000);

    it("lets the model explain unrelated failures without looping", async () => {
        await workspace.write("src.js", "module.exports = 'BUG from before';\n");

        const sessions = manager([
            { toolCalls: [{ name: "write_file", input: { path: "notes.md", content: "notes\n" } }] },
            { text: "Added notes." },
            { text: "The typecheck failure in src.js existed before my change and is unrelated to the task." },
        ]);

        const details = await run(sessions);

        expect(details.session.status).toBe("completed");
        expect(details.session.lastError).toBe("Automatic checks are failing (see the last check above).");
        expect(events.filter(event => event.type === "verification" && event.status === "failed")).toHaveLength(1);
    }, 60_000);
});

describe("planChecks / verifyKindsFromEnv", () => {
    it("prefers root commands over subprojects", () => {
        const projects = [
            { root: ".", stack: "node" as const, tool: "npm", commands: { test: "npm test" } },
            { root: "server", stack: "node" as const, tool: "npm", commands: { test: "npm test", typecheck: "npm run typecheck" } },
            { root: "web", stack: "node" as const, tool: "npm", commands: { typecheck: "npm run typecheck" } },
        ];

        expect(planChecks(projects, ["typecheck", "test"])).toEqual([
            { cwd: "server", command: "npm run typecheck" },
            { cwd: "web", command: "npm run typecheck" },
            { cwd: ".", command: "npm test" },
        ]);
    });

    it("parses JUSTAI_VERIFY", () => {
        expect(verifyKindsFromEnv(undefined)).toEqual(["typecheck", "test"]);
        expect(verifyKindsFromEnv("off")).toEqual([]);
        expect(verifyKindsFromEnv("lint, build, nonsense")).toEqual(["lint", "build"]);
    });
});
