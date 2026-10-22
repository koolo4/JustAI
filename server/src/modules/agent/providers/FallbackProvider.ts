import type { ModelProvider, ModelRequest, ModelStreamEvent } from "./ModelProvider.js";

export interface FallbackOptions {
    primary: ModelProvider;
    /** Резервы по порядку. Создаются лениво: пока главный справляется, резервы не нужны. */
    reserves: Array<() => ModelProvider>;
    /** Через сколько миллисекунд снова пробовать главного после переключения. */
    cooldownMs: number;
    now?: () => number;
    onSwitch?: (from: ModelProvider, to: ModelProvider, reason: string) => void;
}

/**
 * Главный провайдер с резервными «экспертами»: если у главного кончились токены или лимит запросов,
 * ход уходит первому резерву, затем второму. После паузы снова пробуем главного.
 */
export class FallbackProvider implements ModelProvider {

    private readonly chain: Array<{ create: () => ModelProvider; instance?: ModelProvider; blockedUntil: number }>;
    private active = 0;
    private readonly now: () => number;

    constructor(private readonly options: FallbackOptions) {
        this.now = options.now ?? Date.now;
        this.chain = [
            { create: () => options.primary, instance: options.primary, blockedUntil: 0 },
            ...options.reserves.map(create => ({ create, blockedUntil: 0 })),
        ];
    }

    public get id(): string {
        return this.current.id;
    }

    public get model(): string {
        return this.current.model;
    }

    public get contextWindow(): ModelProvider["contextWindow"] {
        return this.current.contextWindow;
    }

    public get smallModelGuards(): boolean | undefined {
        return this.current.smallModelGuards;
    }

    private get current(): ModelProvider {
        return this.provider(this.active);
    }

    private provider(index: number): ModelProvider {
        const link = this.chain[index]!;
        link.instance ??= link.create();
        return link.instance;
    }

    public async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
        this.active = this.firstAvailable();

        for (;;) {
            let emitted = false;

            try {
                for await (const event of this.provider(this.active).stream(request)) {
                    emitted = true;
                    yield event;
                }
                return;
            } catch (error) {
                // Посреди ответа переключаться нельзя: часть текста уже показана.
                const next = this.active + 1;

                if (emitted || request.signal.aborted || !isExhausted(error) || next >= this.chain.length) {
                    throw error;
                }

                const from = this.current;
                this.chain[this.active]!.blockedUntil = this.now() + this.options.cooldownMs;
                this.active = next;
                this.options.onSwitch?.(from, this.current, error instanceof Error ? error.message : String(error));
            }
        }
    }

    /** Первый в цепочке, у кого не идёт пауза; если пауза у всех — последний. */
    private firstAvailable(): number {
        const now = this.now();
        const index = this.chain.findIndex(link => link.blockedUntil <= now);
        return index === -1 ? this.chain.length - 1 : index;
    }
}

const EXHAUSTED_STATUS = new Set([402, 413, 429, 503, 529]);
const EXHAUSTED_TEXT = /quota|rate.?limit|insufficient|credit|tokens per (minute|day)|requests per|overloaded|too many requests/i;

/** Ошибка означает «у этого провайдера сейчас нет ресурса», а не «запрос плохой». */
export function isExhausted(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    const status = (error as { status?: unknown }).status;

    if (typeof status === "number") {
        return EXHAUSTED_STATUS.has(status) || (status === 403 && EXHAUSTED_TEXT.test(error.message));
    }

    return EXHAUSTED_TEXT.test(error.message);
}
