import type { Page } from "playwright";

import { isLocalUrl, type BrowserService, type ConsoleEntry } from "../../../infrastructure/browser/BrowserService.js";
import type { ProcessManager } from "../../../infrastructure/process/ProcessManager.js";
import { describeStep, type Scenario, type ScenarioStep } from "./scenario.js";

const ACTION_TIMEOUT_MS = 10_000;
const EXPECT_TIMEOUT_MS = 5_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const PROBLEM_TYPES = ["error", "pageerror", "requestfailed", "http"];

/** Ошибки страницы и сети; запрос /favicon.ico браузер делает сам — его 404 не считается ошибкой сайта. */
function isProblem(entry: ConsoleEntry): boolean {
    return PROBLEM_TYPES.includes(entry.type) && !/\/favicon\.ico\b/i.test(`${entry.text} ${entry.location ?? ""}`);
}

export interface StepResult {
    index: number;
    label: string;
    ok: boolean;
    ms: number;
    detail?: string;
    error?: string;
}

export interface E2EScreenshot {
    name: string;
    width: number;
    dataBase64: string;
    /** Доля отличающихся пикселей от прошлого прогона (0…1); null — сравнивать не с чем. */
    diff: number | null;
}

export interface E2EResult {
    name?: string;
    url: string;
    passed: boolean;
    steps: StepResult[];
    screenshots: E2EScreenshot[];
    console: ConsoleEntry[];
    failure?: { screenshot?: string; html?: string };
    metrics?: { loadMs: number | null; requests: number; transferKb: number };
    totalMs: number;
}

export interface E2EOptions {
    browser: BrowserService;
    /** Адрес запущенного приложения. */
    baseUrl: string;
    /** Ключ страницы браузера (отдельно от страниц агента). */
    pageKey: string;
    /** Для шага run: процессы и папка проекта (рабочая копия ветки). */
    processes?: ProcessManager;
    cwd?: string;
    isDangerous?: (command: string) => Promise<string | null>;
    /** Прошлый скриншот с тем же именем (base64 PNG) — для сравнения. */
    previous?: (name: string, width: number) => Promise<string | null>;
}

/**
 * Механическое выполнение сценария в браузере: без модели, поэтому PASS/FAIL достоверны.
 * На первом упавшем шаге (если stopOnFailure) — скриншот и HTML страницы для разбора.
 */
export async function runScenario(scenario: Scenario, options: E2EOptions): Promise<E2EResult> {
    const started = Date.now();
    const { page, console: log } = await options.browser.page(options.pageKey);
    const steps: StepResult[] = [];
    const screenshots: E2EScreenshot[] = [];
    let failure: E2EResult["failure"];
    let metrics: E2EResult["metrics"];

    log.length = 0;
    await page.setViewportSize(DEFAULT_VIEWPORT);

    try {
        const opened = await timed(async () => {
            const response = await page.goto(options.baseUrl, { waitUntil: "load", timeout: 30_000 });
            await settle(page);
            return `HTTP ${response?.status() ?? "?"}, title "${await page.title()}"`;
        });
        steps.push({ index: 0, label: `open \`${options.baseUrl}\``, ...opened });
        metrics = await loadMetrics(page).catch(() => undefined);

        if (opened.ok) {
            for (const [index, step] of scenario.steps.entries()) {
                const result = await timed(() => runStep(step, page, log, screenshots, options));
                steps.push({ index: index + 1, label: describeStep(step), ...result });

                if (!result.ok && scenario.stopOnFailure) break;
            }
        }

        if (steps.some(step => !step.ok)) {
            failure = {
                screenshot: (await page.screenshot({ type: "png", timeout: ACTION_TIMEOUT_MS }).catch(() => null))?.toString("base64"),
                html: await page.evaluate(() => document.body?.innerHTML.replace(/\s+/g, " ").trim().slice(0, 3_000) ?? "").catch(() => undefined),
            };
        }

        for (const shot of screenshots) {
            const before = await options.previous?.(shot.name, shot.width).catch(() => null);
            shot.diff = before ? await imageDiff(page, before, shot.dataBase64).catch(() => null) : null;
        }
    }
    finally {
        await options.browser.close(options.pageKey);
    }

    return {
        ...(scenario.name ? { name: scenario.name } : {}),
        url: options.baseUrl,
        passed: steps.every(step => step.ok),
        steps,
        screenshots,
        console: [...log],
        ...(failure ? { failure } : {}),
        ...(metrics ? { metrics } : {}),
        totalMs: Date.now() - started,
    };
}

