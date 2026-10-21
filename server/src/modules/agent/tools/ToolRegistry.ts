import { z } from "zod";

import type { ToolSpec } from "../providers/ModelProvider.js";
import type { Tool } from "./Tool.js";

export class ToolRegistry {

    private readonly tools = new Map<string, Tool>();

    public register(tool: Tool): void {
        if (this.tools.has(tool.name)) {
            throw new Error(`Tool '${tool.name}' is already registered.`);
        }

        this.tools.set(tool.name, tool);
    }

    public get(name: string): Tool | undefined {
        return this.tools.get(name);
    }

    public list(): Tool[] {
        return [...this.tools.values()];
    }

    /**
     * Подмножество инструментов по именам, в порядке регистрации.
     * Порядок стабилен — это важно для кэширования промпта.
     */
    public select(names: readonly string[]): Tool[] {
        return this.list().filter(tool => names.includes(tool.name));
    }
}

export function toToolSpec(tool: Tool): ToolSpec {
    const schema = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
    delete schema.$schema;

    return {
        name: tool.name,
        description: tool.description,
        inputSchema: schema,
    };
}
