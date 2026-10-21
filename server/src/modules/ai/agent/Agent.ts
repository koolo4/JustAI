import type {
    AIToolCall,
} from "../contracts/AIProvider.js";

import { ToolExecutor } from "../tools/ToolExecutor.js";

export class Agent {

    constructor(

        private readonly executor: ToolExecutor,

    ) {}

    public async executeToolCall(

        call: AIToolCall,

    ): Promise<string> {

        return this.executor.execute({

            tool:
                call.tool,

            arguments:
                call.arguments,

        });

    }

}