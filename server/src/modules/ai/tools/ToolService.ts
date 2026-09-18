import type { AITool } from "./AITool.js";

export class ToolService {

    constructor(

        private readonly registry: Map<string, AITool>,

    ) {}

    public register(

        tool: AITool,

    ): void {

        this.registry.set(

            tool.name,

            tool,

        );

    }

    public get(

        name: string,

    ): AITool | undefined {

        return this.registry.get(

            name,

        );

    }

    public getAll(): AITool[] {

        return [

            ...this.registry.values(),

        ];

    }

}