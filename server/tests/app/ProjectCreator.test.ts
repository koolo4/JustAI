import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProject } from "../../src/app/ProjectCreator.js";
import { GitService } from "../../src/infrastructure/git/GitService.js";
import { createTempWorkspace, type TempWorkspace } from "../helpers/tempWorkspace.js";

const git = new GitService();

describe.skipIf(!git.available)("createProject", () => {
    let workspace: TempWorkspace;

    beforeEach(async () => {
        workspace = await createTempWorkspace();
    });

    afterEach(async () => {
        await workspace.dispose();
    });

    it("creates an empty project with git, README and .gitignore that keeps .justai out", async () => {
        const target = await createProject({ parent: workspace.root, name: "Новый сайт" }, git, undefined);

        expect(target).toBe(path.join(workspace.root, "Новый сайт"));
        expect(readFileSync(path.join(target, "README.md"), "utf8")).toBe("# Новый сайт\n");
        expect(readFileSync(path.join(target, ".gitignore"), "utf8")).toContain(".justai/");
        expect(existsSync(path.join(target, ".git"))).toBe(true);
    });

    it("clones a repository (here a local bare repo standing in for GitHub)", async () => {
        // Клон с github.com в тесте недоступен — проверяем ошибку доступа и сам путь клонирования отдельно.
        await expect(createProject({ parent: workspace.root, name: "x", repo: "koolo4/definitely-not-a-repo-123" }, git, undefined))
            .rejects.toThrow(/Cannot clone koolo4\/definitely-not-a-repo-123/);
        expect(existsSync(path.join(workspace.root, "x"))).toBe(false);
    }, 60_000);

    it("refuses bad names, non-empty folders and malformed repositories", async () => {
        await workspace.write("busy/file.txt", "x");

        await expect(createProject({ parent: workspace.root, name: "busy" }, git, undefined)).rejects.toThrow(/not empty/);
        await expect(createProject({ parent: workspace.root, name: "../evil" }, git, undefined)).rejects.toThrow(/Project name/);
        await expect(createProject({ parent: workspace.root, name: "ok", repo: "not a repo" }, git, undefined)).rejects.toThrow(/owner\/name/);
        await expect(createProject({ parent: "relative/path", name: "ok" }, git, undefined)).rejects.toThrow(/full path/);
    });

    it("an empty existing folder can become a project", async () => {
        execFileSync(process.platform === "win32" ? "cmd" : "mkdir", process.platform === "win32" ? ["/c", "mkdir", path.join(workspace.root, "empty")] : [path.join(workspace.root, "empty")]);
        const target = await createProject({ parent: workspace.root, name: "empty" }, git, undefined);
        expect(existsSync(path.join(target, "README.md"))).toBe(true);
    });
});
