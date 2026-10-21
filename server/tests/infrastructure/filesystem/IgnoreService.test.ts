import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IgnoreService } from "../../../src/infrastructure/filesystem/IgnoreService.js";
import { createTempWorkspace, type TempWorkspace } from "../../helpers/tempWorkspace.js";

describe("IgnoreService", () => {
    let workspace: TempWorkspace;

    beforeEach(async () => {
        workspace = await createTempWorkspace();
    });

    afterEach(async () => {
        await workspace.dispose();
    });

    it("ignores built-in folders without a .gitignore", async () => {
        const ignore = new IgnoreService(workspace.root);
        await ignore.initialize();

        expect(ignore.shouldIgnore(".git")).toBe(true);
        expect(ignore.shouldIgnore("node_modules")).toBe(true);
        expect(ignore.shouldIgnore("src")).toBe(false);
    });

    it("reads rules from .gitignore, including directory rules with a trailing slash and CRLF", async () => {
        await workspace.write(".gitignore", "# comment\r\n.cache/\r\nsecret.txt\r\n\r\n");

        const ignore = new IgnoreService(workspace.root);
        await ignore.initialize();

        expect(ignore.shouldIgnore(".cache")).toBe(true);
        expect(ignore.shouldIgnore("secret.txt")).toBe(true);
        expect(ignore.shouldIgnore("# comment")).toBe(false);
    });
});
