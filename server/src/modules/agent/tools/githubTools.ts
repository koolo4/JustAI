import { z } from "zod";

import type { GitHubClient } from "../../github/GitHubClient.js";
import { isTestTask, LABELS } from "../../github/GitHubTaskRunner.js";
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
            depends_on: z.array(z.number().int().positive()).max(20).optional()
                .describe("Tasks that must be merged first; this task waits until their issues are closed. Lets you post the whole plan at once."),
        }),
        kind: "network",
        run: async ({ title, body, depends_on }) => {
            const full = depends_on?.length ? `${body.trim()}\n\nDepends on ${depends_on.map(number => `#${number}`).join(", ")}` : body;
            const issue = await github().createIssue(title, full, [label()]);
            return `Created task #${issue.number}: ${issue.url}${depends_on?.length ? ` (starts after ${depends_on.map(number => `#${number}`).join(", ")} are merged)` : ""}`;
        },
    });

    const mergeTask = defineTool({
        name: "github_merge_task",
        description: [
            "Approves a task: the coding agent's computer re-runs the project checks on the pull request branch and, if they pass, merges the pull request",
            "into the main branch and closes the issue (tasks that depend on it then start). Use only after reviewing the diff and, for UI work, a test task.",
            "The result (merged, or why not) is posted to the issue.",
        ].join(" "),
        inputSchema: z.object({ issue: z.number().int().positive() }),
        kind: "network",
        run: async ({ issue }) => {
            await github().comment(issue, `/${label()} merge`, false);
            return `Merge requested for #${issue}; check the result with github_review_task after a minute.`;
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
                const test = isTestTask(issue, label());
                const state = issue.labels.includes(LABELS.working) ? "working"
                    : issue.labels.includes(LABELS.paused) ? "paused (stopped on request)"
                        : issue.labels.includes(LABELS.review) ? (test ? "tested: PASS" : "review (pull request ready)")
                            : issue.labels.includes(LABELS.failed) ? (test ? "tested: FAIL" : "failed")
                                : "new";
                return `#${issue.number} [${test ? "test, " : ""}${state}] ${issue.title} — ${issue.url}`;
            }).join("\n");
        },
    });

    const testTask = defineTool({
        name: "github_test_task",
        description: [
            "Asks the coding agent's computer to TEST the project without changing it: run tests or scripts, start the app and check it in a real browser",
            "(clicks, typing, console errors) and take screenshots. The result (PASS/FAIL, step-by-step report, project checks, screenshots) is posted to the new issue;",
            "read it with github_review_task. Pass `of_task` to test the branch of that task (its pull request) instead of the main branch.",
        ].join(" "),
        inputSchema: z.object({
            title: z.string().min(3).max(200),
            steps: z.string().min(10).max(30_000).describe("What to check, step by step: commands, pages, what to click, expected results, screen sizes."),
            of_task: z.number().int().positive().optional(),
        }),
        kind: "network",
        run: async ({ title, steps, of_task }) => {
            const body = `${steps.trim()}\n\n/${label()} test${of_task ? ` #${of_task}` : ""}`;
            const issue = await github().createIssue(`[${label()}-test] ${title}`, body, [label()]);
            return `Created test task #${issue.number}: ${issue.url}`;
        },
    });

    const runCommand = defineTool({
        name: "github_run_command",
        description: [
            "Runs one shell command on the coding agent's computer, on the branch of a task (or the main branch), and posts the exit code and output tail to the issue.",
            "For quick checks like `npm test` or `npm run build`. Destructive commands are refused. Read the result with github_review_task after a minute.",
        ].join(" "),
        inputSchema: z.object({
            command: z.string().min(1).max(500),
            task: z.number().int().positive().optional().describe("Task issue whose branch to use; omit for the main branch."),
        }),
        kind: "network",
        run: async ({ command, task }) => {
            const line = `/${label()} run ${command.replace(/\s*\n\s*/g, " ").trim()}`;

            if (task) {
                await github().comment(task, line, false);
                return `Command posted to #${task}; the result will appear there as a comment.`;
            }

            const issue = await github().createIssue(`Run: ${command.slice(0, 80)}`, line, []);
            return `Command posted as #${issue.number}; the result will appear there as a comment.`;
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
            const reports = comments.filter(item => item.body.includes("**JustAI**"));
            const report = reports.at(-1);
            // Результаты «/justai run», пришедшие после итогового отчёта, тоже нужны планировщику.
            const runs = reports.filter(item => item.body.includes("▶ **JustAI**") && item !== report).slice(-3);
            const pull = await current.findPullRequest(`justai/issue-${issue}`);
            const diff = pull ? await current.pullRequestDiff(pull.number) : "";
            const clean = (body: string) => body.replace(/<!--[\s\S]*?-->/g, "").trim();

            return [
                ...runs.map(item => `Command result:\n${clean(item.body)}\n`),
                report ? `Latest report:\n${clean(report.body)}` : "No report yet.",
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

    return [createTask, listTasks, reviewTask, requestChanges, testTask, runCommand, mergeTask];
}
