import path from "node:path";
import fs from "node:fs/promises";

import { chromium, type BrowserContext, type Page } from "playwright";

export type CouncilProviderId = "chatgpt" | "claude" | "deepseek";

export interface CouncilRole {
    provider: CouncilProviderId;
    role: "architect" | "critic" | "implementer" | "researcher" | "chair";
}

export interface CouncilProviderStatus {
    id: CouncilProviderId;
    label: string;
    url: string;
    connected: boolean;
    open: boolean;
    message?: string;
}

export interface CouncilRunRequest {
    prompt: string;
    providers: CouncilProviderId[];
    chair: CouncilProviderId;
    roles?: Partial<Record<CouncilProviderId, CouncilRole["role"]>>;
    projectContext?: string;
    activeFile?: string;
    activeContent?: string;
}

export interface CouncilOpinion {
    provider: CouncilProviderId;
    role: string;
    answer: string;
    durationMs: number;
}

export interface CouncilRunResponse {
    opinions: CouncilOpinion[];
    chair: CouncilOpinion;
    executionPolicy: string;
}

interface ProviderDefinition {
    id: CouncilProviderId;
    label: string;
    url: string;
    loginMarkers: string[];
    composerSelectors: string[];
    assistantSelectors: string[];
    sendSelectors: string[];
}

const PROVIDERS: ProviderDefinition[] = [
    {
        id: "chatgpt",
        label: "ChatGPT",
        url: "https://chatgpt.com/",
        loginMarkers: ["Log in", "Sign up"],
        composerSelectors: [
            "textarea[placeholder*='Message']",
            "textarea[placeholder*='message']",
            "[contenteditable='true'][data-lexical-editor='true']",
            "[contenteditable='true']",
        ],
        assistantSelectors: [
            "[data-message-author-role='assistant']",
            "article[data-testid^='conversation-turn'] [data-message-author-role='assistant']",
        ],
        sendSelectors: [
            "button[data-testid='send-button']",
            "button[aria-label*='Send']",
            "button[aria-label*='send']",
        ],
    },
    {
        id: "claude",
        label: "Claude",
        url: "https://claude.ai/new",
        loginMarkers: ["Log in", "Sign up"],
        composerSelectors: [
            "div[contenteditable='true']",
            "textarea[placeholder*='Reply']",
            "textarea",
        ],
        assistantSelectors: [
            "[data-testid='assistant-message']",
            "div.font-claude-message",
            "div[class*='font-claude']",
        ],
        sendSelectors: [
            "button[aria-label*='Send']",
            "button[aria-label*='send']",
            "button[type='submit']",
        ],
    },
    {
        id: "deepseek",
        label: "DeepSeek",
        url: "https://chat.deepseek.com/",
        loginMarkers: ["Log in", "Sign up", "登录", "注册"],
        composerSelectors: [
            "textarea",
            "div[contenteditable='true']",
        ],
        assistantSelectors: [
            ".ds-markdown",
            "div[class*='ds-markdown']",
            "[class*='assistant']",
        ],
        sendSelectors: [
            "button[aria-label*='Send']",
            "button[aria-label*='send']",
            "button[type='submit']",
        ],
    },
];

export class BrowserCouncilService {
    private readonly contexts = new Map<CouncilProviderId, BrowserContext>();

    constructor(private readonly workspaceRoot: string) {}

    private definition(id: CouncilProviderId): ProviderDefinition {
        const definition = PROVIDERS.find(item => item.id === id);
        if (!definition) {
            throw new Error(`Unknown browser council provider: ${id}`);
        }
        return definition;
    }

    private profileRoot(id: CouncilProviderId): string {
        return path.join(
            this.workspaceRoot,
            ".justai",
            "browser-profiles",
            id,
        );
    }

    private async contextFor(id: CouncilProviderId): Promise<BrowserContext> {
        const existing = this.contexts.get(id);
        if (existing) {
            return existing;
        }

        await fs.mkdir(this.profileRoot(id), { recursive: true });

        const context = await chromium.launchPersistentContext(
            this.profileRoot(id),
            {
                headless: false,
                viewport: null,
                channel: process.env.JUSTAI_BROWSER_CHANNEL || undefined,
                args: ["--start-maximized"],
            },
        );

        context.on("close", () => {
            this.contexts.delete(id);
        });

        this.contexts.set(id, context);
        return context;
    }

