import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ForbiddenError } from "../../../src/core/errors/ForbiddenError.js";
import { PathResolver } from "../../../src/infrastructure/filesystem/PathResolver.js";
import { isInside, resolveSafePath } from "../../../src/infrastructure/filesystem/safePath.js";

describe("isInside", () => {
    const root = path.resolve("/work/app");

    it("accepts the root and nested paths", () => {
        expect(isInside(root, root)).toBe(true);
        expect(isInside(root, path.join(root, "src", "a.ts"))).toBe(true);
        expect(isInside(root, path.join(root, "..foo"))).toBe(true);
    });

    it("rejects a sibling folder sharing the root prefix", () => {
        expect(isInside(root, path.resolve("/work/app-evil/secret.txt"))).toBe(false);
    });

    it("rejects parent and unrelated paths", () => {
        expect(isInside(root, path.resolve("/work"))).toBe(false);
        expect(isInside(root, path.resolve("/etc/passwd"))).toBe(false);
    });

    it("PathResolver uses the same check", () => {
        const resolver = new PathResolver(root);
        expect(() => resolver.resolve("../app-evil/secret.txt")).toThrow(ForbiddenError);
        expect(resolver.isInsideWorkspace("../app-evil")).toBe(false);
    });
});

describe("resolveSafePath", () => {
    let base: string;
    let root: string;
    let outside: string;

    beforeEach(async () => {
        base = await mkdtemp(path.join(os.tmpdir(), "justai-safepath-"));
        root = path.join(base, "app");
        outside = path.join(base, "app-evil");
        await mkdir(path.join(root, "src"), { recursive: true });
        await mkdir(outside, { recursive: true });
    });

    afterEach(async () => {
        await rm(base, { recursive: true, force: true });
    });

    it("resolves existing and not-yet-existing files inside the workspace", async () => {
        await expect(resolveSafePath(root, "src", "read")).resolves.toBe(path.join(root, "src"));
        await expect(resolveSafePath(root, "src/new/file.ts", "write"))
            .resolves.toBe(path.join(root, "src", "new", "file.ts"));
    });

    it("rejects traversal, absolute paths and prefix siblings", async () => {
        await expect(resolveSafePath(root, "../app-evil/x.txt", "read")).rejects.toThrow(ForbiddenError);
        await expect(resolveSafePath(root, outside, "read")).rejects.toThrow(ForbiddenError);
    });

    it("treats '/' and '/src' from models as the workspace root, still confined", async () => {
        await expect(resolveSafePath(root, "/", "read")).resolves.toBe(root);
        await expect(resolveSafePath(root, "/src", "read")).resolves.toBe(path.join(root, "src"));
        await expect(resolveSafePath(root, "\\src", "read")).resolves.toBe(path.join(root, "src"));
        // Выход наверх по-прежнему запрещён, а UNC-пути не переписываются.
        await expect(resolveSafePath(root, "/../app-evil/x.txt", "read")).rejects.toThrow(ForbiddenError);
        await expect(resolveSafePath(root, "//server/share/x", "read")).rejects.toThrow(ForbiddenError);
    });

    it("denies .justai always and .git for writing", async () => {
        await expect(resolveSafePath(root, ".justai/sessions/a.jsonl", "read")).rejects.toThrow(ForbiddenError);
        await expect(resolveSafePath(root, ".git/config", "write")).rejects.toThrow(ForbiddenError);
        await expect(resolveSafePath(root, ".git/config", "read")).resolves.toBe(path.join(root, ".git", "config"));
    });

    it("rejects a symbolic link that points outside the workspace", async () => {
        // junction не требует прав администратора на Windows
        await symlink(outside, path.join(root, "link"), "junction");

        await expect(resolveSafePath(root, "link/secret.txt", "read")).rejects.toThrow(ForbiddenError);
        await expect(resolveSafePath(root, "link/new.txt", "write")).rejects.toThrow(ForbiddenError);
    });
});
