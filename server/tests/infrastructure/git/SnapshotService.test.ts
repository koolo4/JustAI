import { readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitService } from "../../../src/infrastructure/git/GitService.js";
import { SnapshotService } from "../../../src/infrastructure/git/SnapshotService.js";
import { createTempWorkspace, type TempWorkspace } from "../../helpers/tempWorkspace.js";

const git = new GitService();

describe.skipIf(!git.available)("SnapshotService", () => {
    let workspace: TempWorkspace;
    let snapshots: SnapshotService;

    const disk = (file: string) => readFile(path.join(workspace.root, file), "utf8");
    const write = (file: string, content: string) => writeFile(path.join(workspace.root, file), content, "utf8");

    beforeEach(async () => {
        workspace = await createTempWorkspace();
        await workspace.write(".gitignore", "secret.env\n");
        await workspace.write("a.txt", "a original\n");
        await workspace.write("b.txt", "b original\n");
        await workspace.write("c.txt", "c original\n");
        await workspace.write("user.txt", "user's uncommitted work\n");
        await workspace.write("secret.env", "TOKEN=1\n");
        await workspace.write("node_modules/pkg/index.js", "x");
        snapshots = new SnapshotService(git, workspace.root);
    });

    afterEach(async () => {
        await workspace.dispose();
    });

    it("reports changes and reverts exactly the session's changes", async () => {
        await snapshots.ensure("s1");

        // «Агент» меняет 3 файла: правит, удаляет, создаёт.
        await write("a.txt", "a changed\n");
        await rm(path.join(workspace.root, "b.txt"));
        await workspace.write("src/new.ts", "export {};\n");

        const changes = await snapshots.changes("s1");

        expect(changes.files).toEqual(expect.arrayContaining([
            { path: "a.txt", status: "modified" },
            { path: "b.txt", status: "deleted" },
            { path: "src/new.ts", status: "added" },
        ]));
        expect(changes.files).toHaveLength(3);
        expect(changes.diff).toContain("-a original");
        expect(changes.diff).toContain("+a changed");

        const reverted = await snapshots.revert("s1");

        expect(reverted).toHaveLength(3);
        expect(await disk("a.txt")).toBe("a original\n");
        expect(await disk("b.txt")).toBe("b original\n");
        expect(existsSync(path.join(workspace.root, "src/new.ts"))).toBe(false);
        expect(existsSync(path.join(workspace.root, "src"))).toBe(false);

        // Незакоммиченная работа пользователя до сессии и игнорируемые файлы не тронуты.
        expect(await disk("user.txt")).toBe("user's uncommitted work\n");
        expect(await disk("c.txt")).toBe("c original\n");
        expect(await disk("secret.env")).toBe("TOKEN=1\n");

        expect((await snapshots.changes("s1")).files).toEqual([]);
    }, 30_000);

    it("keeps the first snapshot of a session and separates sessions", async () => {
        await snapshots.ensure("s1");
        await write("a.txt", "first edit\n");
        await snapshots.ensure("s1");
        await snapshots.ensure("s2");
        await write("a.txt", "second edit\n");

        expect((await snapshots.changes("s1")).diff).toContain("-a original");
        expect((await snapshots.changes("s2")).diff).toContain("-first edit");
    }, 30_000);

    it("ignores files matched by .gitignore and default excludes", async () => {
        await snapshots.ensure("s1");
        await write("secret.env", "TOKEN=2\n");
        await workspace.write("node_modules/pkg/index.js", "changed");

        expect((await snapshots.changes("s1")).files).toEqual([]);
    }, 30_000);

    it("does nothing for sessions without a snapshot and can discard", async () => {
        expect(await snapshots.has("none")).toBe(false);
        expect(await snapshots.revert("none")).toEqual([]);

        await snapshots.ensure("s1");
        expect(await snapshots.has("s1")).toBe(true);

        await snapshots.discard("s1");
        expect(await snapshots.has("s1")).toBe(false);
    }, 30_000);
});
