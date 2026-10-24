import { z } from "zod";

import { isLocalUrl, type BrowserService } from "../../../infrastructure/browser/BrowserService.js";
import { defineTool, ToolError, type Tool } from "./Tool.js";

const ACTION_TIMEOUT_MS = 10_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 15_000;

/**
 * Инструменты проверки интерфейса проекта в браузере (только локальные адреса).
 */
export function createBrowserTools(browser: BrowserService): Tool[] {
    const fail = (error: unknown): never => {
        throw new ToolError(error instanceof Error ? error.message.split("\n")[0]! : String(error));
    };

    const open = defineTool({
        name: "browser_open",
        description: [
            "Opens a page of the project's local dev server (localhost / 127.0.0.1 only) in a headless browser and returns its title, status and console problems.",
            "Start the dev server first with run_command background=true. Use browser_screenshot, browser_text and browser_console to check the result.",
        ].join(" "),
        inputSchema: z.object({
            url: z.string().describe("For example http://localhost:5173/"),
        }),
        kind: "read",
        run: async ({ url }, context) => {
            if (!isLocalUrl(url)) {
                throw new ToolError("browser_open only opens local addresses (localhost, 127.0.0.1). Use web_fetch for internet pages.");
            }

            const { page, console } = await browser.page(context.sessionId);
            console.length = 0;

            const response = await page.goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS }).catch(fail);
            await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);

            const problems = console.filter(entry => entry.type === "error" || entry.type === "pageerror" || entry.type === "requestfailed" || entry.type === "http");

            return [
                `Opened ${page.url()} — HTTP ${response?.status() ?? "?"}, title: ${JSON.stringify(await page.title())}`,
                problems.length > 0
                    ? `Console problems (${problems.length}):\n${problems.map(entry => `- [${entry.type}] ${entry.text}`).join("\n")}`
                    : "No console errors.",
            ].join("\n");
        },
    });

    const screenshot = defineTool({
        name: "browser_screenshot",
        description: "Takes a screenshot of the page opened with browser_open (the image is returned to models that support images). Pass width to check another screen size, for example 375 for a phone.",
        inputSchema: z.object({
            full_page: z.boolean().default(false),
            width: z.number().int().min(320).max(2560).optional().describe("Viewport width in pixels; it stays for later screenshots."),
        }),
        kind: "read",
        run: async ({ full_page, width }, context) => {
            const { page } = await browser.page(context.sessionId);

            if (page.url() === "about:blank") {
                throw new ToolError("No page is open. Call browser_open first.");
            }

            if (width) {
                await page.setViewportSize({ width, height: width < 768 ? 812 : 800 });
            }

            const image = await page.screenshot({ fullPage: full_page, type: "png", timeout: ACTION_TIMEOUT_MS }).catch(fail);
            const size = page.viewportSize();

            return [
                { type: "text", text: `Screenshot of ${page.url()} (${full_page ? "full page" : "viewport"} ${size ? `${size.width}×${size.height}` : ""}).` },
                { type: "image", mediaType: "image/png", dataBase64: image.toString("base64") },
            ];
        },
    });

    const text = defineTool({
        name: "browser_text",
        description: "Returns the visible text of the page or of the element matching a CSS selector.",
        inputSchema: z.object({
            selector: z.string().optional().describe("CSS selector; omit for the whole page."),
        }),
        kind: "read",
        run: async ({ selector }, context) => {
            const { page } = await browser.page(context.sessionId);
            const value = await page.locator(selector ?? "body").first().innerText({ timeout: ACTION_TIMEOUT_MS }).catch(fail);

            return value.length > MAX_TEXT_CHARS
                ? `${value.slice(0, MAX_TEXT_CHARS)}\n[… ${value.length - MAX_TEXT_CHARS} more characters]`
                : value || "(no visible text)";
        },
    });

    const consoleTool = defineTool({
        name: "browser_console",
        description: "Returns console messages, page errors, failed requests and HTTP errors collected since the page was opened.",
        inputSchema: z.object({
            only_errors: z.boolean().default(false),
        }),
        kind: "read",
        run: async ({ only_errors }, context) => {
            const { console } = await browser.page(context.sessionId);
            const entries = only_errors
                ? console.filter(entry => ["error", "pageerror", "requestfailed", "http"].includes(entry.type))
                : console;

            return entries.length > 0
                ? entries.map(entry => `[${entry.type}] ${entry.text}${entry.location ? ` (${entry.location})` : ""}`).join("\n")
                : "No console messages.";
        },
    });

    const click = defineTool({
        name: "browser_click",
        description: "Clicks the element matching a CSS selector or text selector (for example \"text=Save\") on the opened page.",
        inputSchema: z.object({
            selector: z.string(),
        }),
        kind: "write",
        changesFiles: false,
        run: async ({ selector }, context) => {
            const { page } = await browser.page(context.sessionId);

            try {
                await page.locator(selector).first().click({ timeout: ACTION_TIMEOUT_MS });
            }
            catch (error) {
                // Маленькая модель угадывает селектор («text=Угадай героя» у кнопки с эмодзи и описанием) —
                // показываем, что на странице можно нажать и каким селектором.
                const hints = await clickableHints(page).catch(() => [] as string[]);
                throw new ToolError([
                    error instanceof Error ? error.message.split("\n")[0]! : String(error),
                    ...(hints.length ? ["Clickable elements on the page (use one of these selectors):", ...hints] : []),
                ].join("\n"));
            }
            await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);

            return `Clicked ${selector}. Page: ${page.url()}`;
        },
    });

    const type = defineTool({
        name: "browser_type",
        description: "Fills an input matching a selector with text (replacing its value), optionally pressing Enter.",
        inputSchema: z.object({
            selector: z.string(),
            text: z.string(),
            submit: z.boolean().default(false),
        }),
        kind: "write",
        changesFiles: false,
        run: async ({ selector, text: value, submit }, context) => {
            const { page } = await browser.page(context.sessionId);
            const field = page.locator(selector).first();

            await field.fill(value, { timeout: ACTION_TIMEOUT_MS }).catch(fail);

            if (submit) {
                await field.press("Enter").catch(fail);
                await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
            }

            return `Typed into ${selector}${submit ? " and pressed Enter" : ""}.`;
        },
    });

    const evaluate = defineTool({
        name: "browser_evaluate",
        description: [
            "Runs JavaScript in the page opened with browser_open and returns the result as JSON (for example",
            "\"document.querySelector('#score').textContent\" or \"document.querySelector('.card').click(); document.title\").",
            "Use it to read state or click elements by selector when browser_click is not enough. Only local pages.",
        ].join(" "),
        inputSchema: z.object({
            code: z.string().min(1).max(5_000).describe("A JavaScript expression or statements; the value of the last expression is returned."),
        }),
        kind: "write",
        changesFiles: false,
        run: async ({ code }, context) => {
            const { page } = await browser.page(context.sessionId);

            if (page.url() === "about:blank") {
                throw new ToolError("No page is open. Call browser_open first.");
            }

            // Страница могла уйти по ссылке наружу — код выполняется только на локальном адресе.
            if (!isLocalUrl(page.url())) {
                throw new ToolError(`The page is now ${page.url()}, not a local address; browser_evaluate only runs on local pages.`);
            }

            // Как консоль браузера: значение последнего выражения; промис дожидается.
            const value = await page.evaluate(async (source: string) => {
                // eslint-disable-next-line no-eval
                const result: unknown = await (0, eval)(source);
                try {
                    return JSON.stringify(result === undefined ? null : result, null, 2) ?? "null";
                }
                catch {
                    return String(result);
                }
            }, code).catch(fail);

            await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => undefined);
            const text = value.length > MAX_TEXT_CHARS ? `${value.slice(0, MAX_TEXT_CHARS)}\n[… truncated]` : value;

            return `Result: ${text}\nPage: ${page.url()}`;
        },
    });

    const close = defineTool({
        name: "browser_close",
        description: "Closes the browser page of this session.",
        inputSchema: z.object({}),
        kind: "read",
        run: async (_input, context) =>
            (await browser.close(context.sessionId)) ? "Browser page closed." : "No browser page was open.",
    });

    return [open, screenshot, text, consoleTool, click, type, evaluate, close];
}

/** Видимые кнопки, ссылки и поля: готовый селектор и текст — до 20 штук. */
async function clickableHints(page: { evaluate<R>(fn: () => R): Promise<R> }): Promise<string[]> {
    return page.evaluate(() => {
        const css = (value: string) => (window.CSS?.escape ? window.CSS.escape(value) : value);
        const nodes = Array.from(document.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [role=button], [onclick]"));

        return nodes
            .filter(node => node.offsetParent !== null || node.getClientRects().length > 0)
            .slice(0, 20)
            .map(node => {
                const tag = node.tagName.toLowerCase();
                const data = Array.from(node.attributes).find(attribute => attribute.name.startsWith("data-"));
                const selector = node.id ? `#${css(node.id)}`
                    : data ? `${tag}[${data.name}="${data.value}"]`
                        : node.classList.length ? `${tag}.${Array.from(node.classList).map(css).join(".")}`
                            : tag;
                const label = (node.innerText || (node as HTMLInputElement).value || node.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 50);
                return `- ${selector}${label ? ` — "${label}"` : ""}`;
            });
    });
}
