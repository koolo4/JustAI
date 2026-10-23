import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AgentEvent, Message, ToolResultBlock } from "@justai/shared";

import { MockProvider, type MockScript } from "../../../src/modules/agent/providers/MockProvider.js";
import { ModelOutputError } from "../../../src/modules/agent/providers/ModelProvider.js";
import { AgentLoop, asksToBuild, createMessage, MAX_TOOL_OUTPUT_CHARS } from "../../../src/modules/agent/runtime/AgentLoop.js";
import { DEFAULT_BUDGET, type BudgetLimits } from "../../../src/modules/agent/runtime/Budget.js";
import { defineTool, ToolError, type Tool } from "../../../src/modules/agent/tools/Tool.js";

const echoTool = defineTool({
    name: "echo",
    description: "Echo text back.",
    inputSchema: z.object({ text: z.string() }),
    kind: "read",
    run: async ({ text }) => `echo:${text}`,
});

const failingTool = defineTool({
    name: "fail",
    description: "Always fails.",
    inputSchema: z.object({}),
    kind: "write",
    run: async () => {
        throw new ToolError("disk is full");
    },
});

function setup(
    script: MockScript,
    options: { tools?: Tool[]; limits?: BudgetLimits; controller?: AbortController } = {},
) {
    const provider = new MockProvider(script);
    const events: AgentEvent[] = [];
    const saved: Message[] = [];
    const controller = options.controller ?? new AbortController();

    const loop = new AgentLoop({
        sessionId: "s1",
        workspaceRoot: process.cwd(),
        provider,
        tools: options.tools ?? [echoTool, failingTool],
        system: "test system",
        limits: options.limits ?? DEFAULT_BUDGET,
        signal: controller.signal,
        emit: event => events.push(event),
        onMessage: async message => {
            saved.push(message);
        },
    });

    const user = createMessage("user", [{ type: "text", text: "go" }]);

    return { provider, events, saved, controller, loop, user };
}

function toolResults(message: Message | undefined): ToolResultBlock[] {
    return (message?.content ?? []).filter(
        (block): block is ToolResultBlock => block.type === "tool_result",
    );
}

describe("MockProvider", () => {
    it("returns two parallel tool calls, then text", async () => {
        const { loop, user, saved, provider } = setup([
            { toolCalls: [{ name: "echo", input: { text: "a" } }, { name: "echo", input: { text: "b" } }] },
            { text: "done" },
        ]);

        const result = await loop.run([user]);

        expect(result.status).toBe("completed");
        expect(provider.requests).toHaveLength(2);

        const results = toolResults(saved[1]);
        expect(results.map(r => r.content)).toEqual(["echo:a", "echo:b"]);

        // Второй запрос содержит всю историю: user, assistant(tool_use×2), user(tool_result×2)
        expect(provider.requests[1]!.messages.map(m => m.role)).toEqual(["user", "assistant", "user"]);
    });
});

