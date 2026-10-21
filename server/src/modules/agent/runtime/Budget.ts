import { addUsage, emptyUsage, type Usage } from "@justai/shared";

export interface BudgetLimits {
    /** Максимум обращений к модели за один запуск цикла. */
    maxSteps: number;
    /** Максимум сгенерированных моделью токенов за запуск. */
    maxOutputTokens: number;
    /** Максимум времени работы за запуск. */
    maxWallTimeMs: number;
}

export const DEFAULT_BUDGET: BudgetLimits = {
    maxSteps: 100,
    maxOutputTokens: 1_000_000,
    maxWallTimeMs: 60 * 60 * 1000,
};

export function budgetFromEnv(env: NodeJS.ProcessEnv = process.env): BudgetLimits {
    return {
        maxSteps: positive(env.JUSTAI_MAX_AGENT_STEPS, DEFAULT_BUDGET.maxSteps),
        maxOutputTokens: positive(env.JUSTAI_MAX_OUTPUT_TOKENS, DEFAULT_BUDGET.maxOutputTokens),
        maxWallTimeMs: positive(env.JUSTAI_MAX_WALL_TIME_MS, DEFAULT_BUDGET.maxWallTimeMs),
    };
}

export class Budget {

    private stepsUsed = 0;

    private usageTotal: Usage = emptyUsage();

    private readonly startedAt: number;

    constructor(
        private readonly limits: BudgetLimits,
        private readonly now: () => number = Date.now,
    ) {
        this.startedAt = now();
    }

    public record(usage: Usage): void {
        this.stepsUsed += 1;
        this.usageTotal = addUsage(this.usageTotal, usage);
    }

    public get steps(): number {
        return this.stepsUsed;
    }

    public get usage(): Usage {
        return this.usageTotal;
    }

    /**
     * Причина, по которой продолжать нельзя, или null.
     */
    public exceededReason(): string | null {
        if (this.stepsUsed >= this.limits.maxSteps) {
            return `step limit reached (${this.limits.maxSteps})`;
        }

        if (this.usageTotal.outputTokens >= this.limits.maxOutputTokens) {
            return `output token limit reached (${this.limits.maxOutputTokens})`;
        }

        if (this.now() - this.startedAt >= this.limits.maxWallTimeMs) {
            return `time limit reached (${Math.round(this.limits.maxWallTimeMs / 60000)} min)`;
        }

        return null;
    }
}

function positive(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