async function runStep(step: ScenarioStep, page: Page, log: ConsoleEntry[], screenshots: E2EScreenshot[], options: E2EOptions): Promise<string | undefined> {
    switch (step.kind) {
        case "open": {
            const url = new URL(step.value, options.baseUrl).toString();
            if (!isLocalUrl(url)) throw new Error(`only local addresses: ${url}`);
            const response = await page.goto(url, { waitUntil: "load", timeout: 30_000 });
            await settle(page);
            return `HTTP ${response?.status() ?? "?"}`;
        }

        case "click":
            await page.locator(step.value).first().click({ timeout: ACTION_TIMEOUT_MS });
            await settle(page);
            return undefined;

        case "type": {
            const field = page.locator(step.value.selector).first();
            await field.fill(step.value.text, { timeout: ACTION_TIMEOUT_MS });
            if (step.value.submit) await field.press("Enter");
            await settle(page);
            return undefined;
        }

        case "press":
            await page.keyboard.press(step.value);
            await settle(page);
            return undefined;

        case "select":
            await page.locator(step.value.selector).first().selectOption(step.value.value, { timeout: ACTION_TIMEOUT_MS });
            return undefined;

        case "wait":
            await page.waitForTimeout(step.value);
            return undefined;

        case "waitFor": {
            const { selector, timeout } = typeof step.value === "string" ? { selector: step.value, timeout: ACTION_TIMEOUT_MS } : step.value;
            await page.locator(selector).first().waitFor({ state: "visible", timeout: timeout ?? ACTION_TIMEOUT_MS });
            return undefined;
        }

        case "expectText": {
            const { selector, contains, equals, matches } = step.value;
            const locator = page.locator(selector).first();
            await locator.waitFor({ state: "attached", timeout: EXPECT_TIMEOUT_MS });
            // Текст страницы (textContent), а не отображаемый: CSS text-transform: uppercase не должен ронять проверку.
            // Отображаемый (innerText) тоже принимается — на случай текста из ::before или скрытых узлов.
            const source = (await locator.textContent({ timeout: EXPECT_TIMEOUT_MS }) ?? "").replace(/\s+/g, " ").trim();
            const shown = (await locator.innerText({ timeout: EXPECT_TIMEOUT_MS }).catch(() => source)).replace(/\s+/g, " ").trim();
            const fits = (actual: string) => (contains === undefined || actual.includes(contains))
                && (equals === undefined || actual === equals)
                && (matches === undefined || new RegExp(matches).test(actual));

            if (!fits(source) && !fits(shown)) throw new Error(`text is "${clip(source, 200)}"`);
            return `"${clip(source, 80)}"`;
        }

        case "expectVisible":
            await page.locator(step.value).first().waitFor({ state: "visible", timeout: EXPECT_TIMEOUT_MS })
                .catch(() => { throw new Error(`${step.value} is not visible`); });
            return undefined;

        case "expectHidden":
            await page.locator(step.value).first().waitFor({ state: "hidden", timeout: EXPECT_TIMEOUT_MS })
                .catch(() => { throw new Error(`${step.value} is still visible`); });
            return undefined;

        case "expectClass": {
            const { selector, has, any } = step.value;
            const classes = await page.locator(selector).evaluateAll(nodes => nodes.map(node => [...node.classList]));

            if (classes.length === 0) throw new Error(`no element matches ${selector}`);
            if (has && !classes[0]!.includes(has)) throw new Error(`first element has classes "${classes[0]!.join(" ")}"`);
            if (any && !classes.some(list => list.some(name => any.includes(name)))) throw new Error(`no element has any of ${any.join(", ")}`);
            return `${classes.length} element(s)`;
        }

        case "expectCount": {
            const { selector, equals, min, max } = step.value;
            const count = await page.locator(selector).count();

            if ((equals !== undefined && count !== equals) || (min !== undefined && count < min) || (max !== undefined && count > max)) {
                throw new Error(`found ${count}`);
            }

            return `${count}`;
        }

        case "eval": {
            const { code, expect } = typeof step.value === "string" ? { code: step.value, expect: undefined } : step.value;
            const value = await page.evaluate(async (source: string) => {
                // eslint-disable-next-line no-eval
                const result: unknown = await (0, eval)(source);
                return result === undefined ? null : JSON.parse(JSON.stringify(result) ?? "null") as unknown;
            }, code);
            await settle(page);

            const text = JSON.stringify(value);
            if (expect !== undefined && text !== JSON.stringify(expect)) throw new Error(`returned ${clip(text, 200)}, expected ${JSON.stringify(expect)}`);
            return clip(text, 120);
        }

        case "screenshot": {
            const { name, width, fullPage } = typeof step.value === "string" ? { name: step.value, width: undefined, fullPage: false } : step.value;
            const before = page.viewportSize() ?? DEFAULT_VIEWPORT;

            if (width) {
                await page.setViewportSize({ width, height: width < 768 ? 812 : before.height });
                await page.waitForTimeout(200);
            }

            const image = await page.screenshot({ type: "png", fullPage: fullPage ?? false, timeout: ACTION_TIMEOUT_MS });
            const shotWidth = page.viewportSize()?.width ?? before.width;
            if (width) await page.setViewportSize(before);

            screenshots.push({ name, width: shotWidth, dataBase64: image.toString("base64"), diff: null });
            return `${shotWidth}px`;
        }

        case "viewport":
            await page.setViewportSize({ width: step.value.width, height: step.value.height ?? (step.value.width < 768 ? 812 : 800) });
            return undefined;

        case "expectNoConsoleErrors": {
            const problems = log.filter(isProblem);
            if (problems.length) throw new Error(problems.slice(0, 5).map(entry => `[${entry.type}] ${clip(entry.text, 200)}`).join("; "));
            return "clean";
        }

        case "run": {
            if (!options.processes || !options.cwd) throw new Error("commands are not available here");

            const { command, expectExit, expectOutput, timeoutSec } = typeof step.value === "string"
                ? { command: step.value, expectExit: undefined, expectOutput: undefined, timeoutSec: undefined }
                : step.value;
            const refused = await options.isDangerous?.(command);
            if (refused) throw new Error(`refused: ${refused}`);

            const result = await options.processes.run(command, { cwd: options.cwd, owner: "github-e2e", timeoutMs: (timeoutSec ?? 120) * 1000 });
            const exit = result.info.exitCode;

            if (result.info.status === "timed_out") throw new Error(`timed out after ${timeoutSec ?? 120} s`);
            if (exit !== (expectExit ?? 0)) throw new Error(`exit code ${exit}: ${clip(result.output.trim().split("\n").slice(-3).join(" | "), 300)}`);
            if (expectOutput !== undefined && !result.output.includes(expectOutput)) throw new Error(`output does not contain "${expectOutput}": ${clip(result.output.trim(), 300)}`);
            return `exit ${exit}`;
        }
    }
}

