import path from "node:path";

import { describe, expect, it } from "vitest";

import { addGitToPath } from "../../../src/infrastructure/git/GitService.js";

describe("addGitToPath", () => {
    it("puts a git found outside PATH (GitHub Desktop) at the front of PATH, once", () => {
        const dir = path.resolve("desktop", "git", "cmd");
        const binary = path.join(dir, process.platform === "win32" ? "git.exe" : "git");
        const env: NodeJS.ProcessEnv = { Path: ["a", "b"].join(path.delimiter) };

        expect(addGitToPath(binary, env)).toBe(dir);
        // Ключ сохраняется как был (на Windows — «Path»), git первым.
        expect(env.Path!.split(path.delimiter)).toEqual([dir, "a", "b"]);

        expect(addGitToPath(binary, env)).toBeNull();
        expect(env.Path!.split(path.delimiter)).toHaveLength(3);
    });

    it("leaves PATH alone when git is already found through it or not found at all", () => {
        const env: NodeJS.ProcessEnv = { PATH: "x" };

        expect(addGitToPath("git", env)).toBeNull();
        expect(addGitToPath(null, env)).toBeNull();
        expect(env.PATH).toBe("x");
    });
});
