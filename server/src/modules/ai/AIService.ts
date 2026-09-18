import { ContextService } from "./context/ContextService.js";

import type { AIChatRequest } from "./contracts/AIChatRequest.js";
import type { AIChatResponse } from "./contracts/AIChatResponse.js";
import type { AIProvider } from "./contracts/AIProvider.js";

import { PromptBuilder } from "./prompt/PromptBuilder.js";
import { ToolRegistry } from "./tools/ToolRegistry.js";
import { Agent } from "./agent/Agent.js";
import { ProviderFactory } from "./providers/ProviderFactory.js";
import { AgentProfileService } from "./agents/AgentProfileService.js";

export class AIService {

    constructor(
        private readonly provider: AIProvider,
        private readonly providerFactory: ProviderFactory,
        private readonly contextService: ContextService,
        private readonly toolRegistry: ToolRegistry,
        private readonly promptBuilder: PromptBuilder,
        private readonly agent: Agent,
        private readonly profiles: AgentProfileService,
    ) {}

    public async chat(
        request: AIChatRequest,
    ): Promise<AIChatResponse> {

        const context =
            await this.contextService.buildContext();

        const built =
            this.promptBuilder.build({
                prompt: request.prompt,
                activeFile: request.activeFile ?? "",
                activeContent: request.activeContent ?? "",
                openedFiles: request.openedFiles ?? [],
                projectTree: request.projectTree ?? [],
            });

        const provider =
            request.provider
                ? this.providerFactory.create(
                    request.provider,
                )
                : this.provider;

        const profile =
            this.profiles.get(
                request.agent,
            );

        const tools =
            this.toolRegistry
                .definitions()
                .filter(
                    tool =>
                        profile.tools.includes(
                            tool.name,
                        ),
                );

        const system =
            [
                built.system,
                "",
                "===== AGENT PROFILE =====",
                profile.systemInstruction,
            ].join("\n");

        let prompt =
            built.prompt;

        const maxIterations =
            Math.min(
                Math.max(
                    Number(
                        process.env.JUSTAI_MAX_AGENT_STEPS ??
                        8,
                    ),
                    1,
                ),
                12,
            );

        for (
            let step = 0;
            step < maxIterations;
            step += 1
        ) {

            const response =
                await provider.ask({
                    prompt,
                    system,
                    context: JSON.stringify(
                        context,
                        null,
                        2,
                    ),
                    tools,
                });

            if (!response.toolCall) {
                return {
                    answer: response.content,
                };
            }

            const toolResult =
                await this.agent.executeToolCall(
                    response.toolCall,
                );

            prompt =
                [
                    prompt,
                    "",
                    "===== TOOL CALL =====",
                    JSON.stringify(
                        response.toolCall,
                        null,
                        2,
                    ),
                    "",
                    "===== TOOL RESULT =====",
                    toolResult,
                    "",
                    "===== INSTRUCTION =====",
                    "Use the tool result to continue the user's task. If another tool is needed, call it. Otherwise return the final answer to the user.",
                ].join("\n");
        }

        return {
            answer:
                "Agent stopped because the maximum number of tool steps was reached. Please narrow the task or try again.",
        };
    }
}
