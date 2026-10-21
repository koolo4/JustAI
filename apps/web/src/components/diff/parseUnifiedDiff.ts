export type DiffLineKind = "context" | "added" | "removed" | "hunk";

export interface DiffLine {
    kind: DiffLineKind;
    text: string;
    oldNumber?: number;
    newNumber?: number;
}

export interface FileDiff {
    path: string;
    lines: DiffLine[];
    added: number;
    removed: number;
    binary: boolean;
}

/**
 * Разбирает unified diff (git diff-tree -p) на файлы и строки с номерами.
 */
export function parseUnifiedDiff(diff: string): FileDiff[] {
    const files: FileDiff[] = [];
    let current: FileDiff | null = null;
    let oldLine = 0;
    let newLine = 0;

    for (const raw of diff.split("\n")) {
        const line = raw.replace(/\r$/, "");

        if (line.startsWith("diff --git ")) {
            const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
            current = { path: match?.[2] ?? line.slice(11), lines: [], added: 0, removed: 0, binary: false };
            files.push(current);
            continue;
        }

        if (!current) {
            continue;
        }

        if (line.startsWith("Binary files ")) {
            current.binary = true;
            continue;
        }

        if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("index ") || /^(new|deleted) file mode/.test(line) || line.startsWith("similarity ")) {
            continue;
        }

        const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);

        if (hunk) {
            oldLine = Number(hunk[1]);
            newLine = Number(hunk[2]);
            current.lines.push({ kind: "hunk", text: line });
            continue;
        }

        if (line.startsWith("+")) {
            current.lines.push({ kind: "added", text: line.slice(1), newNumber: newLine++ });
            current.added += 1;
        }
        else if (line.startsWith("-")) {
            current.lines.push({ kind: "removed", text: line.slice(1), oldNumber: oldLine++ });
            current.removed += 1;
        }
        else if (line.startsWith(" ")) {
            current.lines.push({ kind: "context", text: line.slice(1), oldNumber: oldLine++, newNumber: newLine++ });
        }
        // «\ No newline at end of file» и пустые хвосты пропускаем.
    }

    return files;
}