describe("AgentLoop", () => {
    it("runs several tool steps and finishes with a final answer", async () => {
        const { loop, user, saved, events } = setup([
            { text: "step 1", toolCalls: [{ name: "echo", input: { text: "1" } }] },
            { toolCalls: [{ name: "echo", input: { text: "2" } }] },
            { toolCalls: [{ name: "echo", input: { text: "3" } }] },
            { text: "all done" },
        ]);

        const result = await loop.run([user]);

        expect(result).toMatchObject({ status: "completed", steps: 4 });
        expect(saved).toHaveLength(7);
        expect(saved.at(-1)!.content).toEqual([{ type: "text", text: "all done" }]);
        expect(saved.at(-1)!.meta?.provider).toBe("mock");

        const types = events.map(event => event.type);
        expect(types).toContain("assistant.delta");
        expect(types.filter(type => type === "tool.started")).toHaveLength(3);
        expect(types.filter(type => type === "tool.finished")).toHaveLength(3);
    });

    it("returns tool errors to the model and keeps going", async () => {
        const { loop, user, saved, provider } = setup([
            { toolCalls: [{ name: "fail", input: {} }] },
            { text: "I could not write the file: disk is full." },
        ]);

        const result = await loop.run([user]);

        expect(result.status).toBe("completed");
        expect(toolResults(saved[1])).toEqual([
            { type: "tool_result", toolUseId: expect.any(String), content: "disk is full", isError: true },
        ]);
        expect(provider.requests).toHaveLength(2);
    });

    it("reports unknown tools and invalid input as tool errors", async () => {
        const { loop, user, saved } = setup([
            { toolCalls: [{ name: "nope", input: {} }, { name: "echo", input: { text: 42 } }] },
            { text: "ok" },
        ]);

        await loop.run([user]);

        const [unknown, invalid] = toolResults(saved[1]);
        expect(unknown).toMatchObject({ isError: true, content: expect.stringContaining("Unknown tool 'nope'") });
        expect(invalid).toMatchObject({ isError: true, content: expect.stringContaining("Invalid input for 'echo'") });
    });

    it("runs tools called with a namespace prefix (repo_browser.list_dir)", async () => {
        const { loop, user, saved, events } = setup([
            { toolCalls: [{ name: "repo_browser.echo", input: { text: "a" } }, { name: "functions.echo", input: { text: "b" } }] },
            { text: "ok" },
        ]);

        await loop.run([user]);

        expect(toolResults(saved[1]).map(result => result.content)).toEqual(["echo:a", "echo:b"]);
        expect(events.filter(event => event.type === "tool.started").map(event => (event as { name: string }).name)).toEqual(["echo", "echo"]);
    });

    it("recognises requests to build something", () => {
        expect(asksToBuild("мне нужен сайт по дота 2 где нужно угадывать героев - придумай несколько режимов")).toBe(true);
        expect(asksToBuild("создай файл tmp/a.txt")).toBe(true);
        expect(asksToBuild("Build a todo app")).toBe(true);
        expect(asksToBuild("объясни, как работает этот код")).toBe(false);
        expect(asksToBuild("дай только идеи для сайта, без кода")).toBe(false);
        expect(asksToBuild("go")).toBe(false);
    });

    it("sends a model that only described the work back to build it, once", async () => {
        const writer = defineTool({ name: "write_file", description: "w", inputSchema: z.object({ path: z.string() }), kind: "write", run: async () => "ok" });
        const { loop, saved, provider } = setup([
            { text: "Ideas: mode 1, mode 2, neon style." },
            { toolCalls: [{ name: "write_file", input: { path: "index.html" } }] },
            { text: "Built index.html." },
        ], { tools: [writer] });

        const result = await loop.run([createMessage("user", [{ type: "text", text: "мне нужен сайт-игра, придумай режимы" }])]);

        expect(result.status).toBe("completed");
        expect(provider.requests).toHaveLength(3);
        expect(saved[1]!.content).toEqual([{ type: "text", text: expect.stringContaining("asked you to build this") }]);

        // Второй раз не подталкиваем: ответ текстом после правок — нормальное завершение.
        const again = setup([{ text: "Ideas only." }, { text: "Still ideas." }], { tools: [writer] });
        await again.loop.run([createMessage("user", [{ type: "text", text: "сделай сайт" }])]);
        expect(again.provider.requests).toHaveLength(2);
    });

    it("reminds the model of unfinished plan items before it finishes, at most twice", async () => {
        const todo = defineTool({ name: "todo_write", description: "t", inputSchema: z.object({ todos: z.array(z.object({ content: z.string(), status: z.string() })) }), kind: "read", run: async () => "ok" });
        const plan = (status: string) => ({ todos: [{ content: "index.html", status: "completed" }, { content: "script.js", status }] });

        const { loop, saved, provider } = setup([
            { toolCalls: [{ name: "todo_write", input: plan("pending") }] },
            { text: "Here are some ideas instead." },
            { toolCalls: [{ name: "todo_write", input: plan("completed") }] },
            { text: "Done: index.html and script.js." },
        ], { tools: [todo] });

        expect((await loop.run([createMessage("user", [{ type: "text", text: "go" }])])).status).toBe("completed");
        expect(provider.requests).toHaveLength(4);
        expect(saved[3]!.content).toEqual([{ type: "text", text: expect.stringContaining("unfinished items:\n- script.js") }]);

        const stubborn = setup([
            { toolCalls: [{ name: "todo_write", input: plan("pending") }] },
            { text: "ideas" },
            { text: "ideas" },
            { text: "ideas" },
        ], { tools: [todo] });
        await stubborn.loop.run([createMessage("user", [{ type: "text", text: "go" }])]);
        expect(stubborn.provider.requests).toHaveLength(4);
    });

    it("nudges a model that repeats the same failing call, then stops it", async () => {
        const failing = { toolCalls: [{ name: "fail", input: {} }] };
        const { loop, saved, provider } = setup([failing, failing, failing, failing, failing, failing, { text: "never reached" }]);

        const result = await loop.run([createMessage("user", [{ type: "text", text: "go" }])]);

        expect(result).toMatchObject({ status: "failed", reason: expect.stringContaining("repeated the same failing fail call 6 times") });
        expect(provider.requests).toHaveLength(6);

        // На третьем повторе к результату приложена подсказка сменить подход.
        const third = saved.filter(message => message.role === "user")[2]!;
        expect(third.content.at(-1)).toMatchObject({ type: "text", text: expect.stringContaining("same failing fail call 3 times") });
    });

    it("keeps counting a repeated failing call when the model reads in between", async () => {
        // «Прочитать → та же неудачная правка → прочитать…» — так модель тратила все 100 шагов.
        const failing = { toolCalls: [{ name: "fail", input: {} }] };
        const reading = { toolCalls: [{ name: "echo", input: { text: "file" } }] };
        const { loop, provider } = setup([...Array.from({ length: 6 }, () => [failing, reading]).flat(), { text: "never reached" }]);

        const result = await loop.run([createMessage("user", [{ type: "text", text: "go" }])]);

        expect(result).toMatchObject({ status: "failed", reason: expect.stringContaining("6 times") });
        expect(provider.requests).toHaveLength(11);
    });

    it("does not treat an empty reply as finished", async () => {
        const { loop, user, saved, provider } = setup([
            { text: "" },
            { toolCalls: [{ name: "echo", input: { text: "now" } }] },
            { text: "done" },
        ]);

        const result = await loop.run([user]);

        expect(result.status).toBe("completed");
        expect(provider.requests).toHaveLength(3);
        expect(saved[1]!.content).toEqual([{ type: "text", text: expect.stringContaining("Your reply was empty") }]);
    });

    it("stops within a second when aborted during a model call", async () => {
        const controller = new AbortController();
        const { loop, user } = setup(
            [{ text: "slow", delayMs: 10_000 }],
            { controller },
        );

        const started = Date.now();
        const running = loop.run([user]);
        setTimeout(() => controller.abort(), 50);

        const result = await running;

        expect(result.status).toBe("stopped");
        expect(Date.now() - started).toBeLessThan(1000);
    });

    it("answers pending tool calls as cancelled when aborted during tool execution", async () => {
        const controller = new AbortController();
        const slowTool = defineTool({
            name: "slow",
            description: "Waits for abort.",
            inputSchema: z.object({}),
            kind: "execute",
            run: (_input, context) => new Promise((_resolve, reject) => {
                context.signal.addEventListener("abort", () => reject(new Error("aborted")));
                controller.abort();
            }),
        });

        const { loop, user, saved } = setup(
            [{ toolCalls: [{ name: "slow", input: {} }, { name: "echo", input: { text: "x" } }] }],
            { tools: [slowTool, echoTool], controller },
        );

        const result = await loop.run([user]);

        expect(result.status).toBe("stopped");
        // История остаётся валидной: на каждый tool_use есть tool_result.
        expect(toolResults(saved[1])).toEqual([
            expect.objectContaining({ isError: true, content: "Cancelled by user." }),
            expect.objectContaining({ isError: true, content: expect.stringContaining("Cancelled") }),
        ]);
    });

    it("stops when the step budget is exhausted", async () => {
        const { loop, user } = setup(
            () => ({ toolCalls: [{ name: "echo", input: { text: "again" } }] }),
            { limits: { ...DEFAULT_BUDGET, maxSteps: 3 } },
        );

        const result = await loop.run([user]);

        expect(result).toMatchObject({ status: "stopped", steps: 3 });
        expect(result.reason).toContain("step limit");
    });

    it("does not execute tool calls cut off by max_tokens", async () => {
        let ran = false;
        const tracked = defineTool({
            ...echoTool,
            run: async () => {
                ran = true;
                return "ran";
            },
        });

        const { loop, user, saved } = setup(
            [
                { toolCalls: [{ name: "echo", input: { text: "partial" } }], stopReason: "max_tokens" },
                { text: "retrying in smaller steps" },
            ],
            { tools: [tracked] },
        );

        await loop.run([user]);

        expect(ran).toBe(false);
        expect(toolResults(saved[1])[0]).toMatchObject({ isError: true });
    });

    it("asks to continue a text answer cut off by max_tokens", async () => {
        const { loop, user, saved } = setup([
            { text: "part one", stopReason: "max_tokens" },
            { text: "part two" },
        ]);

        const result = await loop.run([user]);

        expect(result.status).toBe("completed");
        expect(saved.map(m => m.role)).toEqual(["assistant", "user", "assistant"]);
    });

    it("tells the model when its text tool call could not be parsed instead of finishing", async () => {
        const { loop, user, saved } = setup([
            { text: "<tool_call>{broken", formatError: "could not parse your tool call" },
            { toolCalls: [{ name: "echo", input: { text: "ok" } }] },
            { text: "done" },
        ]);

        const result = await loop.run([user]);

        expect(result.status).toBe("completed");
        expect(saved[1]!.content).toEqual([{ type: "text", text: "[JustAI] could not parse your tool call" }]);
        expect(toolResults(saved[3])[0]).toMatchObject({ content: "echo:ok" });
    });

    it("gives up on format errors after three hints", async () => {
        const { loop, user, provider } = setup(() => ({ text: "<tool_call>{", formatError: "unparsable" }));

        const result = await loop.run([user]);

        expect(result.status).toBe("completed");
        expect(provider.requests).toHaveLength(4);
    });

    it("challenges a small model that claims changes without making any", async () => {
        const writeTool = defineTool({
            name: "write_file",
            description: "write",
            inputSchema: z.object({ path: z.string() }),
            kind: "write",
            run: async () => "written",
        });

        const provider = Object.assign(new MockProvider([
            { text: "The function `mul` has been added to math.js." },
            { toolCalls: [{ name: "write_file", input: { path: "math.js" } }] },
            { text: "I added mul." },
        ]), { smallModelGuards: true });

        const saved: Message[] = [];
        const loop = new AgentLoop({
            sessionId: "s",
            workspaceRoot: process.cwd(),
            provider,
            tools: [writeTool],
            system: "",
            limits: DEFAULT_BUDGET,
            signal: new AbortController().signal,
            emit: () => undefined,
            onMessage: async message => {
                saved.push(message);
            },
        });

        const result = await loop.run([createMessage("user", [{ type: "text", text: "add mul" }])]);

        expect(result.status).toBe("completed");
        expect(JSON.stringify(saved[1]!.content)).toContain("no file was changed in this run");
        // После реальной записи утверждение «I added» уже не оспаривается.
        expect(saved.at(-1)!.content).toEqual([{ type: "text", text: "I added mul." }]);
    });

    it("does not challenge large models (guards off)", async () => {
        const { loop, user, saved } = setup([{ text: "I added the function." }]);

        await loop.run([user]);

        expect(saved).toHaveLength(1);
    });

    it("fails on refusal without running tools", async () => {
        const { loop, user, saved } = setup([
            { toolCalls: [{ name: "echo", input: { text: "x" } }], stopReason: "refusal" },
        ]);

        const result = await loop.run([user]);

        expect(result.status).toBe("failed");
        expect(saved).toHaveLength(1);
    });

    it("retries unparseable model output, then fails", async () => {
        const { loop, user, provider } = setup(() => ({ error: new ModelOutputError("bad json") }));

        const result = await loop.run([user]);

        expect(result).toMatchObject({ status: "failed", reason: "bad json" });
        expect(provider.requests).toHaveLength(3);
    });

    it("fails on API errors without retrying", async () => {
        const { loop, user, provider } = setup(() => ({ error: new Error("401 invalid x-api-key") }));

        const result = await loop.run([user]);

        expect(result).toMatchObject({ status: "failed", reason: "401 invalid x-api-key" });
        expect(provider.requests).toHaveLength(1);
    });

    it("truncates huge tool output", async () => {
        const big = defineTool({
            ...echoTool,
            run: async () => "x".repeat(MAX_TOOL_OUTPUT_CHARS + 100),
        });

        const { loop, user, saved } = setup(
            [{ toolCalls: [{ name: "echo", input: { text: "" } }] }, { text: "ok" }],
            { tools: [big] },
        );

        await loop.run([user]);

        const content = toolResults(saved[1])[0]!.content as string;
        expect(content.length).toBeLessThan(MAX_TOOL_OUTPUT_CHARS + 300);
        expect(content).toContain("output truncated");
    });
});
