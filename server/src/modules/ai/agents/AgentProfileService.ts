export interface AgentProfile {

    id: string;

    label: string;

    description: string;

    systemInstruction: string;

    tools: string[];

}

export class AgentProfileService {

    private readonly profiles: AgentProfile[] = [

        {
            id: "general",
            label: "General Agent",
            description: "Can inspect the workspace and use connected services.",
            systemInstruction:
                "Act as the general JustAI agent. Use tools when the user asks you to inspect or change something. Never claim an external change succeeded unless the tool reports success.",
            tools: [
                "read_file",
                "list_files",
                "edit_file",
                "word_read",
                "word_edit",
            ],
        },

        {
            id: "coder",
            label: "Code Agent",
            description: "Focused on the local TypeScript workspace.",
            systemInstruction:
                "Act as a senior coding agent. Inspect relevant files before editing. Make the smallest safe change that satisfies the request. After editing, report exactly what changed.",
            tools: [
                "read_file",
                "list_files",
                "edit_file",
            ],
        },

        {
            id: "office",
            label: "Office Agent",
            description: "Focused on connected OneDrive and Word documents.",
            systemInstruction:
                "Act as an office automation agent. Use Word tools for explicit document operations. Preserve the document's existing formatting whenever the tool supports it. Return a Word/OneDrive link when one is available.",
            tools: [
                "word_read",
                "word_edit",
            ],
        },
    ];

    public list(): AgentProfile[] {
        return [...this.profiles];
    }

    public get(
        id: string | undefined,
    ): AgentProfile {
        return (
            this.profiles.find(
                profile => profile.id === id,
            ) ??
            this.profiles[0]!
        );
    }
}
