import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createWebTools } from "../../../src/modules/agent/tools/webTools.js";
import { ToolError, type ToolContext } from "../../../src/modules/agent/tools/Tool.js";

describe("web_fetch", () => {
    let server: http.Server;
    let base: string;
    const tool = createWebTools()[0]!;
    const context = { sessionId: "s", signal: new AbortController().signal, emit: () => undefined } as unknown as ToolContext;
    const run = (input: unknown) => tool.run(tool.inputSchema.parse(input), context) as Promise<string>;

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            switch (req.url) {
                case "/page":
                    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                    res.end("<html><head><title>T</title><style>p{}</style></head><body><h1>Docs</h1><p>Привет, <b>world</b></p><script>alert(1)</script><pre><code>npm test</code></pre></body></html>");
                    break;
                case "/json":
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ version: "1.2.3" }));
                    break;
                case "/redirect":
                    res.writeHead(302, { Location: "/json" });
                    res.end();
                    break;
                case "/big":
                    res.writeHead(200, { "Content-Type": "text/plain" });
                    res.end("x".repeat(50_000));
                    break;
                case "/image":
                    res.writeHead(200, { "Content-Type": "image/png" });
                    res.end(Buffer.from([1, 2, 3]));
                    break;
                default:
                    res.writeHead(404);
                    res.end("not found");
            }
        });

        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        await new Promise(resolve => server.close(resolve));
    });

    it("is a network tool (always asks the user)", () => {
        expect(tool.kind).toBe("network");
    });

    it("converts HTML to Markdown without scripts and styles", async () => {
        const result = await run({ url: `${base}/page` });

        expect(result).toContain("# Docs");
        expect(result).toContain("Привет, **world**");
        expect(result).toContain("```\nnpm test\n```");
        expect(result).not.toContain("alert");
        expect(result).not.toContain("p{}");
    });

    it("returns JSON as text and follows redirects", async () => {
        const result = await run({ url: `${base}/redirect` });

        expect(result).toContain(`URL: ${base}/json`);
        expect(result).toContain("\"version\":\"1.2.3\"");
    });

    it("truncates long content", async () => {
        const result = await run({ url: `${base}/big`, max_chars: 1000 });

        expect(result).toContain("49000 more characters");
    });

    it("reports HTTP errors, unsupported types and bad URLs", async () => {
        await expect(run({ url: `${base}/missing` })).rejects.toThrow("HTTP 404");
        await expect(run({ url: `${base}/image` })).rejects.toThrow("Unsupported content type");
        await expect(run({ url: "ftp://example.com/file" })).rejects.toBeInstanceOf(ToolError);
        expect(() => tool.inputSchema.parse({ url: "not a url" })).toThrow();
    });
});
