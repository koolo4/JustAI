import { describe, expect, it } from "vitest";

import { safeChildEnv } from "../../../src/infrastructure/process/ProcessManager.js";

describe("safeChildEnv", () => {
    it("drops API keys, tokens and secrets of every provider but keeps ordinary variables", () => {
        const env = safeChildEnv({
            PATH: "C:\\bin",
            NODE_ENV: "development",
            GROQ_MODEL: "openai/gpt-oss-120b",
            ANTHROPIC_BASE_URL: "x",
            OPENAI_API_KEY: "x",
            GROQ_API_KEY: "x",
            OPENROUTER_API_KEY: "x",
            RESERVE1_API_KEY: "x",
            GEMINI_API_KEY: "x",
            GITHUB_TOKEN: "x",
            JUSTAI_TOKEN: "x",
            MICROSOFT_CLIENT_SECRET: "x",
            DB_PASSWORD: "x",
        });

        expect(env).toEqual({ PATH: "C:\\bin", NODE_ENV: "development", GROQ_MODEL: "openai/gpt-oss-120b" });
    });
});
