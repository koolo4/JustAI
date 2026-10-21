import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectProjects, formatProjectCommands } from "../../../src/modules/agent/project/ProjectDetector.js";
import { createTempWorkspace, type TempWorkspace } from "../../helpers/tempWorkspace.js";

describe("detectProjects", () => {
    let workspace: TempWorkspace;

    beforeEach(async () => {
        workspace = await createTempWorkspace();
    });

    afterEach(async () => {
        await workspace.dispose();
    });

    it("detects a Node project: package manager from lockfile and scripts", async () => {
        await workspace.write("package.json", JSON.stringify({
            scripts: { "type-check": "tsc --noEmit", lint: "eslint .", build: "vite build", test: "vitest run", dev: "vite" },
        }));
        await workspace.write("pnpm-lock.yaml", "");

        expect(await detectProjects(workspace.root)).toEqual([{
            root: ".",
            stack: "node",
            tool: "pnpm",
            commands: {
                install: "pnpm install",
                typecheck: "pnpm run type-check",
                lint: "pnpm run lint",
                build: "pnpm run build",
                test: "pnpm test",
                dev: "pnpm run dev",
            },
        }]);
    });

    it("ignores the npm placeholder test script and uses npm ci with a lockfile", async () => {
        await workspace.write("package.json", JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } }));
        await workspace.write("package-lock.json", "{}");

        expect(await detectProjects(workspace.root)).toEqual([
            { root: ".", stack: "node", tool: "npm", commands: { install: "npm ci" } },
        ]);
    });

    it("detects Python with pytest, ruff and mypy via uv", async () => {
        await workspace.write("pyproject.toml", "[tool.ruff]\n[tool.mypy]\n[project]\ndependencies=['pytest']\n");
        await workspace.write("uv.lock", "");

        expect((await detectProjects(workspace.root))[0]).toEqual({
            root: ".",
            stack: "python",
            tool: "uv",
            commands: { install: "uv sync", test: "uv run pytest -q", lint: "uv run ruff check .", typecheck: "uv run mypy ." },
        });
    });

    it("detects Rust, Go, .NET, Maven and Gradle", async () => {
        await workspace.write("rust/Cargo.toml", "");
        await workspace.write("go/go.mod", "module x");
        await workspace.write("dotnet/App.csproj", "");
        await workspace.write("maven/pom.xml", "");
        await workspace.write("gradle/build.gradle.kts", "");
        await workspace.write("gradle/gradlew", "");

        const projects = await detectProjects(workspace.root, "linux");
        const byRoot = Object.fromEntries(projects.map(project => [project.root, project]));

        expect(byRoot.rust).toMatchObject({ stack: "rust", commands: { test: "cargo test", typecheck: "cargo check" } });
        expect(byRoot.go).toMatchObject({ stack: "go", commands: { test: "go test ./..." } });
        expect(byRoot.dotnet).toMatchObject({ stack: "dotnet", commands: { test: "dotnet test" } });
        expect(byRoot.maven).toMatchObject({ stack: "java", tool: "maven", commands: { test: "mvn -q test" } });
        expect(byRoot.gradle).toMatchObject({ stack: "java", tool: "gradle", commands: { test: "./gradlew test" } });
    });

    it("finds subprojects of a monorepo up to two levels and skips node_modules", async () => {
        await workspace.write("package.json", JSON.stringify({ workspaces: ["apps/*"], scripts: { test: "npm test -ws" } }));
        await workspace.write("server/package.json", JSON.stringify({ scripts: { typecheck: "tsc" } }));
        await workspace.write("apps/web/package.json", JSON.stringify({ scripts: { build: "vite build" } }));
        await workspace.write("node_modules/pkg/package.json", JSON.stringify({ scripts: { test: "x" } }));

        expect((await detectProjects(workspace.root)).map(project => project.root)).toEqual([".", "apps/web", "server"]);
    });

    it("formats commands for the system prompt", async () => {
        await workspace.write("package.json", JSON.stringify({ scripts: { test: "vitest run" } }));

        const text = formatProjectCommands(await detectProjects(workspace.root));

        expect(text).toContain("# Project commands (detected)");
        expect(text).toContain("- . (node, npm), run from that folder:");
        expect(text).toContain("  - test: `npm test`");
        expect(formatProjectCommands([])).toBe("");
    });
});
