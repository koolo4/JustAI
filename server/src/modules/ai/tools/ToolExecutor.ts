import { ToolRegistry } from "./ToolRegistry.js";

import type { ToolCall } from "./ToolCall.js";

export class ToolExecutor {

    constructor(

        private readonly registry: ToolRegistry,

    ) {}

    public async execute(

        call: ToolCall,

    ): Promise<string> {

        const tool =

            this.registry.get(

                call.tool,

            );

        if (!tool) {

            throw new Error(

                `Tool '${call.tool}' not found.`,

            );

        }

        const result =

            await tool.execute(

                call.arguments,

            );

        return result.content;

    }

}