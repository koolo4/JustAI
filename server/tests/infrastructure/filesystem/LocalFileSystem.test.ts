import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalFileSystem } from "../../../src/infrastructure/filesystem/LocalFileSystem.js";
import { createTempWorkspace, type TempWorkspace } from "../../helpers/tempWorkspace.js";

describe("LocalFileSystem", () => {
    let workspace: TempWorkspace;
    const fs = new LocalFileSystem();

    beforeEach(async () => {
        workspace = await createTempWorkspace();
    });

    afterEach(async () => {
        await workspace.dispose();
    });

    it("writes, reads and lists files", async () => {
        const dir = path.join(workspace.root, "nested");
        const file = path.join(dir, "test.txt");

        await fs.mkdir(dir);
        await fs.writeFile(file, "Hello JustAI");

        expect(await fs.exists(file)).toBe(true);
        expect(await fs.readFile(file)).toBe("Hello JustAI");

        const entries = await fs.readDirectory(dir);
        expect(entries.map(entry => entry.name)).toEqual(["test.txt"]);
    });

    it("renames and deletes", async () => {
        const source = await workspace.write("a.txt", "x");
        const target = path.join(workspace.root, "b.txt");

        await fs.rename(source, target);
        expect(await fs.exists(source)).toBe(false);
        expect(await fs.exists(target)).toBe(true);

        await fs.delete(target);
        expect(await fs.exists(target)).toBe(false);
    });
});
