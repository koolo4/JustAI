import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DirectoryScanner } from "../../../src/infrastructure/filesystem/DirectoryScanner.js";
import { IgnoreService } from "../../../src/infrastructure/filesystem/IgnoreService.js";
import { LocalFileSystem } from "../../../src/infrastructure/filesystem/LocalFileSystem.js";
import { PathResolver } from "../../../src/infrastructure/filesystem/PathResolver.js";
import { createTempWorkspace, type TempWorkspace } from "../../helpers/tempWorkspace.js";

describe("DirectoryScanner", () => {
    let workspace: TempWorkspace;

    beforeEach(async () => {
        workspace = await createTempWorkspace();
    });

    afterEach(async () => {
        await workspace.dispose();
    });

    it("builds a tree with relative paths and skips ignored entries", async () => {
        await workspace.write("src/index.ts", "");
        await workspace.write("README.md", "");
        await workspace.write("node_modules/pkg/index.js", "");

        const ignore = new IgnoreService(workspace.root);
        await ignore.initialize();

        const scanner = new DirectoryScanner(
            new LocalFileSystem(),
            new PathResolver(workspace.root),
            ignore,
        );

        const tree = await scanner.scan();
        const names = tree.map(node => node.name).sort();

        expect(names).toEqual(["README.md", "src"]);

        const src = tree.find(node => node.name === "src");
        expect(src?.type).toBe("folder");
        expect(src?.children?.[0]).toMatchObject({
            name: "index.ts",
            path: "src/index.ts",
            type: "file",
        });
    });
});
