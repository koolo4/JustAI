import { promises as fs } from "node:fs";
import path from "node:path";

/** Файлы правил проекта, по приоритету. Берётся первый найденный. */
export const PROJECT_RULE_FILES = ["JUSTAI.md", "AGENTS.md", "CLAUDE.md"];

const MAX_RULES_CHARS = 20_000;

const MAX_TREE_ENTRIES = 200;

export interface ProjectRules {
    file: string;
    content: string;
}

export async function readProjectRules(workspaceRoot: string): Promise<ProjectRules | null> {
    for (const file of PROJECT_RULE_FILES) {
        try {
            const content = await fs.readFile(path.join(workspaceRoot, file), "utf8");
            const trimmed = content.trim();

            if (trimmed) {
                return {
                    file,
                    content: trimmed.length > MAX_RULES_CHARS
                        ? `${trimmed.slice(0, MAX_RULES_CHARS)}\n\n[…truncated]`
                        : trimmed,
                };
            }
        }
        catch {
            // файла нет — пробуем следующий
        }
    }

    return null;
}

/**
 * Краткое дерево проекта (2 уровня) для ориентации агента.
 */
export async function projectTree(
    workspaceRoot: string,
    shouldIgnore: (name: string) => boolean,
    depth = 2,
): Promise<string> {
    const lines: string[] = [];
    let truncated = false;

    async function walk(directory: string, prefix: string, level: number): Promise<void> {
        let entries;

        try {
            entries = await fs.readdir(directory, { withFileTypes: true });
        }
        catch {
            return;
        }

        entries.sort((a, b) =>
            a.isDirectory() !== b.isDirectory()
                ? (a.isDirectory() ? -1 : 1)
                : a.name.localeCompare(b.name),
        );

        for (const entry of entries) {
            if (shouldIgnore(entry.name) || entry.name === ".justai") {
                continue;
            }

            if (lines.length >= MAX_TREE_ENTRIES) {
                truncated = true;
                return;
            }

            lines.push(`${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);

            if (entry.isDirectory() && level < depth) {
                await walk(path.join(directory, entry.name), `${prefix}  `, level + 1);
            }
        }
    }

    await walk(workspaceRoot, "", 1);

    if (truncated) {
        lines.push("… (more entries; use list_dir)");
    }

    return lines.join("\n");
}
