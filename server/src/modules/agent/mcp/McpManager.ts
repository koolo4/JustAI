import { readFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ImageBlock, TextBlock, ToolOutput } from "@justai/shared";
import { z } from "zod";

import { defineTool, ToolError, type Tool } from "../tools/Tool.js";

/** Формат как у Claude Desktop / Cursor: { "mcpServers": { "name": { command, args, env } | { url, headers } } }. */
export interface McpServerConfig {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    headers?: Record<string, string>;
    /** false — сервер описан, но не запускается. */
    enabled?: boolean;
}

export interface McpServerStatus {
    name: string;
    status: "connected" | "failed" | "disabled";
    tools: string[];
    error?: string;
}

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_NAME = 64;

/** Имя инструмента для модели: mcp__<сервер>__<инструмент>, только [A-Za-z0-9_-], не длиннее 64. */
export function mcpToolName(server: string, tool: string): string {
    const clean = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_");
    return `mcp__${clean(server)}__${clean(tool)}`.slice(0, MAX_NAME);
}

/** Конфиги: сначала общий (папка установки JustAI), затем проектный — он переопределяет серверы с тем же именем. */
export async function readMcpConfig(files: string[]): Promise<Record<string, McpServerConfig>> {
    const servers: Record<string, McpServerConfig> = {};

    for (const file of files) {
        let parsed: { mcpServers?: Record<string, McpServerConfig> };

        try {
            parsed = JSON.parse(await readFile(file, "utf8")) as typeof parsed;
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw new Error(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
        }

        Object.assign(servers, parsed.mcpServers ?? {});
    }

    return servers;
}

/** Результат MCP-инструмента → вывод инструмента JustAI (текст и картинки). */
export function toToolOutput(content: unknown): ToolOutput {
    const blocks: Array<TextBlock | ImageBlock> = [];

    for (const item of Array.isArray(content) ? content : []) {
        const part = item as { type?: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string; uri?: string } };

        if (part.type === "text" && typeof part.text === "string") {
            blocks.push({ type: "text", text: part.text });
        }
        else if (part.type === "image" && part.data && part.mimeType) {
            blocks.push({ type: "image", mediaType: part.mimeType, dataBase64: part.data });
        }
        else if (part.type === "resource" && part.resource) {
            blocks.push({ type: "text", text: part.resource.text ?? `[resource ${part.resource.uri ?? ""}]` });
        }
        else {
            blocks.push({ type: "text", text: JSON.stringify(item) });
        }
    }

    if (blocks.length === 0) return "(no output)";
    return blocks.every(block => block.type === "text") ? blocks.map(block => (block as TextBlock).text).join("\n") : blocks;
}

/**
 * Подключение к MCP-серверам и их инструменты для агента. Инструменты получают kind "network":
 * в любом режиме агент спрашивает разрешение на каждый инструмент один раз за сессию.
 */
export class McpManager {

    private readonly clients = new Map<string, Client>();
    private statuses: McpServerStatus[] = [];

    constructor(
        /** Файлы конфигурации по порядку применения. */
        public readonly configFiles: string[],
    ) {}

    public status(): McpServerStatus[] {
        return this.statuses;
    }

    /** Подключиться ко всем серверам параллельно; ошибки не мешают остальным. Возвращает инструменты. */
    public async start(): Promise<Tool[]> {
        let servers: Record<string, McpServerConfig>;

        try {
            servers = await readMcpConfig(this.configFiles);
        }
        catch (error) {
            this.statuses = [{ name: "(config)", status: "failed", tools: [], error: error instanceof Error ? error.message : String(error) }];
            return [];
        }

        const results = await Promise.all(Object.entries(servers).map(([name, config]) => this.connect(name, config)));
        this.statuses = results.map(result => result.status);
        return results.flatMap(result => result.tools);
    }

    public async stop(): Promise<void> {
        await Promise.allSettled([...this.clients.values()].map(client => client.close()));
        this.clients.clear();
    }

    private async connect(name: string, config: McpServerConfig): Promise<{ status: McpServerStatus; tools: Tool[] }> {
        if (config.enabled === false) {
            return { status: { name, status: "disabled", tools: [] }, tools: [] };
        }

        try {
            const client = new Client({ name: "justai", version: "0.3.0" });
            await withTimeout(client.connect(this.transport(config)), CONNECT_TIMEOUT_MS, `MCP server '${name}' did not start in ${CONNECT_TIMEOUT_MS / 1000}s`);
            this.clients.set(name, client);

            const { tools } = await client.listTools();
            const wrapped = tools.map(tool => this.wrap(name, client, tool));

            return { status: { name, status: "connected", tools: wrapped.map(tool => tool.name) }, tools: wrapped };
        }
        catch (error) {
            return { status: { name, status: "failed", tools: [], error: error instanceof Error ? error.message : String(error) }, tools: [] };
        }
    }

    private transport(config: McpServerConfig): Transport {
        if (config.url) {
            return new StreamableHTTPClientTransport(new URL(config.url), config.headers ? { requestInit: { headers: config.headers } } : undefined);
        }

        if (!config.command) {
            throw new Error("Set either \"command\" (local server) or \"url\" (remote server).");
        }

        // Безопасное окружение SDK (PATH, HOME…) + явно заданное: ключи JustAI серверу не передаются.
        return new StdioClientTransport({
            command: config.command,
            args: config.args ?? [],
            env: { ...getDefaultEnvironment(), ...config.env },
            ...(config.cwd ? { cwd: config.cwd } : {}),
            stderr: "ignore",
        });
    }

    private wrap(server: string, client: Client, tool: { name: string; description?: string; inputSchema: Record<string, unknown> }): Tool {
        return defineTool({
            name: mcpToolName(server, tool.name),
            description: `[MCP ${server}] ${tool.description ?? tool.name}`.slice(0, 2_000),
            inputSchema: z.record(z.string(), z.unknown()),
            jsonSchema: { type: "object", ...tool.inputSchema },
            kind: "network",
            run: async (input, context) => {
                const result = await client.callTool(
                    { name: tool.name, arguments: input },
                    undefined,
                    { signal: context.signal, timeout: CALL_TIMEOUT_MS },
                );

                const output = toToolOutput(result.content);

                if (result.isError) {
                    throw new ToolError(typeof output === "string" ? output : "The MCP tool reported an error.");
                }

                return output;
            },
        });
    }
}

/** Пути конфигов: общий в папке установки JustAI и проектный. */
export function mcpConfigFiles(installRoot: string, workspaceRoot: string): string[] {
    const files = [path.join(installRoot, ".justai", "mcp.json"), path.join(workspaceRoot, ".justai", "mcp.json")];
    return [...new Set(files.map(file => path.resolve(file)))];
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), ms);
        promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
}
