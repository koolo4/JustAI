import type { WorkspaceNode } from "../types/workspace";

/** Пути всех файлов и папок дерева (папки — со слешем на конце). */
export function flattenPaths(nodes: WorkspaceNode[]): string[] {
    const paths: string[] = [];

    const walk = (list: WorkspaceNode[]) => {
        for (const node of list) {
            const normalized = node.path.replace(/\\/g, "/");
            paths.push(node.type === "folder" ? `${normalized}/` : normalized);

            if (node.children) {
                walk(node.children);
            }
        }
    };

    walk(nodes);
    return paths;
}

/** Набираемое упоминание перед курсором: «@src/ap» → { start, query: "src/ap" }. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
    const match = /(^|[\s(])@([^\s@"]*)$/.exec(text.slice(0, caret));

    if (!match) {
        return null;
    }

    return { start: caret - match[2]!.length - 1, query: match[2]! };
}

/** Лучшие совпадения: имя файла начинается с запроса → путь начинается → путь содержит; короткие пути выше. */
export function rankPaths(paths: string[], query: string, limit = 8): string[] {
    const needle = query.toLowerCase();

    const score = (item: string): number => {
        const lower = item.toLowerCase();
        const name = lower.replace(/\/$/, "").split("/").pop() ?? lower;

        if (!needle) return 3;
        if (name.startsWith(needle)) return 0;
        if (lower.startsWith(needle)) return 1;
        if (lower.includes(needle)) return 2;
        return -1;
    };

    return paths
        .map(item => ({ item, rank: score(item) }))
        .filter(entry => entry.rank >= 0)
        .sort((a, b) => a.rank - b.rank || a.item.length - b.item.length || a.item.localeCompare(b.item))
        .slice(0, limit)
        .map(entry => entry.item);
}

/** Подставить выбранный путь вместо набираемого упоминания. Пути с пробелами — в кавычках. */
export function applyMention(text: string, caret: number, start: number, path: string): { text: string; caret: number } {
    const clean = path.replace(/\/$/, "");
    const space = /^\s/.test(text.slice(caret)) ? "" : " ";
    const token = (/\s/.test(clean) ? `@"${clean}"` : `@${clean}`) + space;
    const next = text.slice(0, start) + token + text.slice(caret);

    return { text: next, caret: start + token.length };
}
