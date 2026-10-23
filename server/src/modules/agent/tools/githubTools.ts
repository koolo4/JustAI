import { z } from "zod";

import type { GitHubClient } from "../../github/GitHubClient.js";
import { LABELS } from "../../github/GitHubTaskRunner.js";
import { defineTool, ToolError, type Tool } from "./Tool.js";

const MAX_DIFF_CHARS = 60_000;

/**
 * Инструменты «архитектора» (ПК с сильной моделью): ставить задачи исполнителю через GitHub issues,
 * следить за их состоянием, читать дифф pull request и просить доработку комментарием.
 */
export function createGitHubTools(client: () => GitHubClient | null, label: () => string): Tool[] {
    const github = (): GitHubClient => {
        const current = client();

        if (!current) {
            throw new ToolError("GitHub is not configured: set the token and repository in Settings → GitHub.");
        }

        return current;
    };

    const createTask = defineTool({
        name: "github_create_task",
        description: [
            "Creates a task for the coding agent as a GitHub issue (it is picked up automatically, implemented on its own branch and returned as a pull request).",
            "Write one self-contained task per issue: the goal, exact requirements, files or structure if known, and how to verify (commands, tests).",
            "Split big work into several sequential tasks.",
        ].join(" "),
        inputSchema: z.object({
            title: z.string().min(3).max(200),
            body: z.string().min(10).max(60_000).describe("Full task description in Markdown."),
        }),
        kind: "network",
        run: async ({ title, body }) => {
            const issue = await github().createIssue(title, body, [label()]);
            return `Created task #${issue.number}: ${issue.url}`;
        },
    });

    const listTasks = defineTool({
        name: "github_list_tasks",
        description: "Lists open tasks for the coding agent with their state (new, working, review — a pull request is ready, failed).",
        inputSchema: z.object({}),
        kind: "network",
        run: async () => {
            const current = github();
            const issues = await current.listIssues(label());

            if (issues.length === 0) {
                return "No open tasks.";
            }

            return issues.map(issue => {
                const state = issue.labels.includes(LABELS.working) ? "working"
                    : issue.labels.includes(LABELS.review) ? "review (pull request ready)"
                        : issue.labels.includes(LABELS.failed) ? "failed"
                            : "new";
                return `#${issue.number} [${state}] ${issue.title} — ${issue.url}`;
            }).join("\n");
        },
    });

    const reviewTask = defineTool({
        name: "github_review_task",
        description: "Shows the agent's latest report and the pull request diff for a task, to review the work.",
        inputSchema: z.object({ issue: z.number().int().positive() }),
        kind: "network",
        run: async ({ issue }) => {
            const current = github();
            const comments = await current.listComments(issue);
            const report = [...comments].reverse().find(item => item.body.includes("**JustAI**"));
            const pull = await current.findPullRequest(`justai/issue-${issue}`);
            const diff = pull ? await current.pullRequestDiff(pull.number) : "";

            return [
                report ? `Latest report:\n${report.body.replace(/<!--[\s\S]*?-->/g, "").trim()}` : "No report yet.",
                pull ? `\nPull request: ${pull.url}\n\nDiff:\n${diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)` : diff}` : "\nNo pull request yet.",
            ].join("\n");
        },
    });

    const requestChanges = defineTool({
        name: "github_request_changes",
        description: "Asks the coding agent to change its work on a task: posts a comment to the issue; the agent continues on the same branch and updates the pull request.",
        inputSchema: z.object({
            issue: z.number().int().positive(),
            comment: z.string().min(5).max(30_000).describe("Concrete changes to make."),
        }),
        kind: "network",
        run: async ({ issue, comment }) => {
            await github().comment(issue, comment, false);
            return `Comment posted to #${issue}; the agent will pick it up on its next check.`;
        },
    });

    return [createTask, listTasks, reviewTask, requestChanges];
}
