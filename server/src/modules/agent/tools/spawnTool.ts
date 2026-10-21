import { z } from "zod";

import { defineTool, type Tool, type ToolContext } from "./Tool.js";

export const SPAWN_TOOL = "spawn_agent";

export type SubagentKind = "explore" | "review";

export interface SpawnInput {
    task: string;
    kind: SubagentKind;
}

export type Spawn = (input: SpawnInput, context: ToolContext) => Promise<string>;

/**
 * Read-only помощник со своим контекстом. Ничего не меняет, поэтому выполняется без подтверждений
 * и параллельно с другими read-вызовами (несколько помощников в одном ходе — одновременно).
 */
export function createSpawnTool(spawn: () => Spawn): Tool {
    return defineTool({
        name: SPAWN_TOOL,
        description: [
            "Starts a read-only helper agent with its own context and returns its answer.",
            "kind=explore: investigate the codebase and answer one question (where is X implemented, how does Y work).",
            "kind=review: review the current uncommitted changes for bugs.",
            "Use it to keep your own context small; several helpers called in the same turn run in parallel.",
            "The helper does not see this conversation: describe the question completely.",
        ].join(" "),
        inputSchema: z.object({
            task: z.string().min(10).describe("The complete question or review request."),
            kind: z.enum(["explore", "review"]).default("explore"),
        }),
        kind: "read",
        run: (input, context) => spawn()(input, context),
    });
}
