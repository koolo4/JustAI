import type {
    AITool,
    ToolResult,
} from "../../ai/tools/AITool.js";

import { MicrosoftGraphService } from "./MicrosoftGraphService.js";

export class WordReadTool implements AITool {

    public readonly name = "word_read";

    public readonly description =
        "Reads text from a .docx Microsoft Word document stored in the connected OneDrive.";

    public readonly parameters = {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Path of the .docx file inside the connected OneDrive.",
            },
        },
        required: ["path"],
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
                await this.graph.readWordText(
                    args.path ?? "",
                );

            return {
                success: true,
                content: [
                    `Word document: ${result.item.name}`,
                    "",
                    result.text,
                    "",
                    result.item.webUrl
                        ? `Open in Word/OneDrive: ${result.item.webUrl}`
                        : "",
                ].filter(Boolean).join("\n"),
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
