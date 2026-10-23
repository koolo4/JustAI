// Минимальный MCP-сервер для тестов: инструменты echo и fail.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "1.0.0" });

server.registerTool(
    "echo",
    { description: "Echo text back.", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}:${process.env.ECHO_SUFFIX ?? ""}:${process.env.SECRET_FROM_PARENT ?? "no-secret"}` }] }),
);

server.registerTool(
    "fail",
    { description: "Always fails.", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "boom" }], isError: true }),
);

await server.connect(new StdioServerTransport());
