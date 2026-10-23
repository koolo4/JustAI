import { describe, expect, it } from "vitest";

import { FallbackProvider, isExhausted } from "../../../src/modules/agent/providers/FallbackProvider.js";
import { ModelOutputError, type ModelProvider, type ModelRequest, type ModelStreamEvent } from "../../../src/modules/agent/providers/ModelProvider.js";
import { ProviderRegistry } from "../../../src/modules/agent/providers/ProviderRegistry.js";

class HttpError extends Error {
    constructor(public readonly status: number, message: string) {
        super(message);
    }
}

/** Провайдер, который отвечает словом или падает с заданной ошибкой (до или после первого события). */
function fake(id: string, behaviour: { fail?: Error; failAfterText?: boolean } = {}): ModelProvider & { calls: number } {
    return {
        id,
        model: `${id}-model`,
        calls: 0,
        async *stream(): AsyncIterable<ModelStreamEvent> {
            this.calls++;

            if (behaviour.fail && behaviour.failAfterText) {
                yield { type: "text_delta", text: "partial" };
            }

            if (behaviour.fail) {
                throw behaviour.fail;
            }

            yield { type: "text_delta", text: id };
            yield {
                type: "done",
                turn: { content: [{ type: "text", text: id }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: `${id}-model` },
            };
        },
    };
}

const request = (): ModelRequest => ({ system: "", messages: [], tools: [], signal: new AbortController().signal });

async function answer(provider: ModelProvider): Promise<string> {
    let text = "";
    for await (const event of provider.stream(request())) {
        if (event.type === "text_delta") text += event.text;
    }
    return text;
}

describe("FallbackProvider", () => {
    it("hands the turn to the first reserve when the main provider is out of tokens", async () => {
        const switches: string[] = [];
        const provider = new FallbackProvider({
            primary: fake("groq", { fail: new HttpError(429, "Rate limit reached: tokens per day") }),
            reserves: [() => fake("reserve1"), () => fake("reserve2")],
            cooldownMs: 60_000,
            onSwitch: (from, to) => switches.push(`${from.id}->${to.id}`),
        });

        expect(await answer(provider)).toBe("reserve1");
        expect(provider.id).toBe("reserve1");
        expect(switches).toEqual(["groq->reserve1"]);
    });

    it("goes on to the second reserve and fails only when everyone is exhausted", async () => {
        const out = new HttpError(429, "quota exceeded");
        const provider = new FallbackProvider({
            primary: fake("groq", { fail: out }),
            reserves: [() => fake("reserve1", { fail: new HttpError(402, "insufficient credits") }), () => fake("reserve2")],
            cooldownMs: 60_000,
        });

        expect(await answer(provider)).toBe("reserve2");

        const allOut = new FallbackProvider({
            primary: fake("groq", { fail: out }),
            reserves: [() => fake("reserve1", { fail: out })],
            cooldownMs: 60_000,
        });

        await expect(answer(allOut)).rejects.toThrow("quota exceeded");
    });

    it("returns to the main provider after the cooldown", async () => {
        let now = 0;
        let failing = true;
        const primary = fake("groq");
        const stream = primary.stream.bind(primary);
        primary.stream = request => failing ? (async function* () { throw new HttpError(429, "limit"); })() : stream(request);

        const provider = new FallbackProvider({ primary, reserves: [() => fake("reserve1")], cooldownMs: 1000, now: () => now });

        expect(await answer(provider)).toBe("reserve1");
        failing = false;
        now = 500;
        expect(await answer(provider)).toBe("reserve1");
        now = 1500;
        expect(await answer(provider)).toBe("groq");
    });

    it("does not switch on bad requests or in the middle of an answer", async () => {
        const reserve = fake("reserve1");
        const badRequest = new FallbackProvider({
            primary: fake("groq", { fail: new HttpError(400, "invalid schema") }),
            reserves: [() => reserve],
            cooldownMs: 1000,
        });
        await expect(answer(badRequest)).rejects.toThrow("invalid schema");

        const midAnswer = new FallbackProvider({
            primary: fake("groq", { fail: new HttpError(429, "limit"), failAfterText: true }),
            reserves: [() => reserve],
            cooldownMs: 1000,
        });
        // Посреди ответа: ошибка формата (цикл агента повторит шаг), а повтор уже идёт к резерву.
        await expect(answer(midAnswer)).rejects.toBeInstanceOf(ModelOutputError);
        expect(reserve.calls).toBe(0);
        expect(await answer(midAnswer)).toBe("reserve1");
    });

    it("switches on timeouts and server failures too", async () => {
        const provider = new FallbackProvider({
            primary: fake("openrouter", { fail: new Error("Upstream idle timeout exceeded") }),
            reserves: [() => fake("reserve1")],
            cooldownMs: 1000,
        });

        expect(await answer(provider)).toBe("reserve1");
        expect(isExhausted(new HttpError(502, "Bad gateway"))).toBe(true);
        expect(isExhausted(new HttpError(504, "Gateway timeout"))).toBe(true);
        // Сервер недоступен (OpenAI SDK: APIConnectionError без статуса).
        expect(isExhausted(new Error("Connection error."))).toBe(true);
    });

    it("recognises exhausted-resource errors", () => {
        expect(isExhausted(new HttpError(413, "Request too large"))).toBe(true);
        expect(isExhausted(new HttpError(403, "You exceeded your current quota"))).toBe(true);
        expect(isExhausted(new HttpError(403, "Forbidden"))).toBe(false);
        expect(isExhausted(new HttpError(401, "Invalid API key"))).toBe(false);
        expect(isExhausted("rate limit")).toBe(false);
    });
});

describe("ProviderRegistry reserves", () => {
    it("ends every chain with the local model unless it is switched off", () => {
        const registry = new ProviderRegistry({ GROQ_API_KEY: "k" });

        expect(registry.lastResort()).toBe("ollama");
        expect(registry.create("groq")).toBeInstanceOf(FallbackProvider);
        // Сама локальная модель без облачных резервов не оборачивается.
        expect(registry.create("ollama")).not.toBeInstanceOf(FallbackProvider);

        const off = new ProviderRegistry({ GROQ_API_KEY: "k", JUSTAI_LAST_RESORT: "off" });
        expect(off.lastResort()).toBeNull();
        expect(off.create("groq")).not.toBeInstanceOf(FallbackProvider);

        // Не настроенный провайдер (LM Studio без модели) последним звеном не становится.
        expect(new ProviderRegistry({ JUSTAI_LAST_RESORT: "lmstudio" }).lastResort()).toBeNull();
    });

    it("wraps providers only when a reserve has an address and a model", () => {
        expect(new ProviderRegistry({ GROQ_API_KEY: "k", JUSTAI_LAST_RESORT: "off" }).create("groq")).not.toBeInstanceOf(FallbackProvider);

        const registry = new ProviderRegistry({
            JUSTAI_LAST_RESORT: "off",
            GROQ_API_KEY: "k",
            RESERVE1_BASE_URL: "https://example.invalid/v1",
            RESERVE1_MODEL: "some-model",
            RESERVE2_MODEL: "no-address",
        });

        expect(registry.configuredReserves()).toEqual(["reserve1"]);
        expect(registry.create("groq")).toBeInstanceOf(FallbackProvider);
        expect(registry.create("reserve1")).not.toBeInstanceOf(FallbackProvider);
        expect(registry.create("mock")).not.toBeInstanceOf(FallbackProvider);
        expect(registry.list().find(info => info.id === "reserve2")).toMatchObject({ configured: false });
    });
});
