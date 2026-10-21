import { detectProjects, formatProjectCommands, type DetectedProject } from "../project/ProjectDetector.js";
import type { AgentProfile } from "../profiles.js";
import { projectTree, readProjectRules } from "./ProjectContext.js";
import { buildSystemPrompt } from "./SystemPrompt.js";

export interface SessionPromptInput {
    profile: AgentProfile;
    toolNames: string[];
    workspaceRoot: string;
    shouldIgnore: (name: string) => boolean;
}

export interface SessionPrompt {
    system: string;
    projects: DetectedProject[];
}

/**
 * Системный промпт сессии: правила проекта, команды проверки, структура папок.
 */
export async function buildSessionPrompt(input: SessionPromptInput): Promise<SessionPrompt> {
    const [rules, tree, projects] = await Promise.all([
        readProjectRules(input.workspaceRoot),
        projectTree(input.workspaceRoot, input.shouldIgnore),
        detectProjects(input.workspaceRoot),
    ]);

    return {
        projects,
        system: buildSystemPrompt({
            profile: input.profile,
            toolNames: input.toolNames,
            workspaceRoot: input.workspaceRoot,
            projectRules: rules,
            tree,
            projectCommands: formatProjectCommands(projects),
            date: new Date().toISOString().slice(0, 10),
        }),
    };
}
