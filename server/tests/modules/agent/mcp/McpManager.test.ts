import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpManager, mcpToolName, toToolOutput } from "../../../../src/modules/agent/mcp/McpManager.js";
import { MCP_WILDCARD, ToolRegistry, toToolSpec } from "../../../../src/modules/agent/tools/ToolRegistry.js";
import { createTempWorkspace, type TempWorkspace } from "../../../helpers/tempWorkspace.js";

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/mcpEchoServer.mjs");

describe("McpManager", () => {
    let workspace: TempWorkspace;
    let manager: McpManager | undefined;

    beforeEach(async () => {
        workspace = await createTempWorkspace();
        process.env.SECRET_FROM_PARENT = "leaked";
    });

    afterEach(async () => {
        delete process.env.SECRET_FROM_PARENT;
        await manager?.stop();
        await workspace.dispose();
    });

    it("names tools safely", () => {
        expect(mcpToolName("my server", "read.file")).toBe("mcp__my_server__read_file");
        expect(mcpToolName("s", "x".repeat(100))).toHaveLength(64);
    });

    it("converts MCP content to tool output", () => {
        expect(toToolOutput([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
        expect(toToolOutput([{ type: "image", data: "AAA", mimeType: "image/png" }])).toEqual([{ type: "image", mediaType: "image/png", dataBase64: "AAA" }]);
        expect(toToolOutput([])).toBe("(no output)");
    });

    it("connects to a stdio server, exposes its tools and calls them without leaking the parent environment", async () => {
        await workspace.write(".justai/mcp.json", JSON.stringify({
            mcpServers: {
                echo: { command: process.execPath, args: [fixture], env: { ECHO_SUFFIX: "configured" } },
                broken: { command: "definitely-not-a-command-justai" },
                off: { command: "node", enabled: false },
            },
        }));

        manager = new McpManager([path.join(workspace.root, ".justai", "mcp.json")]);
        const tools = await manager.start();

        expect(tools.map(tool => tool.name)).toEqual(["mcp__echo__echo", "mcp__echo__fail"]);
        expect(manager.status()).toEqual([
            { name: "echo", status: "connected", tools: ["mcp__echo__echo", "mcp__echo__fail"] },
            { name: "broken", status: "failed", tools: [], error: expect.any(String) },
            { name: "off", status: "disabled", tools: [] },
        ]);

        const echo = tools[0]!;
        expect(echo.kind).toBe("network");
        expect(toToolSpec(echo).inputSchema).toMatchObject({ type: "object", properties: { text: { type: "string" } } });

        const context = { sessionId: "s", toolUseId: "t", workspaceRoot: workspace.root, signal: new AbortController().signal, emit: () => undefined };
        expect(await echo.run({ text: "hi" }, context)).toBe("echo:hi:configured:no-secret");
        await expect(tools[1]!.run({}, context)).rejects.toThrow("boom");

        const registry = new ToolRegistry();
        tools.forEach(tool => registry.register(tool));
        expect(registry.select(["read_file", MCP_WILDCARD]).map(tool => tool.name)).toEqual(["mcp__echo__echo", "mcp__echo__fail"]);
        expect(registry.select(["read_file"])).toEqual([]);
    }, 60_000);

    it("reports a broken config file instead of crashing", async () => {
        await workspace.write(".justai/mcp.json", "{ not json");
        manager = new McpManager([path.join(workspace.root, ".justai", "mcp.json"), path.join(workspace.root, "missing.json")]);

        expect(await manager.start()).toEqual([]);
        expect(manager.status()[0]).toMatchObject({ status: "failed", error: expect.stringContaining("Cannot read") });
    });
});
