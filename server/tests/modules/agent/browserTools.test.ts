import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserService, isLocalUrl } from "../../../src/infrastructure/browser/BrowserService.js";
import { createBrowserTools } from "../../../src/modules/agent/tools/browserTools.js";
import { ToolError, type Tool, type ToolContext } from "../../../src/modules/agent/tools/Tool.js";

const PAGE = `<!doctype html>
<html><head><title>Demo app</title></head>
<body>
  <h1 id="title">Counter: 0</h1>
  <button id="inc" onclick="document.getElementById('title').textContent = 'Counter: 1'">Increment</button>
  <input id="name" />
  <script>console.error("Failed to load config: undefined is not a function");</script>
  <img src="/missing.png" />
</body></html>`;

let available = true;

describe("browser tools", () => {
    let server: http.Server;
    let base: string;
    const browser = new BrowserService();
    let tools: Map<string, Tool>;
    const context = { sessionId: "s1", signal: new AbortController().signal, emit: () => undefined } as unknown as ToolContext;

    const run = (name: string, input: unknown) => {
        const tool = tools.get(name)!;
        return tool.run(tool.inputSchema.parse(input), context);
    };

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            if (req.url === "/") {
                res.writeHead(200, { "Content-Type": "text/html" });
                res.end(PAGE);
                return;
            }

            res.writeHead(404);
            res.end();
        });

        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
        tools = new Map(createBrowserTools(browser).map(tool => [tool.name, tool]));

        try {
            await browser.page("probe");
            await browser.close("probe");
        }
        catch {
            available = false;
        }
        // Запуск браузера под нагрузкой (параллельные тесты, сборка) бывает долгим.
    }, 180_000);

    afterAll(async () => {
        await browser.closeAll();
        await new Promise(resolve => server.close(resolve));
    });

    it("opens a local page and reports console errors and failed requests", async (test) => {
        if (!available) test.skip();

        const result = await run("browser_open", { url: base }) as string;

        expect(result).toContain("HTTP 200");
        expect(result).toContain("title: \"Demo app\"");
        expect(result).toContain("[error] Failed to load config: undefined is not a function");
        expect(result).toContain("404");
    }, 60_000);

    it("reads text, clicks, types and takes a screenshot", async (test) => {
        if (!available) test.skip();

        expect(await run("browser_text", { selector: "#title" })).toBe("Counter: 0");
        expect(await run("browser_click", { selector: "#inc" })).toContain("Clicked #inc");
        expect(await run("browser_text", { selector: "#title" })).toBe("Counter: 1");
        expect(await run("browser_type", { selector: "#name", text: "Ann" })).toContain("Typed into #name");

        const shot = await run("browser_screenshot", {}) as Array<{ type: string; mediaType?: string; dataBase64?: string }>;
        expect(shot[1]).toMatchObject({ type: "image", mediaType: "image/png" });
        expect(Buffer.from(shot[1]!.dataBase64!, "base64").subarray(1, 4).toString()).toBe("PNG");

        expect(await run("browser_console", { only_errors: true })).toContain("Failed to load config");
        expect(tools.get("browser_click")!.changesFiles).toBe(false);
    }, 60_000);

    it("evaluates JavaScript on the page: clicks by selector and reads state", async (test) => {
        if (!available) test.skip();

        await run("browser_evaluate", { code: "document.querySelector('#title').textContent = 'reset'" });
        expect(await run("browser_evaluate", { code: "document.querySelector('#inc').click(); document.querySelector('#title').textContent" }))
            .toContain("\"Counter: 1\"");
        expect(await run("browser_evaluate", { code: "({ items: [1, 2] })" })).toContain("\"items\"");
        await expect(run("browser_evaluate", { code: "throw new Error('boom')" })).rejects.toThrow(/boom/);
    }, 60_000);

    it("refuses non-local addresses and reports missing elements as tool errors", async (test) => {
        if (!available) test.skip();

        await expect(run("browser_open", { url: "https://example.com/" })).rejects.toBeInstanceOf(ToolError);
        // Ненайденный селектор — ошибка со списком того, что на странице можно нажать.
        await expect(run("browser_click", { selector: "#does-not-exist" })).rejects.toThrow(/Clickable elements[\s\S]*#inc/);
        expect(await run("browser_close", {})).toBe("Browser page closed.");
    }, 60_000);
});

describe("isLocalUrl", () => {
    it("accepts only loopback http(s) addresses", () => {
        expect(isLocalUrl("http://localhost:5173/")).toBe(true);
        expect(isLocalUrl("http://app.localhost:3000")).toBe(true);
        expect(isLocalUrl("https://127.0.0.1:8443/x")).toBe(true);
        expect(isLocalUrl("http://[::1]:3000/")).toBe(true);
        expect(isLocalUrl("http://localhost.evil.com/")).toBe(false);
        expect(isLocalUrl("http://192.168.1.10/")).toBe(false);
        expect(isLocalUrl("file:///C:/Windows/win.ini")).toBe(false);
        expect(isLocalUrl("not a url")).toBe(false);
    });
});
