import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SettingsStore } from "../../src/app/SettingsStore.js";
import { createTempWorkspace, type TempWorkspace } from "../helpers/tempWorkspace.js";

describe("SettingsStore", () => {
    let install: TempWorkspace;

    beforeEach(async () => {
        install = await createTempWorkspace();
    });

    afterEach(async () => {
        await install.dispose();
    });

    const field = (store: SettingsStore, key: string) => store.view().fields.find(item => item.key === key)!;

    it("overrides .env values, survives a restart and falls back to .env when cleared", () => {
        const env: NodeJS.ProcessEnv = { GROQ_MODEL: "from-env" };
        const store = new SettingsStore(install.root, env);
        store.apply();

        expect(field(store, "GROQ_MODEL")).toMatchObject({ value: "from-env", source: "env" });

        store.update({ GROQ_MODEL: "  from-ui  ", RESERVE1_BASE_URL: "https://example.invalid/v1" });
        expect(env.GROQ_MODEL).toBe("from-ui");
        expect(env.RESERVE1_BASE_URL).toBe("https://example.invalid/v1");

        const restartedEnv: NodeJS.ProcessEnv = { GROQ_MODEL: "from-env" };
        const restarted = new SettingsStore(install.root, restartedEnv);
        restarted.apply();
        expect(restartedEnv.GROQ_MODEL).toBe("from-ui");
        expect(field(restarted, "GROQ_MODEL").source).toBe("ui");

        restarted.update({ GROQ_MODEL: null, RESERVE1_BASE_URL: null });
        expect(restartedEnv.GROQ_MODEL).toBe("from-env");
        expect(restartedEnv.RESERVE1_BASE_URL).toBeUndefined();
    });

    it("never returns secrets in full", () => {
        const env: NodeJS.ProcessEnv = {};
        const store = new SettingsStore(install.root, env);
        store.update({ GROQ_API_KEY: "gsk_secret_value_1234" });

        expect(env.GROQ_API_KEY).toBe("gsk_secret_value_1234");
        expect(field(store, "GROQ_API_KEY")).toMatchObject({ kind: "secret", value: "••••1234", isSet: true });
        expect(JSON.stringify(store.view())).not.toContain("gsk_secret");
    });

    it("rejects unknown keys and invalid values", () => {
        const store = new SettingsStore(install.root, {});

        expect(() => store.update({ PATH: "C:\\evil" })).toThrow(/нельзя менять/);
        expect(() => store.update({ GROQ_CONTEXT: "-5" })).toThrow(/положительное число/);
        expect(() => store.update({ GROQ_MODEL: "a\nINJECTED=1" })).toThrow(/переносы строк/);
    });

    it("lists editable fields for every provider and both reserves", () => {
        const keys = new SettingsStore(install.root, {}).view().fields.map(item => item.key);

        expect(keys).toEqual(expect.arrayContaining([
            "JUSTAI_PROVIDER", "JUSTAI_EXECUTOR_PROVIDER", "ANTHROPIC_API_KEY",
            "RESERVE1_BASE_URL", "RESERVE1_API_KEY", "RESERVE2_MODEL", "JUSTAI_PROXY",
        ]));
        // Размышления локальной модели выключены по умолчанию и в интерфейсе не меняются.
        expect(keys).not.toContain("OLLAMA_REASONING_EFFORT");
    });
});
