/**
 * План от планировщика, у которого доступ к GitHub только на чтение (например, подключение в веб-чате):
 * он пишет задачи и команды текстом в этом формате, человек вставляет текст в ленту JustAI,
 * и JustAI создаёт issues своим токеном. Блоки разделяются строкой «### ISSUE»:
 *
 *   ### ISSUE
 *   [justai] Каркас сайта
 *   Цель: …
 *
 *   ### ISSUE
 *   [justai] Страница игры
 *   …
 *   Depends on @1          ← @1 — номер issue из первого блока (станет #N после создания)
 *
 *   ### ISSUE
 *   /justai e2e @2         ← команда: issue без метки, первая строка — команда
 *   ```yaml …```
 */

export interface PlanBlock {
    title: string;
    body: string;
    /** Команда («/justai …» в начале) — служебный issue без метки задач. */
    command: boolean;
}

const SEPARATOR = /^\s*#{2,3}\s*ISSUE\b.*$/im;

/** Есть ли в тексте план (хотя бы один «### ISSUE»). */
export function isPlan(text: string): boolean {
    return SEPARATOR.test(text);
}

export function parsePlan(text: string, label: string): PlanBlock[] {
    const parts = text.split(new RegExp(SEPARATOR.source, "gim")).slice(1);
    const blocks: PlanBlock[] = [];

    for (const part of parts) {
        const lines = part.replace(/\r\n/g, "\n").split("\n");
        while (lines.length && !lines[0]!.trim()) lines.shift();
        while (lines.length && !lines.at(-1)!.trim()) lines.pop();

        if (!lines.length) continue;

        const first = lines[0]!.trim();
        const command = new RegExp(`^/${escapeRegExp(label)}\\b`, "i").test(first);

        if (command) {
            blocks.push({ title: `Команда: ${first.slice(0, 100)}`, body: lines.join("\n"), command: true });
            continue;
        }

        // Первая строка — заголовок («Заголовок:» / «Title:» можно писать, можно нет).
        const title = first.replace(/^(заголовок|title)\s*:\s*/i, "").trim();
        const body = lines.slice(1).join("\n").trim();
        const marked = new RegExp(`^\\[${escapeRegExp(label)}(-test)?\\]`, "i").test(title);

        blocks.push({ title: marked ? title : `[${label}] ${title}`, body, command: false });
    }

    return blocks;
}

/**
 * Ссылки «@N» на блоки этого же плана → настоящие номера «#M». Только в строках зависимостей и команд,
 * чтобы не задеть обычный текст (почту, упоминания).
 */
export function resolveRefs(body: string, numbers: number[], label: string): string {
    const commandLine = new RegExp(`^\\s*(/${escapeRegExp(label)}\\b|[-*]?\\s*\\**\\s*(depends on|зависит от))`, "i");

    return body.split("\n").map(line => commandLine.test(line)
        ? line.replace(/(^|[\s,(])@(\d+)\b/g, (match, before: string, index: string) => {
            const number = numbers[Number(index) - 1];
            return number ? `${before}#${number}` : match;
        })
        : line).join("\n");
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
