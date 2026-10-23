import path from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { PermissionService } from "../../../src/modules/agent/permissions/PermissionService.js";
import { createGitHubTools } from "../../../src/modules/agent/tools/githubTools.js";
import { defineTool } from "../../../src/modules/agent/tools/Tool.js";
import { BOT_MARKER, GitHubClient, GitHubError } from "../../../src/modules/github/GitHubClient.js";

interface Call { url: string; method: string; body?: unknown; headers: Record<string, string> }

function fakeFetch(responses: Record<string, unknown>, calls: Call[]): typeof fetch {
    return (async (url: string, init: RequestInit) => {
        const method = init.method ?? "GET";
        calls.push({ url, method, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}), headers: init.headers as Record<string, string> });

        const key = Object.keys(responses).find(pattern => `${method} ${url}`.includes(pattern));
        const value = key ? responses[key] : { status: 404, body: { message: "Not Found" } };
        const { status = 200, body } = (value && typeof value === "object" && "body" in value ? value : { body: value }) as { status?: number; body: unknown };

        return new Response(status === 204 ? null : typeof body === "string" ? body : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
}

const issue = { number: 5, title: "Add page", body: null, user: { login: "me" }, labels: [{ name: "justai" }, "justai:review"], html_url: "https://github.com/me/p/issues/5" };

describe("GitHubClient", () => {
    it("sends the token, maps issues and marks its own comments", async () => {
        const calls: Call[] = [];
        const client = new GitHubClient("tok", "me/p", fakeFetch({
            "GET https://api.github.com/repos/me/p/issues?state=open&labels=justai": [issue, { ...issue, number: 6, pull_request: {} }],
            "POST https://api.github.com/repos/me/p/issues/5/comments": { status: 201, body: {} },
        }, calls));

        const issues = await client.listIssues("justai");
        expect(issues[0]).toEqual({ number: 5, title: "Add page", body: "", author: "me", labels: ["justai", "justai:review"], url: issue.html_url, isPullRequest: false });
        expect(issues[1]!.isPullRequest).toBe(true);
        expect(calls[0]!.headers.Authorization).toBe("Bearer tok");

        await client.comment(5, "Done");
        expect(calls[1]!.body).toEqual({ body: `Done\n\n${BOT_MARKER}` });
    });

    it("reports API errors with the GitHub message and validates the repository name", async () => {
        const client = new GitHubClient("bad", "me/p", fakeFetch({ "GET https://api.github.com/repos/me/p": { status: 401, body: { message: "Bad credentials" } } }, []));

        await expect(client.defaultBranch()).rejects.toThrow(GitHubError);
        await expect(client.defaultBranch()).rejects.toThrow(/401: Bad credentials/);
        expect(() => new GitHubClient("t", "not a repo")).toThrow(/owner\/name/);
    });
});

describe("GitHub tools (architect)", () => {
    const context = { sessionId: "s", toolUseId: "t", workspaceRoot: ".", signal: new AbortController().signal, emit: () => undefined };

    it("creates tasks with the label, lists their state and asks for changes", async () => {
        const calls: Call[] = [];
        const client = new GitHubClient("tok", "me/p", fakeFetch({
            "POST https://api.github.com/repos/me/p/issues/5/comments": { status: 201, body: {} },
            "POST https://api.github.com/repos/me/p/issues": { status: 201, body: { ...issue, number: 9, labels: ["justai"] } },
            "GET https://api.github.com/repos/me/p/issues?state=open": [issue],
        }, calls));

        const [create, list, , changes] = createGitHubTools(() => client, () => "justai");

        expect(await create!.run({ title: "Add login", body: "Use React and add tests." }, context)).toContain("#9");
        expect(calls[0]!.body).toEqual({ title: "Add login", body: "Use React and add tests.", labels: ["justai"] });
        expect(await list!.run({}, context)).toContain("#5 [review (pull request ready)] Add page");

        await changes!.run({ issue: 5, comment: "Rename the button." }, context);
        // Комментарий архитектора — от человека, без метки бота: исполнитель примет его как правку.
        expect(calls.at(-1)!.body).toEqual({ body: "Rename the button." });
    });

    it("explains what to configure when GitHub is not set up", async () => {
        const [create] = createGitHubTools(() => null, () => "justai");
        await expect(create!.run({ title: "x", body: "something long" }, context)).rejects.toThrow(/Settings → GitHub/);
    });
});

describe("unattended sessions", () => {
    it("deny actions that need approval immediately instead of waiting for the user", async () => {
        const events: unknown[] = [];
        const service = new PermissionService({ rulesFile: path.join("missing", "p.json"), emit: event => events.push(event) });
        const run = defineTool({ name: "run_command", description: "", inputSchema: z.object({ command: z.string() }), kind: "execute", run: async () => "" });

        service.setUnattended("s", true);
        const result = await service.forSession("s", () => "full-auto").authorize({
            sessionId: "s", toolUseId: "t", tool: run, input: { command: "rm -rf dist" }, signal: new AbortController().signal,
        });

        expect(result).toMatchObject({ allowed: false, message: expect.stringContaining("unattended") });
        expect(events).toEqual([]);
    });
});
