import { promises as fs } from "node:fs";
import path from "node:path";

export type CommandKind = "install" | "build" | "typecheck" | "lint" | "test" | "dev";

export interface DetectedProject {
    /** Путь относительно workspace ("." — корень). */
    root: string;
    stack: "node" | "python" | "rust" | "go" | "dotnet" | "java";
    /** Менеджер пакетов / инструмент сборки. */
    tool: string;
    commands: Partial<Record<CommandKind, string>>;
}

const MAX_PROJECTS = 12;
const SKIP_DIRS = new Set([".git", ".justai", "node_modules", "dist", "build", "target", "bin", "obj", ".venv", "venv", "__pycache__", "coverage", ".next"]);

/**
 * Определяет стек и команды проверки: корень и подпапки до двух уровней (монорепозитории).
 */
export async function detectProjects(
    workspaceRoot: string,
    platform: NodeJS.Platform = process.platform,
): Promise<DetectedProject[]> {
    const projects: DetectedProject[] = [];

    const visit = async (relative: string, depth: number): Promise<void> => {
        if (projects.length >= MAX_PROJECTS) {
            return;
        }

        const absolute = path.join(workspaceRoot, relative);
        let entries: string[];

        try {
            entries = await fs.readdir(absolute);
        }
        catch {
            return;
        }

        const found = await detectIn(absolute, relative === "" ? "." : relative.split(path.sep).join("/"), new Set(entries), platform);
        projects.push(...found);

        if (depth >= 2) {
            return;
        }

        for (const entry of entries.sort()) {
            if (SKIP_DIRS.has(entry) || entry.startsWith(".")) {
                continue;
            }

            const stat = await fs.stat(path.join(absolute, entry)).catch(() => null);

            if (stat?.isDirectory()) {
                await visit(path.join(relative, entry), depth + 1);
            }
        }
    };

    await visit("", 0);

    return projects.slice(0, MAX_PROJECTS);
}

async function detectIn(
    absolute: string,
    root: string,
    files: Set<string>,
    platform: NodeJS.Platform,
): Promise<DetectedProject[]> {
    const projects: DetectedProject[] = [];

    if (files.has("package.json")) {
        const project = await detectNode(absolute, root, files);

        if (project) {
            projects.push(project);
        }
    }

    if (files.has("pyproject.toml") || files.has("requirements.txt") || files.has("setup.py")) {
        projects.push(await detectPython(absolute, root, files));
    }

    if (files.has("Cargo.toml")) {
        projects.push({
            root,
            stack: "rust",
            tool: "cargo",
            commands: { build: "cargo build", typecheck: "cargo check", lint: "cargo clippy", test: "cargo test" },
        });
    }

    if (files.has("go.mod")) {
        projects.push({
            root,
            stack: "go",
            tool: "go",
            commands: { build: "go build ./...", lint: "go vet ./...", test: "go test ./..." },
        });
    }

    if ([...files].some(file => file.endsWith(".sln") || file.endsWith(".csproj"))) {
        projects.push({
            root,
            stack: "dotnet",
            tool: "dotnet",
            commands: { install: "dotnet restore", build: "dotnet build", test: "dotnet test" },
        });
    }

    if (files.has("pom.xml")) {
        projects.push({
            root,
            stack: "java",
            tool: "maven",
            commands: { build: "mvn -q -DskipTests package", test: "mvn -q test" },
        });
    }
    else if (files.has("build.gradle") || files.has("build.gradle.kts")) {
        const gradle = files.has("gradlew")
            ? (platform === "win32" ? ".\\gradlew.bat" : "./gradlew")
            : "gradle";

        projects.push({
            root,
            stack: "java",
            tool: "gradle",
            commands: { build: `${gradle} build -x test`, test: `${gradle} test` },
        });
    }

    return projects;
}

async function detectNode(absolute: string, root: string, files: Set<string>): Promise<DetectedProject | null> {
    let manifest: { scripts?: Record<string, string>; workspaces?: unknown };

    try {
        manifest = JSON.parse(await fs.readFile(path.join(absolute, "package.json"), "utf8"));
    }
    catch {
        return null;
    }

    const manager = files.has("pnpm-lock.yaml")
        ? "pnpm"
        : files.has("yarn.lock")
            ? "yarn"
            : files.has("bun.lockb") || files.has("bun.lock")
                ? "bun"
                : "npm";

    const scripts = manifest.scripts ?? {};
    const run = (script: string) => manager === "npm" ? `npm run ${script}` : `${manager} run ${script}`;
    const pick = (...names: string[]) => names.find(name => scripts[name]);

    const commands: DetectedProject["commands"] = {
        install: manager === "npm"
            ? (files.has("package-lock.json") ? "npm ci" : "npm install")
            : `${manager} install`,
    };

    const typecheck = pick("typecheck", "type-check", "tsc", "check-types");
    const lint = pick("lint");
    const build = pick("build");
    const dev = pick("dev", "start");

    if (typecheck) {
        commands.typecheck = run(typecheck);
    }

    if (lint) {
        commands.lint = run(lint);
    }

    if (build) {
        commands.build = run(build);
    }

    if (scripts.test && !/no test specified/.test(scripts.test)) {
        commands.test = manager === "npm" ? "npm test" : `${manager} test`;
    }

    if (dev) {
        commands.dev = run(dev);
    }

    return { root, stack: "node", tool: manager, commands };
}

async function detectPython(absolute: string, root: string, files: Set<string>): Promise<DetectedProject> {
    const pyproject = files.has("pyproject.toml")
        ? await fs.readFile(path.join(absolute, "pyproject.toml"), "utf8").catch(() => "")
        : "";
    const requirements = files.has("requirements.txt")
        ? await fs.readFile(path.join(absolute, "requirements.txt"), "utf8").catch(() => "")
        : "";
    const text = `${pyproject}\n${requirements}`;

    const tool = files.has("uv.lock") ? "uv" : files.has("poetry.lock") ? "poetry" : "pip";
    const exec = (command: string) => tool === "uv" ? `uv run ${command}` : tool === "poetry" ? `poetry run ${command}` : command;

    const commands: DetectedProject["commands"] = {
        install: tool === "uv"
            ? "uv sync"
            : tool === "poetry"
                ? "poetry install"
                : files.has("requirements.txt") ? "pip install -r requirements.txt" : "pip install -e .",
    };

    if (/\bpytest\b/.test(text) || files.has("tests") || files.has("pytest.ini") || files.has("conftest.py")) {
        commands.test = exec("pytest -q");
    }

    if (/\bruff\b/.test(text) || files.has("ruff.toml") || files.has(".ruff.toml")) {
        commands.lint = exec("ruff check .");
    }

    if (/\bmypy\b/.test(text) || files.has("mypy.ini")) {
        commands.typecheck = exec("mypy .");
    }

    return { root, stack: "python", tool, commands };
}

/**
 * Раздел системного промпта с командами проекта.
 */
export function formatProjectCommands(projects: DetectedProject[]): string {
    if (projects.length === 0) {
        return "";
    }

    const lines = projects.map(project => {
        const commands = Object.entries(project.commands)
            .map(([kind, command]) => `  - ${kind}: \`${command}\``)
            .join("\n");

        return `- ${project.root} (${project.stack}, ${project.tool}), run from that folder:\n${commands}`;
    });

    return [
        "# Project commands (detected)",
        "Use these to build and verify your changes (run them with run_command, cwd set to the project folder):",
        ...lines,
    ].join("\n");
}
