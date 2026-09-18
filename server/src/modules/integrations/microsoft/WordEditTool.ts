import type {
    AITool,
    ToolResult,
} from "../../ai/tools/AITool.js";

import { MicrosoftGraphService } from "./MicrosoftGraphService.js";

export class WordEditTool implements AITool {

    public readonly name = "word_edit";

    public readonly description =
        "Edits text inside a .docx Microsoft Word document stored in the connected OneDrive. Use only when the user explicitly asks to change a Word document.";

    public readonly parameters = {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Path of the .docx file inside the connected OneDrive.",
            },
            find: {
                type: "string",
                description: "Exact text currently present in the Word document.",
            },
            replace: {
                type: "string",
                description: "New text.",
            },
            share: {
                type: "string",
                enum: ["true", "false"],
                description: "Return an edit link when possible.",
            },
        },
        required: ["path", "find", "replace"],
        additionalProperties: false,
    };

    constructor(
        private readonly graph: MicrosoftGraphService,
    ) {}

    public async execute(
        args: Record<string, string>,
    ): Promise<ToolResult> {
        try {
            const result =
                await this.graph.replaceWordText(
                    args.path ?? "",
                    args.find ?? "",
                    args.replace ?? "",
                );

            let link =
                result.item.webUrl ?? null;

            if (
                args.share === "true" ||
                !link
            ) {
                link =
                    await this.graph.createEditLink(
                        result.item.id,
                    ) ??
                    link;
            }

            return {
                success: true,
                content: [
                    `Word document updated: ${result.item.name}`,
                    `Replacements: ${result.replacements}`,
                    link
                        ? `Open in Word/OneDrive: ${link}`
                        : "The document was updated, but a sharing link could not be created.",
                ].join("\n"),
            };
        }
        catch (error) {
            return {
                success: false,
                content: String(error),
            };
        }
    }
}
