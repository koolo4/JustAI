import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatReport, parseArgs } from "../../eval/run.js";
import { EVAL_TASKS, type EvalTask } from "../../eval/tasks.js";
import { createTempWorkspace, type TempWorkspace } from "../helpers/tempWorkspace.js";

async function materialize(workspace: TempWorkspace, files: Record<string, string>): Promise<void> {
    for (const [file, content] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(workspace.root, file)), { recursive: true });
        await writeFile(path.join(workspace.root, file), content, "utf8");
    }
}

describe("eval tasks", () => {
    const workspaces: TempWorkspace[] = [];

    afterEach(async () => {
        await Promise.all(workspaces.splice(0).map(workspace => workspace.dispose()));
    });

    it.each(EVAL_TASKS.map(task => [task.id, task] as [string, EvalTask]))(
        "%s: the check fails on the fixture and passes with the reference solution",
        async (_id, task) => {
            const workspace = await createTempWorkspace();
            workspaces.push(workspace);

            await materialize(workspace, task.files);
            expect(task.check(workspace.root)).not.toBe("");

            await materialize(workspace, task.solution);
            expect(task.check(workspace.root)).toBe("");
        },
        60_000,
    );

    it("parses command-line options", () => {
        const options = parseArgs(["--provider", "groq", "--profile=planner", "--executor", "ollama", "--tasks", "fix-bug,create-cli", "--runs", "2", "--trace"], {});

        expect(options).toMatchObject({ provider: "groq", profile: "planner", executor: "ollama", runs: 2, trace: true, timeoutMs: 300_000 });
        expect(options.tasks.map(task => task.id)).toEqual(["fix-bug", "create-cli"]);
        expect(parseArgs([], { JUSTAI_PROVIDER: "ollama" }).provider).toBe("ollama");
        expect(() => parseArgs(["--tasks", "nope"], {})).toThrow(/Unknown task/);
    });

    it("formats a summary report", () => {
        const report = formatReport([
            { task: "fix-bug", run: 1, passed: true, reason: "", status: "completed", steps: 4, inputTokens: 1000, outputTokens: 200, seconds: 30 },
            { task: "create-cli", run: 1, passed: false, reason: "greet.js was not created", status: "failed", steps: 2, inputTokens: 500, outputTokens: 50, seconds: 10 },
        ], "coder/ollama");

        expect(report).toContain("Eval: coder/ollama");
        expect(report).toContain("greet.js was not created");
        expect(report).toContain("Passed 1/2 · total 40s · 1750 tokens");
    });
});
