import type { AITool } from "./AITool.js";
import type { ToolDefinition } from "../contracts/ToolDefinition.js";

export class ToolRegistry {

    private readonly tools =
        new Map<string, AITool>();

    public register(
        tool: AITool,
    ): void {
        this.tools.set(tool.name, tool);
    }

    public get(
        name: string,
    ): AITool | undefined {
        return this.tools.get(name);
    }

    public list(): AITool[] {
        return [...this.tools.values()];
    }

    public definitions(): ToolDefinition[] {
        return this.list().map(tool => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        }));
    }
}
