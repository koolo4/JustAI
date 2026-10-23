import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { AgentEvent, PermissionMode, PermissionRequest } from "@justai/shared";

import { commandPrefix, PermissionService } from "../../../src/modules/agent/permissions/PermissionService.js";
import { MockProvider } from "../../../src/modules/agent/providers/MockProvider.js";
import { AgentLoop, createMessage } from "../../../src/modules/agent/runtime/AgentLoop.js";
import { DEFAULT_BUDGET } from "../../../src/modules/agent/runtime/Budget.js";
import { defineTool, type Tool, type ToolKind } from "../../../src/modules/agent/tools/Tool.js";
import { createTempWorkspace, type TempWorkspace } from "../../helpers/tempWorkspace.js";

function tool(name: string, kind: ToolKind): Tool {
    return defineTool({
        name,
        description: name,
        inputSchema: z.object({ command: z.string().optional(), path: z.string().optional() }),
        kind,
        run: async () => "ok",
    });
}

const readTool = tool("read_file", "read");
const writeTool = tool("write_file", "write");
const runTool = tool("run_command", "execute");
const killTool = tool("kill_process", "execute");
const netTool = tool("word_edit", "network");

describe("PermissionService", () => {
    let workspace: TempWorkspace;
    let events: AgentEvent[];
    let service: PermissionService;
    let rulesFile: string;

    beforeEach(async () => {
        workspace = await createTempWorkspace();
        rulesFile = path.join(workspace.root, ".justai", "permissions.json");
        events = [];
        service = new PermissionService({
            rulesFile,
            emit: event => events.push(event),
            timeoutMs: 2000,
        });
    });

    afterEach(async () => {
        await workspace.dispose();
    });

    /** Возвращает true, если вызов разрешён без вопроса (ни одного permission.request). */
    async function autoAllowed(mode: PermissionMode, target: Tool, input: unknown): Promise<boolean> {
        const controller = new AbortController();
        const before = events.length;
        const authorizer = service.forSession("s", () => mode);
        const result = authorizer.authorize({ sessionId: "s", toolUseId: "t", tool: target, input, signal: controller.signal });

        await new Promise(resolve => setTimeout(resolve, 10));
        const asked = events.slice(before).some(event => event.type === "permission.request");

        if (asked) {
            controller.abort();
        }

        const outcome = await result;
        return !asked && outcome.allowed;
    }

    it.each<[PermissionMode, Tool, unknown, boolean]>([
        ["ask", readTool, { path: "a" }, true],
        ["ask", writeTool, { path: "a" }, false],
        ["ask", runTool, { command: "npm test" }, false],
        ["ask", killTool, {}, true],
        ["ask", netTool, {}, false],
        ["auto-edit", writeTool, { path: "a" }, true],
        ["auto-edit", runTool, { command: "npm test" }, true],
        ["auto-edit", runTool, { command: "node build.js" }, false],
        ["auto-edit", runTool, { command: "git push" }, false],
        ["auto-edit", netTool, {}, false],
        ["full-auto", runTool, { command: "node build.js" }, true],
        ["full-auto", runTool, { command: "rm -rf dist" }, false],
        ["full-auto", runTool, { command: "cmd /c \"rd /s /q C:\\\"" }, false],
        ["full-auto", netTool, {}, false],
        // Инструмент без поля command (diagnostics): в full-auto разрешён, иначе вопрос.
        ["ask", tool("diagnostics", "execute"), {}, false],
        ["auto-edit", tool("diagnostics", "execute"), {}, false],
        ["full-auto", tool("diagnostics", "execute"), {}, true],
    ])("mode %s: %s %j → auto %s", async (mode, target, input, expected) => {
        expect(await autoAllowed(mode, target, input)).toBe(expected);
    });

    async function askAndAnswer(
        mode: PermissionMode,
        target: Tool,
        input: unknown,
        answer: (request: PermissionRequest) => void,
    ) {
        const authorizer = service.forSession("s", () => mode);
        const result = authorizer.authorize({ sessionId: "s", toolUseId: "t", tool: target, input, signal: new AbortController().signal });

        await new Promise(resolve => setTimeout(resolve, 10));
        const request = events.findLast(event => event.type === "permission.request");

        if (request?.type !== "permission.request") {
            throw new Error("no permission request");
        }

        answer(request.request);
        return result;
    }

    it("asks the user and applies allow / deny with a note", async () => {
        const allowed = await askAndAnswer("ask", runTool, { command: "node build.js" }, request => {
            expect(request).toMatchObject({ tool: "run_command", summary: "node build.js", dangerous: false });
            expect(service.pendingFor("s")).toHaveLength(1);
            service.resolve("s", request.requestId, "allow");
        });

        expect(allowed).toEqual({ allowed: true });
        expect(service.pendingFor("s")).toHaveLength(0);
        expect(events.at(-1)).toMatchObject({ type: "permission.resolved", decision: "allow" });

        const denied = await askAndAnswer("ask", runTool, { command: "node build.js" }, request => {
            service.resolve("s", request.requestId, "deny", "use the npm script instead");
        });

        expect(denied).toMatchObject({ allowed: false, message: expect.stringContaining("use the npm script instead") });
    });

    it("remembers allow_always for the session and the command prefix for the project", async () => {
        await askAndAnswer("ask", runTool, { command: "npm run e2e -- --headed" }, request => {
            service.resolve("s", request.requestId, "allow_always");
        });

        expect(await autoAllowed("ask", runTool, { command: "npm run e2e" })).toBe(true);

        const rules = JSON.parse(await readFile(rulesFile, "utf8"));
        expect(rules.allow).toEqual(["npm run e2e"]);

        // Новая сессия: правило проекта действует, сессионное — нет.
        const fresh = service.forSession("other", () => "ask");
        const result = await fresh.authorize({
            sessionId: "other", toolUseId: "t", tool: runTool, input: { command: "npm run e2e" }, signal: new AbortController().signal,
        });
        expect(result).toEqual({ allowed: true });
    });

    it("never remembers allow_always for dangerous commands", async () => {
        await askAndAnswer("full-auto", runTool, { command: "git push" }, request => {
            expect(request.dangerous).toBe(true);
            service.resolve("s", request.requestId, "allow_always");
        });

        expect(await autoAllowed("full-auto", runTool, { command: "git push" })).toBe(false);
    });

    it("allow_always for file writes lasts for the session only", async () => {
        await askAndAnswer("ask", writeTool, { path: "a.ts" }, request => {
            service.resolve("s", request.requestId, "allow_always");
        });

        expect(await autoAllowed("ask", writeTool, { path: "b.ts" })).toBe(true);
    });

    it("applies project deny rules even in full-auto", async () => {
        await mkdir(path.dirname(rulesFile), { recursive: true });
        await writeFile(rulesFile, JSON.stringify({ allow: [], deny: ["npm publish"] }));

        expect(await autoAllowed("full-auto", runTool, { command: "npm publish" })).toBe(false);
    });

    it("denies on abort and on timeout", async () => {
        const controller = new AbortController();
        const authorizer = service.forSession("s", () => "ask");
        const pending = authorizer.authorize({ sessionId: "s", toolUseId: "t", tool: writeTool, input: {}, signal: controller.signal });

        controller.abort();
        expect(await pending).toEqual({ allowed: false, message: "Cancelled by user." });

        const timedOut = await authorizer.authorize({
            sessionId: "s", toolUseId: "t", tool: writeTool, input: {}, signal: new AbortController().signal,
        });
        expect(timedOut).toMatchObject({ allowed: false, message: expect.stringContaining("no answer") });
    }, 10_000);

    it("ignores answers for unknown requests or other sessions", async () => {
        expect(service.resolve("s", "missing", "allow")).toBe(false);

        await askAndAnswer("ask", writeTool, {}, request => {
            expect(service.resolve("other-session", request.requestId, "allow")).toBe(false);
            service.resolve("s", request.requestId, "deny");
        });
    });

    it("integrates with AgentLoop: a denied call becomes a tool error, the model continues", async () => {
        const provider = new MockProvider([
            { toolCalls: [{ name: "write_file", input: { path: "a.ts" } }] },
            { text: "OK, I will not write the file." },
        ]);

        // «Пользователь» сразу отклоняет любой запрос.
        const denying: PermissionService = new PermissionService({
            rulesFile,
            emit: event => {
                events.push(event);
                if (event.type === "permission.request") {
                    queueMicrotask(() => denying.resolve("s", event.request.requestId, "deny", "not now"));
                }
            },
        });

        const saved: string[] = [];
        const loop = new AgentLoop({
            sessionId: "s",
            workspaceRoot: workspace.root,
            provider,
            tools: [writeTool],
            system: "",
            limits: DEFAULT_BUDGET,
            signal: new AbortController().signal,
            emit: event => events.push(event),
            authorizer: denying.forSession("s", () => "ask"),
            onMessage: async message => {
                saved.push(JSON.stringify(message.content));
            },
        });

        const result = await loop.run([createMessage("user", [{ type: "text", text: "write" }])]);

        expect(result.status).toBe("completed");
        expect(saved[1]).toContain("The user denied this action: not now");
        expect(events.some(event => event.type === "tool.started")).toBe(false);
    });
});

describe("commandPrefix", () => {
    it("uses program + subcommand, npm run scripts keep the script name", () => {
        expect(commandPrefix("npm run e2e -- --headed")).toBe("npm run e2e");
        expect(commandPrefix("node scripts/build.js --prod")).toBe("node scripts/build.js");
        expect(commandPrefix("make")).toBe("make");
        expect(commandPrefix("npm test; node x.js")).toBeNull();
    });
});
