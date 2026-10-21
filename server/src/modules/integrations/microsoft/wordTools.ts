import { z } from "zod";

import { defineTool, ToolError, type Tool } from "../../agent/tools/Tool.js";
import { MicrosoftGraphService } from "./MicrosoftGraphService.js";

/**
 * Инструменты агента для .docx в подключённом OneDrive.
 */
export function createWordTools(graph: MicrosoftGraphService): Tool[] {
    const wordRead = defineTool({
        name: "word_read",
        description: "Reads text from a .docx Microsoft Word document stored in the connected OneDrive.",
        inputSchema: z.object({
            path: z.string().describe("Path of the .docx file inside the connected OneDrive."),
        }),
        kind: "network",
        run: async ({ path }) => {
            const result = await call(() => graph.readWordText(path));

            return [
                `Word document: ${result.item.name}`,
                "",
                result.text,
                "",
                result.item.webUrl ? `Open in Word/OneDrive: ${result.item.webUrl}` : "",
            ].filter(Boolean).join("\n");
        },
    });

    const wordEdit = defineTool({
        name: "word_edit",
        description: "Replaces text inside a .docx Microsoft Word document stored in the connected OneDrive. Use only when the user explicitly asks to change a Word document.",
        inputSchema: z.object({
            path: z.string().describe("Path of the .docx file inside the connected OneDrive."),
            find: z.string().min(1).describe("Exact text currently present in the document."),
            replace: z.string().describe("New text."),
            share: z.boolean().default(false).describe("Return an edit link when possible."),
        }),
        kind: "network",
        run: async ({ path, find, replace, share }) => {
            const result = await call(() => graph.replaceWordText(path, find, replace));

            let link = result.item.webUrl ?? null;

            if (share || !link) {
                link = await graph.createEditLink(result.item.id) ?? link;
            }

            return [
                `Word document updated: ${result.item.name}`,
                `Replacements: ${result.replacements}`,
                link
                    ? `Open in Word/OneDrive: ${link}`
                    : "The document was updated, but a sharing link could not be created.",
            ].join("\n");
        },
    });

    return [wordRead, wordEdit];
}

async function call<T>(action: () => Promise<T>): Promise<T> {
    try {
        return await action();
    }
    catch (error) {
        throw new ToolError(error instanceof Error ? error.message : String(error));
    }
}