async function timed(action: () => Promise<string | undefined>): Promise<{ ok: boolean; ms: number; detail?: string; error?: string }> {
    const started = Date.now();

    try {
        const detail = await action();
        return { ok: true, ms: Date.now() - started, ...(detail ? { detail } : {}) };
    }
    catch (error) {
        return { ok: false, ms: Date.now() - started, error: clip((error instanceof Error ? error.message : String(error)).split("\n")[0]!, 300) };
    }
}

async function settle(page: Page): Promise<void> {
    await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => undefined);
}

async function loadMetrics(page: Page): Promise<NonNullable<E2EResult["metrics"]>> {
    return page.evaluate(() => {
        const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
        const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
        const bytes = (navigation?.transferSize ?? 0) + resources.reduce((sum, item) => sum + (item.transferSize || 0), 0);

        return {
            loadMs: navigation && navigation.loadEventEnd > 0 ? Math.round(navigation.loadEventEnd - navigation.startTime) : null,
            requests: resources.length + 1,
            transferKb: Math.round(bytes / 1024),
        };
    });
}

/** Доля различающихся пикселей двух PNG — считается в самом браузере (canvas), без библиотек. */
async function imageDiff(page: Page, before: string, after: string): Promise<number> {
    const scratch = await page.context().newPage();

    try {
        return await scratch.evaluate(async ([a, b]) => {
            const load = (data: string) => new Promise<HTMLImageElement>((resolve, reject) => {
                const image = new Image();
                image.onload = () => resolve(image);
                image.onerror = reject;
                image.src = `data:image/png;base64,${data}`;
            });
            const [first, second] = await Promise.all([load(a), load(b)]);

            if (first.width !== second.width || first.height !== second.height) return 1;

            const pixels = (image: HTMLImageElement) => {
                const canvas = document.createElement("canvas");
                canvas.width = image.width;
                canvas.height = image.height;
                const context = canvas.getContext("2d")!;
                context.drawImage(image, 0, 0);
                return context.getImageData(0, 0, image.width, image.height).data;
            };
            const x = pixels(first);
            const y = pixels(second);
            let changed = 0;

            for (let i = 0; i < x.length; i += 4) {
                if (Math.abs(x[i]! - y[i]!) + Math.abs(x[i + 1]! - y[i + 1]!) + Math.abs(x[i + 2]! - y[i + 2]!) > 30) changed += 1;
            }

            return changed / (x.length / 4);
        }, [before, after] as const);
    }
    finally {
        await scratch.close().catch(() => undefined);
    }
}

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Отчёт для issue: вердикт, шаги, метрики, консоль, разбор падения. Скриншоты добавляет мост (ссылки). */
export function e2eReport(result: E2EResult, where: string, screenshotLinks: string[], failureLink?: string): string {
    const failed = result.steps.find(step => !step.ok);
    const problems = result.console.filter(isProblem);
    const lines = [
        `🧪 **JustAI e2e**${result.name ? ` «${result.name}»` : ""}: ${result.passed ? "✅ PASS" : "❌ FAIL"} — ${result.steps.filter(step => step.ok).length}/${result.steps.length} шагов за ${(result.totalMs / 1000).toFixed(1)} с`,
        `Где: ${where}. Выполнено механически (без модели).`,
        "",
        "| # | Шаг | Итог | мс |",
        "|---|---|---|---|",
        ...result.steps.map(step => `| ${step.index} | ${escapeCell(step.label)} | ${step.ok ? `✓${step.detail ? ` ${escapeCell(step.detail)}` : ""}` : `✕ ${escapeCell(step.error ?? "")}`} | ${step.ms} |`),
    ];

    if (failed && result.steps.indexOf(failed) < result.steps.length - 1) {
        lines.push("", `_Остальные шаги после падения не выполнялись._`);
    }

    if (result.metrics) {
        lines.push("", `**Загрузка:** ${result.metrics.loadMs !== null ? `${result.metrics.loadMs} мс` : "—"}, запросов ${result.metrics.requests}, ${result.metrics.transferKb} КБ.`);
    }

    lines.push("", problems.length
        ? `**Консоль и сеть (${problems.length}):**\n${problems.slice(0, 10).map(entry => `- [${entry.type}] ${escapeCell(clip(entry.text, 200))}`).join("\n")}`
        : "**Консоль и сеть:** без ошибок.");

    const changed = result.screenshots.filter(shot => shot.diff !== null && shot.diff > 0.01);

    if (result.screenshots.some(shot => shot.diff !== null)) {
        lines.push("", changed.length
            ? `**Изменения внешнего вида с прошлого прогона:** ${changed.map(shot => `${shot.name} (${shot.width}px) — ${(shot.diff! * 100).toFixed(1)}% пикселей`).join(", ")}`
            : "**Внешний вид:** совпадает с прошлым прогоном.");
    }

    if (screenshotLinks.length) lines.push("", "**Скриншоты:**", ...screenshotLinks);

    if (failed) {
        lines.push("", `**Падение на шаге ${failed.index}:** ${failed.label} — ${failed.error ?? ""}`);
        if (failureLink) lines.push(`![экран в момент падения](${failureLink})`);
        if (result.failure?.html) lines.push("<details><summary>HTML страницы в момент падения</summary>", "", "```html", result.failure.html, "```", "", "</details>");
    }

    return lines.join("\n");
}

function escapeCell(text: string): string {
    return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
