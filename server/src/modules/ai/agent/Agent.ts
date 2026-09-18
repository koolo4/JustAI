import type {
    AIToolCall,
} from "../contracts/AIProvider.js";

import { ToolExecutor } from "../tools/ToolExecutor.js";
import { Planner } from "./Planner.js";

export class Agent {

    constructor(

        private readonly planner: Planner,

        private readonly executor: ToolExecutor,

    ) {}

    public async execute(
        prompt: string,
    ): Promise<string | null> {

        const call =
            this.planner.plan(
                prompt,
            );

        if (!call) {

            return null;

        }

        return this.executeToolCall(
            call,
        );

    }

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