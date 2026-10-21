import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const MAX_CONSOLE_ENTRIES = 200;

export interface ConsoleEntry {
    type: string;
    text: string;
    location?: string;
}

interface SessionPage {
    context: BrowserContext;
    page: Page;
    console: ConsoleEntry[];
}

export interface BrowserServiceOptions {
    /** "msedge" / "chrome" — системный браузер вместо Chromium от Playwright. */
    channel?: string;
    headless?: boolean;
}

/**
 * Браузер для проверки интерфейса проекта: одна страница на сессию агента,
 * чистый временный профиль (без логинов пользователя), сбор консоли и ошибок страницы.
 */
export class BrowserService {

    private browser: Promise<Browser> | null = null;

    private readonly sessions = new Map<string, SessionPage>();

    constructor(
        private readonly options: BrowserServiceOptions = {},
    ) {}

    public async page(sessionId: string): Promise<SessionPage> {
        const existing = this.sessions.get(sessionId);

        if (existing && !existing.page.isClosed()) {
            return existing;
        }

        const browser = await this.launch();
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();
        const entry: SessionPage = { context, page, console: [] };

        const push = (item: ConsoleEntry) => {
            entry.console.push(item);

            if (entry.console.length > MAX_CONSOLE_ENTRIES) {
                entry.console.shift();
            }
        };

        page.on("console", message => {
            const location = message.location();
            push({
                type: message.type(),
                text: message.text(),
                ...(location.url ? { location: `${location.url}:${location.lineNumber}` } : {}),
            });
        });

        page.on("pageerror", error => push({ type: "pageerror", text: error.stack ?? error.message }));
        page.on("requestfailed", request => push({
            type: "requestfailed",
            text: `${request.method()} ${request.url()} — ${request.failure()?.errorText ?? "failed"}`,
        }));
        page.on("response", response => {
            if (response.status() >= 400) {
                push({ type: "http", text: `${response.status()} ${response.request().method()} ${response.url()}` });
            }
        });

        this.sessions.set(sessionId, entry);
        return entry;
    }

    public async close(sessionId: string): Promise<boolean> {
        const entry = this.sessions.get(sessionId);

        if (!entry) {
            return false;
        }

        this.sessions.delete(sessionId);
        await entry.context.close().catch(() => undefined);
        return true;
    }

    public async closeAll(): Promise<void> {
        for (const id of [...this.sessions.keys()]) {
            await this.close(id);
        }

        if (this.browser) {
            const browser = await this.browser.catch(() => null);
            this.browser = null;
            await browser?.close().catch(() => undefined);
        }
    }

    private launch(): Promise<Browser> {
        this.browser ??= (async () => {
            const headless = this.options.headless ?? true;

            if (this.options.channel) {
                return chromium.launch({ channel: this.options.channel, headless });
            }

            try {
                return await chromium.launch({ headless });
            }
            catch (error) {
                // Нет скачанного Chromium — пробуем системный Edge (есть в каждой Windows).
                if (process.platform === "win32") {
                    return chromium.launch({ channel: "msedge", headless });
                }

                throw error;
            }
        })();

        this.browser.catch(() => {
            this.browser = null;
        });

        return this.browser;
    }
}

/**
 * Разрешены только локальные адреса: инструмент для проверки собственного dev-сервера.
 */
export function isLocalUrl(value: string): boolean {
    let url: URL;

    try {
        url = new URL(value);
    }
    catch {
        return false;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return false;
    }

    const host = url.hostname.toLowerCase();

    return host === "localhost" ||
        host.endsWith(".localhost") ||
        host === "127.0.0.1" ||
        host === "[::1]" ||
        host === "::1";
}
