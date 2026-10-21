import { z } from "zod";

import type { GitService } from "../../../infrastructure/git/GitService.js";
import { defineTool, ToolError, type Tool } from "./Tool.js";

const MAX_DIFF_CHARS = 60_000;

/**
 * Git-инструменты для репозитория пользователя (не теневого репозитория снапшотов).
 */
export function createGitTools(git: GitService, workspaceRoot: string): Tool[] {
    const run = async (args: string[], signal: AbortSignal): Promise<string> => {
        let result;

        try {
            result = await git.run(args, { cwd: workspaceRoot, signal });
        }
        catch (error) {
            throw new ToolError(error instanceof Error ? error.message : String(error));
        }

        if (result.code !== 0) {
            // Часть сообщений (например, «nothing to commit») git пишет в stdout.
            const message = [result.stderr.trim(), result.stdout.toString("utf8").trim()].filter(Boolean).join("\n");

            throw new ToolError(
                /not a git repository/i.test(message)
                    ? "The workspace is not a git repository."
                    : `git ${args[0]} failed: ${message || `exit code ${result.code}`}`,
            );
        }

        return result.stdout.toString("utf8");
    };

    const gitStatus = defineTool({
        name: "git_status",
        description: "Shows the current branch and changed, staged and untracked files of the workspace git repository.",
        inputSchema: z.object({}),
        kind: "read",
        run: async (_input, context) =>
            (await run(["-c", "core.quotepath=false", "status", "--short", "--branch"], context.signal)).trim() || "Clean working tree.",
    });

    const gitDiff = defineTool({
        name: "git_diff",
        description: "Shows the diff of uncommitted changes (or staged changes with staged=true), optionally for one path.",
        inputSchema: z.object({
            staged: z.boolean().default(false),
            path: z.string().optional().describe("Limit the diff to this workspace-relative path."),
        }),
        kind: "read",
        run: async ({ staged, path }, context) => {
            const args = ["-c", "core.quotepath=false", "diff", "--no-color", ...(staged ? ["--cached"] : []), ...(path ? ["--", path] : [])];
            const diff = await run(args, context.signal);

            if (!diff.trim()) {
                return "No changes.";
            }

            return diff.length > MAX_DIFF_CHARS
                ? `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated; pass a path to see the rest]`
                : diff;
        },
    });

    const gitLog = defineTool({
        name: "git_log",
        description: "Shows recent commits (hash, date, author, subject).",
        inputSchema: z.object({
            limit: z.number().int().min(1).max(100).default(15),
            path: z.string().optional(),
        }),
        kind: "read",
        run: async ({ limit, path }, context) =>
            (await run(
                ["log", `-${limit}`, "--date=short", "--format=%h %ad %an  %s", ...(path ? ["--", path] : [])],
                context.signal,
            )).trim() || "No commits yet.",
    });

    const gitCommit = defineTool({
        name: "git_commit",
        description: "Commits changes to the workspace git repository. Always asks the user first. Commit only when the user asked for it.",
        inputSchema: z.object({
            message: z.string().min(1).describe("Commit message."),
            all: z.boolean().default(true).describe("Stage all changes (including new files) before committing."),
        }),
        kind: "execute",
        requiresApproval: true,
        run: async ({ message, all }, context) => {
            if (all) {
                await run(["add", "--all"], context.signal);
            }

            const output = await run(["commit", "-m", message], context.signal).catch(error => {
                if (error instanceof ToolError && /nothing to commit/i.test(error.message)) {
                    throw new ToolError("Nothing to commit.");
                }
                throw error;
            });

            return output.trim();
        },
    });

    return [gitStatus, gitDiff, gitLog, gitCommit];
}
