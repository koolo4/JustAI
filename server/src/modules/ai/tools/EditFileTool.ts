import { promises as fs } from "node:fs";
import path from "node:path";

import type {
    AITool,
    ToolResult,
} from "./AITool.js";

export class EditFileTool implements AITool {

    public readonly name = "edit_file";

    public readonly description =
        "Replaces an exact text fragment in a UTF-8 workspace file. Use only when the user asks to change a local file.";

    public readonly parameters = {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Workspace-relative file path.",
            },
            find: {
                type: "string",
                description: "Exact text to replace.",
            },
            replace: {
                type: "string",
                description: "Replacement text.",
            },
        },
        required: ["path", "find", "replace"],
        additionalProperties: false,
    };

    constructor(
        private readonly workspaceRoot: string,
    ) {}

    public async execute(
        args: Record<string, string>,
    ): Promise<ToolResult> {

        const file = args.path;
        const find = args.find;
        const replace = args.replace;

        if (!file || find === undefined || replace === undefined) {
            return {
                success: false,
                content: "Required arguments: path, find, replace.",
            };
        }

        try {
            const absolute = path.resolve(this.workspaceRoot, file);
            const relative = path.relative(this.workspaceRoot, absolute);

            if (relative.startsWith("..") || path.isAbsolute(relative)) {
                return {
                    success: false,
                    content: "Access denied: file is outside workspace.",
                };
            }

            const current = await fs.readFile(absolute, "utf8");

            if (!current.includes(find)) {
                return {
                    success: false,
                    content: "The exact text to replace was not found.",
                };
            }

            const occurrences = current.split(find).length - 1;

            if (occurrences > 1) {
                return {
                    success: false,
                    content: `The text occurs ${occurrences} times. Refuse to make an ambiguous edit; provide a more specific fragment.`,
                };
            }

            const updated = current.replace(find, replace);
            await fs.writeFile(absolute, updated, "utf8");

            return {
                success: true,
                content: `Updated ${file}. Exactly one occurrence was replaced.`,
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
