import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { AgentEvent } from "@justai/shared";

import { EventBus } from "../../../src/core/events/index.js";
import { ProcessManager } from "../../../src/infrastructure/process/ProcessManager.js";
import { AgentFileSystem } from "../../../src/modules/agent/tools/AgentFileSystem.js";
import { createShellTools } from "../../../src/modules/agent/tools/shellTools.js";
import { ToolError, type Tool, type ToolContext } from "../../../src/modules/agent/tools/Tool.js";
import { createTempWorkspace, type TempWorkspace } from "../../helpers/tempWorkspace.js";

// Кавычки одинаково работают в PowerShell и bash.
const node = (script: string) => `node -e "${script}"`;

describe("shell tools", () => {
    let workspace: TempWorkspace;
    let processes: ProcessManager;
    let tools: Map<string, Tool>;
    let events: AgentEvent[];

    const context = (signal = new AbortController().signal) => ({
        sessionId: "s1",
        toolUseId: "t1",
        signal,
        emit: (event: AgentEvent) => events.push(event),
    }) as unknown as ToolContext;

    const run = (name: string, input: unknown, ctx = context()) => {
        const tool = tools.get(name)!;
        return tool.run(tool.inputSchema.parse(input), ctx) as Promise<string>;
    };

    beforeAll(async () => {
        workspace = await createTempWorkspace();
        await workspace.write("sub/marker.txt", "x");
        processes = new ProcessManager();
        tools = new Map(createShellTools(
            new AgentFileSystem(workspace.root, new EventBus(), () => undefined),
            processes,
        ).map(tool => [tool.name, tool]));
    });

    afterEach(() => {
        events = [];
    });

    afterAll(async () => {
        await processes.killAll();
        await workspace.dispose();
    });

    events = [];

    it("runs a command and returns exit code and output, streaming progress", async () => {
        const result = await run("run_command", { command: node("console.log('hello'); console.error('warn')") });

        expect(result).toContain("Exit code: 0");
        expect(result).toContain("hello");
        expect(result).toContain("warn");
        expect(events.some(event => event.type === "tool.progress")).toBe(true);
    });

    it("keeps non-ASCII output intact", async () => {
        const result = await run("run_command", { command: node("console.log('привет, мир')") });
        expect(result).toContain("привет, мир");
    });

    it("runs in the requested directory", async () => {
        const result = await run("run_command", { command: node("console.log(require('fs').existsSync('marker.txt'))"), cwd: "sub" });
        expect(result).toContain("true");
    });

    it("reports a non-zero exit code as a tool error with the output", async () => {
        const failure = run("run_command", { command: node("console.log('boom'); process.exit(3)") });

        await expect(failure).rejects.toBeInstanceOf(ToolError);
        await expect(failure).rejects.toThrow(/Exit code: 3[\s\S]*boom/);
    });

    it("kills commands that exceed the timeout", async () => {
        const started = Date.now();

        await expect(run("run_command", { command: node("setTimeout(() => {}, 60000)"), timeout_ms: 1500 }))
            .rejects.toThrow("Timed out after 1.5s");

        expect(Date.now() - started).toBeLessThan(10_000);
    }, 20_000);

    it("cancels a running command when the session is stopped", async () => {
        const controller = new AbortController();
        const running = run("run_command", { command: node("setTimeout(() => {}, 60000)") }, context(controller.signal));

        setTimeout(() => controller.abort(), 500);

        await expect(running).rejects.toThrow("Cancelled");
    }, 20_000);

    it("does not pass API keys to commands", async () => {
        process.env.ANTHROPIC_API_KEY = "secret-value";

        try {
            const result = await run("run_command", { command: node("console.log('key=' + (process.env.ANTHROPIC_API_KEY || 'none') + ' ci=' + process.env.CI)") });
            expect(result).toContain("key=none ci=1");
        }
        finally {
            delete process.env.ANTHROPIC_API_KEY;
        }
    });

    it("manages background processes", async () => {
        const started = await run("run_command", {
            command: node("console.log('server ready'); setInterval(() => console.log('tick'), 200)"),
            background: true,
        });

        const id = started.match(/process ([0-9a-f]+)/)![1]!;
        expect(started).toContain("server ready");
        expect(await run("list_processes", {})).toContain(id);

        const output = await run("read_output", { process_id: id, since: 0, wait_ms: 500 });
        expect(output).toContain("running");
        expect(output).toContain("tick");

        expect(await run("kill_process", { process_id: id })).toContain("killed");
        await expect(run("read_output", { process_id: "nope" })).rejects.toBeInstanceOf(ToolError);
    }, 20_000);
});
