import path from "node:path";

import { describe, expect, it } from "vitest";

import { PathResolver } from "../../../src/infrastructure/filesystem/PathResolver.js";

describe("PathResolver", () => {
    const root = path.resolve("/workspace/project");
    const resolver = new PathResolver(root);

    it("resolves workspace-relative paths", () => {
        expect(resolver.resolve("package.json")).toBe(path.join(root, "package.json"));
        expect(resolver.relative(path.join(root, "src", "a.ts"))).toBe(path.join("src", "a.ts"));
    });

    it("rejects paths that escape the workspace", () => {
        expect(() => resolver.resolve("../../Windows")).toThrow();
    });
});
