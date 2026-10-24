import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Сценарий проверки приложения: его пишет планировщик (сильная модель), а мост выполняет механически,
 * без нейросети — вердикт получается достоверным. Формат — YAML или JSON:
 *
 *   start: python -m http.server 8080     # необязательно: иначе justai.app.json или встроенный сервер
 *   url: http://localhost:8080
 *   steps:
 *     - screenshot: { name: menu, width: 1280 }
 *     - click: '.mode-card[data-mode="hero"]'
 *     - expectText: { selector: '#game-kicker', contains: 'Раунд 1' }
 */

const selector = z.string().min(1);

const textCheck = z.object({
    selector,
    contains: z.string().optional(),
    equals: z.string().optional(),
    matches: z.string().optional(),
});

const STEP_SCHEMAS = {
    open: z.string().min(1),
    click: selector,
    type: z.object({ selector, text: z.string(), submit: z.boolean().optional() }),
    press: z.string().min(1),
    select: z.object({ selector, value: z.string() }),
    wait: z.number().int().min(0).max(30_000),
    waitFor: z.union([selector, z.object({ selector, timeout: z.number().int().min(100).max(60_000).optional() })]),
    expectText: textCheck,
    expectVisible: selector,
    expectHidden: selector,
    expectClass: z.object({ selector, has: z.string().optional(), any: z.array(z.string()).optional() }),
    expectCount: z.object({ selector, equals: z.number().int().optional(), min: z.number().int().optional(), max: z.number().int().optional() }),
    eval: z.union([z.string().min(1), z.object({ code: z.string().min(1), expect: z.unknown().optional() })]),
    screenshot: z.union([z.string().min(1), z.object({ name: z.string().min(1), width: z.number().int().min(320).max(2560).optional(), fullPage: z.boolean().optional() })]),
    viewport: z.object({ width: z.number().int().min(320).max(2560), height: z.number().int().min(320).max(2560).optional() }),
    expectNoConsoleErrors: z.union([z.boolean(), z.null()]),
    /** Настольная Windows-программа: запустить, дождаться окна с таким заголовком, снять только его, закрыть. */
    window: z.object({
        command: z.string().min(1),
        title: z.string().min(1),
        name: z.string().min(1).optional(),
        waitSec: z.number().int().min(1).max(120).optional(),
    }),
    run: z.union([z.string().min(1), z.object({
        command: z.string().min(1),
        expectExit: z.number().int().optional(),
        expectOutput: z.string().optional(),
        timeoutSec: z.number().int().min(1).max(600).optional(),
    })]),
} as const;

export type StepKind = keyof typeof STEP_SCHEMAS;

export type ScenarioStep = { [K in StepKind]: { kind: K; value: z.infer<(typeof STEP_SCHEMAS)[K]> } }[StepKind];

export interface Scenario {
    name?: string;
    start?: string;
    url?: string;
    /** Сколько ждать готовности приложения (с). */
    readyTimeoutSec?: number;
    /** Остановиться на первом упавшем шаге (по умолчанию да). */
    stopOnFailure: boolean;
    steps: ScenarioStep[];
}

const scenarioSchema = z.object({
    name: z.string().optional(),
    start: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    readyTimeoutSec: z.number().int().min(1).max(600).optional(),
    stopOnFailure: z.boolean().optional(),
    steps: z.array(z.record(z.string(), z.unknown())).min(1).max(200),
});

export class ScenarioError extends Error {}

/** Разобрать текст сценария (YAML или JSON). Ошибки — с номером шага, чтобы планировщик мог исправить. */
export function parseScenario(source: string): Scenario {
    let raw: unknown;

    try {
        raw = parseYaml(source);
    }
    catch (error) {
        throw new ScenarioError(`The scenario is not valid YAML/JSON: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }

    const parsed = scenarioSchema.safeParse(raw);

    if (!parsed.success) {
        throw new ScenarioError(`The scenario must have "steps" (a list): ${parsed.error.issues.map(issue => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`);
    }

    const steps = parsed.data.steps.map((step, index): ScenarioStep => {
        const entries = Object.entries(step);

        if (entries.length !== 1) {
            throw new ScenarioError(`Step ${index + 1}: each step must have exactly one action (for example "click: '#btn'"), got ${entries.map(([key]) => key).join(", ") || "nothing"}.`);
        }

        const [kind, value] = entries[0]!;

        if (!(kind in STEP_SCHEMAS)) {
            throw new ScenarioError(`Step ${index + 1}: unknown action "${kind}". Available: ${Object.keys(STEP_SCHEMAS).join(", ")}.`);
        }

        const schema = STEP_SCHEMAS[kind as StepKind] as z.ZodType;
        const checked = schema.safeParse(value);

        if (!checked.success) {
            throw new ScenarioError(`Step ${index + 1} (${kind}): ${checked.error.issues.map(issue => `${issue.path.join(".") || "value"} ${issue.message}`).join("; ")}.`);
        }

        return { kind, value: checked.data } as ScenarioStep;
    });

    return {
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.start ? { start: parsed.data.start } : {}),
        ...(parsed.data.url ? { url: parsed.data.url } : {}),
        ...(parsed.data.readyTimeoutSec ? { readyTimeoutSec: parsed.data.readyTimeoutSec } : {}),
        stopOnFailure: parsed.data.stopOnFailure ?? true,
        steps,
    };
}

/** Сценарий из текста issue или комментария: блок ```yaml … ``` (или ```json / ```e2e). */
export function scenarioBlock(body: string): string | null {
    const match = /```(?:ya?ml|json|e2e)?[ \t]*\r?\n([\s\S]*?)```/i.exec(body);
    return match && /\bsteps\s*:|"steps"\s*:/.test(match[1]!) ? match[1]! : null;
}

/** Короткое описание шага для отчёта. */
export function describeStep(step: ScenarioStep): string {
    const value = step.value as unknown;

    if (typeof value === "string" || typeof value === "number") {
        return `${step.kind} ${typeof value === "string" ? `\`${value}\`` : value}`;
    }

    if (value === null || value === true) {
        return step.kind;
    }

    const record = value as Record<string, unknown>;
    const main = record.selector ?? record.name ?? record.command ?? record.code ?? record.width;
    const extra = record.contains ?? record.equals ?? record.matches ?? record.text ?? record.value ?? record.has ?? (Array.isArray(record.any) ? record.any.join("|") : undefined);

    return `${step.kind} ${main !== undefined ? `\`${String(main)}\`` : ""}${extra !== undefined ? ` → "${String(extra)}"` : ""}`.trim();
}
