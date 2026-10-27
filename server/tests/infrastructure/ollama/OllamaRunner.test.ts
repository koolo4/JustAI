import { describe, expect, it } from "vitest";

import { isLocalOllama, restartOllamaRunner } from "../../../src/infrastructure/ollama/OllamaRunner.js";

describe("restartOllamaRunner", () => {
    it("kills only the model process on Windows (Ollama itself stays and reloads the model)", async () => {
        const calls: string[][] = [];
        const killed = await restartOllamaRunner("win32", async (file, args) => {
            calls.push([file, ...args]);
            return { code: args.includes("llama-server.exe") ? 0 : 128 };
        });

        expect(killed).toBe(true);
        expect(calls).toEqual([
            ["taskkill", "/F", "/IM", "llama-server.exe"],
            ["taskkill", "/F", "/IM", "ollama_llama_server.exe"],
        ]);
    });

    it("reports when there was nothing to restart", async () => {
        expect(await restartOllamaRunner("linux", async () => ({ code: 1 }))).toBe(false);
    });

    it("heals only an Ollama on this computer", () => {
        expect(isLocalOllama(undefined)).toBe(true);
        expect(isLocalOllama("http://127.0.0.1:11434/v1")).toBe(true);
        expect(isLocalOllama("http://localhost:11434/v1")).toBe(true);
        expect(isLocalOllama("http://192.168.1.5:11434/v1")).toBe(false);
        expect(isLocalOllama("not a url")).toBe(false);
    });
});
