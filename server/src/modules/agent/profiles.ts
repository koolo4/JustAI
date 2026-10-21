import type { AgentProfileInfo } from "@justai/shared";

import { BadRequestError } from "../../core/errors/BadRequestError.js";

export interface AgentProfile extends AgentProfileInfo {
    /** Добавляется к системному промпту. */
    instructions: string;
}

const PROFILES: AgentProfile[] = [
    {
        id: "coder",
        label: "Code Agent",
        description: "Reads, edits and runs code in the local workspace: tests, builds, scripts.",
        tools: ["todo_write", "read_file", "list_dir", "glob", "grep", "edit_file", "write_file", "run_command", "read_output", "kill_process", "list_processes", "git_status", "git_diff", "git_log", "git_commit", "web_fetch"],
        instructions: [
            "You are working as a senior software engineer on the user's project.",
            "Before changing code, read the relevant files and follow the conventions you find there.",
            "Make the smallest change that fully solves the task. Do not refactor unrelated code.",
            "When you finish, report what you changed (files and a short summary) and anything you could not verify.",
        ].join("\n"),
    },
    {
        id: "general",
        label: "General Agent",
        description: "Workspace files plus connected services (OneDrive / Word).",
        tools: ["todo_write", "read_file", "list_dir", "glob", "grep", "edit_file", "write_file", "run_command", "read_output", "kill_process", "list_processes", "git_status", "git_diff", "git_log", "git_commit", "web_fetch", "word_read", "word_edit"],
        instructions: [
            "Help the user with their request using the available tools.",
            "Never claim that a change succeeded unless the tool result says so.",
        ].join("\n"),
    },
    {
        id: "office",
        label: "Office Agent",
        description: "Reads and edits Word documents in the connected OneDrive.",
        tools: ["word_read", "word_edit"],
        instructions: [
            "You automate work with the user's Word documents in OneDrive.",
            "Preserve existing formatting. Return a Word/OneDrive link when one is available.",
        ].join("\n"),
    },
];

export class AgentProfiles {

    public list(): AgentProfileInfo[] {
        return PROFILES.map(({ instructions: _instructions, ...info }) => info);
    }

    public get defaultProfile(): string {
        return PROFILES[0]!.id;
    }

    public get(id: string): AgentProfile {
        const profile = PROFILES.find(candidate => candidate.id === id);

        if (!profile) {
            throw new BadRequestError(`Unknown agent profile: ${id}`);
        }

        return profile;
    }
}
