import { z } from "zod";

import type { CodeIndex } from "../index/CodeIndex.js";
import { defineTool, ToolError, type Tool } from "./Tool.js";

const SNIPPET_LINES = 12;

/**
 * search_code: поиск по смыслу («где проверяется токен», «как сохраняются сессии»), когда точное слово неизвестно.
 * Индекс строится при первом вызове и дальше обновляется только по изменённым файлам.
 */
export function createCodeSearchTool(index: () => CodeIndex): Tool {
    return defineTool({
        name: "search_code",
        description: [
            "Semantic code search: finds code by meaning, e.g. \"where is the auth token checked\" or \"how sessions are saved\".",
            "Use it when you do not know the exact names to grep for. Returns file paths with line ranges and short snippets;",
            "read the files for details. The first call indexes the project and can take a while.",
        ].join(" "),
        inputSchema: z.object({
            query: z.string().min(3).describe("What you are looking for, in natural language."),
            limit: z.number().int().min(1).max(20).default(8),
        }),
        kind: "read",
        run: async ({ query, limit }, context) => {
            let result;

            try {
                result = await index().search(query, limit, context.signal);
            }
            catch (error) {
                throw new ToolError(`${error instanceof Error ? error.message : String(error)} Use grep or glob instead.`);
            }

            if (result.hits.length === 0) {
                return "No indexed code yet (the project has no text files to index).";
            }

            const header = `Top ${result.hits.length} of ${result.indexed} indexed file(s)${result.updated ? ` (re-indexed ${result.updated} changed file(s))` : ""}:`;

            const blocks = result.hits.map(hit => {
                const lines = hit.text.split("\n");
                const snippet = lines.slice(0, SNIPPET_LINES).join("\n");
                const more = lines.length > SNIPPET_LINES ? `\n… (${lines.length - SNIPPET_LINES} more lines)` : "";
                return `${hit.path}:${hit.startLine}-${hit.endLine} (score ${hit.score.toFixed(2)})\n${snippet}${more}`;
            });

            return [header, ...blocks].join("\n\n");
        },
    });
}