    private async pageFor(id: CouncilProviderId): Promise<Page> {
        const context = await this.contextFor(id);
        const pages = context.pages();
        const page = pages[0] ?? await context.newPage();

        if (!page.url().startsWith(this.definition(id).url)) {
            await page.goto(this.definition(id).url, { waitUntil: "domcontentloaded", timeout: 60000 });
        }

        return page;
    }

    private async firstVisible(page: Page, selectors: string[]) {
        for (const selector of selectors) {
            const locator = page.locator(selector).filter({ visible: true }).first();
            if (await locator.count().catch(() => 0)) {
                return locator;
            }
        }
        return null;
    }

    private async isLoggedIn(page: Page, definition: ProviderDefinition): Promise<boolean> {
        const composer = await this.firstVisible(page, definition.composerSelectors);
        if (!composer) {
            return false;
        }

        const bodyText = (await page.locator("body").innerText().catch(() => "")).slice(0, 12000);
        return !definition.loginMarkers.some(marker => bodyText.includes(marker)) || Boolean(composer);
    }

    public async status(): Promise<CouncilProviderStatus[]> {
        const result: CouncilProviderStatus[] = [];

        for (const definition of PROVIDERS) {
            try {
                const context = this.contexts.get(definition.id);
                if (!context) {
                    result.push({
                        id: definition.id,
                        label: definition.label,
                        url: definition.url,
                        connected: false,
                        open: false,
                        message: "Browser not started. Click Connect to open a persistent browser profile.",
                    });
                    continue;
                }

                const page = await this.pageFor(definition.id);
                result.push({
                    id: definition.id,
                    label: definition.label,
                    url: definition.url,
                    connected: await this.isLoggedIn(page, definition),
                    open: true,
                });
            } catch (error) {
                result.push({
                    id: definition.id,
                    label: definition.label,
                    url: definition.url,
                    connected: false,
                    open: false,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }

        return result;
    }

    public async connect(id: CouncilProviderId): Promise<CouncilProviderStatus> {
        const definition = this.definition(id);
        const page = await this.pageFor(id);
        await page.bringToFront();

        return {
            id,
            label: definition.label,
            url: definition.url,
            connected: await this.isLoggedIn(page, definition),
            open: true,
            message: "If you are not signed in, sign in in this browser window. The session is stored only in the local JustAI browser profile.",
        };
    }

    private async send(page: Page, definition: ProviderDefinition, prompt: string): Promise<string> {
        const composer = await this.firstVisible(page, definition.composerSelectors);
        if (!composer) {
            throw new Error(`${definition.label}: chat input was not found. The site may require you to sign in first or its UI may have changed.`);
        }

        const before = await this.responseTexts(page, definition);

        await composer.click();
        await composer.fill(prompt);

        const sendButton = await this.firstVisible(page, definition.sendSelectors);
        if (sendButton) {
            await sendButton.click();
        } else {
            await composer.press("Enter");
        }

        const deadline = Date.now() + Number(process.env.JUSTAI_COUNCIL_TIMEOUT_MS ?? 120000);
        let last = "";
        let stableSince = 0;

        while (Date.now() < deadline) {
            await page.waitForTimeout(1200);
            const current = await this.responseTexts(page, definition);
            const candidate = current[current.length - 1] ?? "";

            if (candidate && (!before.includes(candidate) || current.length > before.length)) {
                if (candidate !== last) {
                    last = candidate;
                    stableSince = Date.now();
                } else if (Date.now() - stableSince > 2200) {
                    return candidate.trim();
                }
            }
        }

        if (last) {
            return last.trim();
        }

        throw new Error(`${definition.label}: timed out waiting for the AI response.`);
    }

    private async responseTexts(page: Page, definition: ProviderDefinition): Promise<string[]> {
        for (const selector of definition.assistantSelectors) {
            const locator = page.locator(selector);
            const count = await locator.count().catch(() => 0);
            if (count > 0) {
                const values = await locator.allInnerTexts().catch(() => []);
                const cleaned = values.map(value => value.trim()).filter(Boolean);
                if (cleaned.length) {
                    return cleaned;
                }
            }
        }
        return [];
    }

    private rolePrompt(role: string, provider: CouncilProviderId): string {
        const roleText: Record<string, string> = {
            architect: "Ты архитектор проекта. Определи правильную архитектуру, зависимости, риски и порядок изменений.",
            critic: "Ты независимый критик. Ищи ошибки, противоречия, скрытые риски, регрессии и плохие предположения в решении.",
            implementer: "Ты ведущий разработчик. Предложи конкретный технический план реализации, включая файлы, интерфейсы, тесты и безопасный способ внесения изменений.",
            researcher: "Ты исследователь. Проверь факты, актуальные ограничения инструментов и предложи наиболее надёжный путь.",
            chair: "Ты председатель совета. Сведи мнения в одно решение, разреши противоречия и выдай план, который JustAI сможет выполнить локальными инструментами.",
        };

        return [
            `Ты работаешь в JustAI как роль: ${role}.`,
            roleText[role] ?? roleText.researcher,
            `Твой провайдер: ${provider}. Не притворяйся, что ты можешь напрямую менять локальные файлы. Ты даёшь совет председателю.`,
            "Отвечай структурированно и конкретно. Не проси пользователя пересылать пароль, cookie или токены.",
        ].join("\n");
    }

    private buildAdvisorPrompt(request: CouncilRunRequest, role: string): string {
        return [
            this.rolePrompt(role, "advisor" as CouncilProviderId),
            "",
            "===== USER TASK =====",
            request.prompt,
            "",
            "===== PROJECT CONTEXT =====",
            request.projectContext ?? "No project tree supplied.",
            "",
            "===== ACTIVE FILE =====",
            request.activeFile ?? "",
            request.activeContent ?? "",
            "",
            "Сначала дай самостоятельное мнение. Не соглашайся автоматически с другими участниками, которых ты ещё не видел.",
        ].join("\n");
    }

    private buildChairPrompt(request: CouncilRunRequest, opinions: CouncilOpinion[]): string {
        return [
            this.rolePrompt("chair", request.chair),
            "",
            "===== USER TASK =====",
            request.prompt,
            "",
            "===== PROJECT CONTEXT =====",
            request.projectContext ?? "No project tree supplied.",
            "",
            "===== COUNCIL OPINIONS =====",
            ...opinions.map((opinion, index) => [
                `--- ADVISOR ${index + 1}: ${opinion.provider} / ${opinion.role} ---`,
                opinion.answer,
            ].join("\n")),
            "",
            "===== CHAIR OUTPUT FORMAT =====",
            "1. Decision",
            "2. Why this decision wins over alternatives",
            "3. Exact implementation plan",
            "4. Files likely to change",
            "5. Tests/checks required",
            "6. Risks and rollback plan",
            "7. EXECUTION: write YES only if the plan is safe for JustAI to execute after explicit user approval; otherwise write NO.",
            "",
            "Do not claim that you changed local files. You are advising the local JustAI agent.",
        ].join("\n");
    }

    public async run(request: CouncilRunRequest): Promise<CouncilRunResponse> {
        if (!request.prompt?.trim()) {
            throw new Error("Council prompt is required.");
        }

        const uniqueProviders = [...new Set(request.providers)].filter(Boolean);
        if (!uniqueProviders.length) {
            throw new Error("Select at least one AI council provider.");
        }
        if (!uniqueProviders.includes(request.chair)) {
            throw new Error("The chair must be one of the selected council providers.");
        }

        const opinions: CouncilOpinion[] = [];

        for (const provider of uniqueProviders) {
            const definition = this.definition(provider);
            const page = await this.pageFor(provider);
            await page.bringToFront();

            if (!(await this.isLoggedIn(page, definition))) {
                throw new Error(`${definition.label} is not signed in. Click Connect and sign in once in the opened browser window.`);
            }

            const role = request.roles?.[provider] ?? (provider === request.chair ? "architect" : "researcher");
            const started = Date.now();
            const answer = await this.send(page, definition, this.buildAdvisorPrompt(request, role));

            opinions.push({
                provider,
                role,
                answer,
                durationMs: Date.now() - started,
            });
        }

        const chairDefinition = this.definition(request.chair);
        const chairPage = await this.pageFor(request.chair);
        await chairPage.bringToFront();

        if (!(await this.isLoggedIn(chairPage, chairDefinition))) {
            throw new Error(`${chairDefinition.label} is not signed in.`);
        }

        const started = Date.now();
        const chairAnswer = await this.send(
            chairPage,
            chairDefinition,
            this.buildChairPrompt(request, opinions),
        );

        const chair: CouncilOpinion = {
            provider: request.chair,
            role: "chair",
            answer: chairAnswer,
            durationMs: Date.now() - started,
        };

        return {
            opinions,
            chair,
            executionPolicy: "Browser council only advises. JustAI never applies file changes from an external browser response without an explicit execution step in the local agent.",
        };
    }

    public async close(): Promise<void> {
        for (const context of this.contexts.values()) {
            await context.close().catch(() => undefined);
        }
        this.contexts.clear();
    }
}
