import type { AgentProfileInfo } from "@justai/shared";

import { BadRequestError } from "../../core/errors/BadRequestError.js";

export interface AgentProfile extends AgentProfileInfo {
    /** Добавляется к системному промпту. */
    instructions: string;
    /** Служебный профиль (исполнитель): не показывается в списке для пользователя. */
    hidden?: boolean;
}

/** Проверка интерфейса без действий на странице. */
const BROWSER_READ_TOOLS = ["browser_open", "browser_text", "browser_console", "browser_screenshot", "browser_close"];
const BROWSER_TOOLS = [...BROWSER_READ_TOOLS, "browser_click", "browser_type"];

const CODE_TOOLS = [
    "todo_write", "read_file", "list_dir", "glob", "grep", "edit_file", "write_file",
    "run_command", "read_output", "kill_process", "list_processes",
    "git_status", "git_diff", "git_log", "git_commit", "web_fetch",
    ...BROWSER_TOOLS,
];

const PROFILES: AgentProfile[] = [
    {
        id: "coder",
        label: "Code Agent",
        description: "Reads, edits and runs code in the local workspace: tests, builds, scripts.",
        tools: CODE_TOOLS,
        instructions: [
            "You are working as a senior software engineer on the user's project.",
            "Before changing code, read the relevant files and follow the conventions you find there.",
            "Make the smallest change that fully solves the task. Do not refactor unrelated code.",
            "When you finish, report what you changed (files and a short summary) and anything you could not verify.",
        ].join("\n"),
    },
    {
        id: "planner",
        label: "Planner + local executor",
        description: "A strong model plans and reviews; a local model (Ollama) edits files and runs commands.",
        tools: ["todo_write", "read_file", "list_dir", "glob", "grep", "git_status", "git_diff", "git_log", "web_fetch", ...BROWSER_READ_TOOLS, "delegate_task"],
        instructions: [
            "You are the planner in a two-agent setup. You cannot edit files or run commands yourself:",
            "a local executor model does that when you call delegate_task. You read code, plan, delegate and review.",
            "",
            "How to work:",
            "1. Investigate with read-only tools until you understand what has to change. Keep a plan with todo_write.",
            "2. Delegate one small, self-contained step at a time. The executor is a small model with no memory of earlier steps,",
            "   so every task must say exactly which files to change, what to change (quote the relevant code and names),",
            "   and which command proves the step works (for example the test or type-check command).",
            "3. After each delegation, check the result yourself: read the changed files or git_diff, and look at the reported command results.",
            "   Do not trust the executor's summary alone. If something is wrong or missing, delegate a precise fix.",
            "4. Finish with a short summary for the user: what changed, how it was verified, what is left.",
        ].join("\n"),
    },
    {
        id: "general",
        label: "General Agent",
        description: "Workspace files plus connected services (OneDrive / Word).",
        tools: [...CODE_TOOLS, "word_read", "word_edit"],
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
    {
        id: "executor",
        label: "Executor",
        description: "Carries out one step delegated by the planner.",
        hidden: true,
        tools: ["read_file", "list_dir", "glob", "grep", "edit_file", "write_file", "run_command", "read_output", "kill_process", "list_processes", "git_status", "git_diff", "browser_open", "browser_text", "browser_console"],
        instructions: [
            "You are the executor. Another model planned the work and gave you exactly one task.",
            "Do only that task. Do not change anything else and do not start extra work.",
            "Use the tools: read a file before editing it, then edit it. If the task names a command to check the result, run it.",
            "If something fails, try to fix it within the task. If you cannot, stop and explain why.",
            "Finish with a short report: files you changed, commands you ran and their results, and any problems.",
        ].join("\n"),
    },
];

export class AgentProfiles {

    public list(): AgentProfileInfo[] {
        return PROFILES
            .filter(profile => !profile.hidden)
            .map(({ instructions: _instructions, hidden: _hidden, ...info }) => info);
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
