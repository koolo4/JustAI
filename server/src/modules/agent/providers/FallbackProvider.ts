import { ModelOutputError, type ModelProvider, type ModelRequest, type ModelStreamEvent } from "./ModelProvider.js";

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
                const next = this.active + 1;

                if (request.signal.aborted || !isExhausted(error) || next >= this.chain.length) {
                    throw error;
                }

                const from = this.current;
                const reason = error instanceof Error ? error.message : String(error);
                this.chain[this.active]!.blockedUntil = this.now() + this.options.cooldownMs;

                // Посреди ответа продолжить у другого провайдера нельзя (часть текста уже показана):
                // провайдер помечен недоступным, а цикл агента повторит шаг — уже у следующего.
                if (emitted) {
                    this.options.onSwitch?.(from, this.provider(next), reason);
                    throw new ModelOutputError(`The provider dropped the response (${reason}); retrying with the next provider.`, { cause: error });
                }

                this.active = next;
                this.options.onSwitch?.(from, this.current, reason);
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

/** Лимиты (402, 413, 429) и недоступность сервера: тайм-аут (408, 504), сбой (500, 502, 503, 529). */
const EXHAUSTED_STATUS = new Set([402, 408, 413, 429, 500, 502, 503, 504, 529]);
const EXHAUSTED_TEXT = /quota|rate.?limit|insufficient|credit|tokens per (minute|day)|requests per|overloaded|too many requests|time.?out|timed out|upstream|unavailable|bad gateway|econnreset|econnrefused|socket hang up|could not read the model stream/i;

/** Ошибка означает «этот провайдер сейчас не может ответить» (лимит, сбой, тайм-аут), а не «запрос плохой». */
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
