import { promises as fs } from "node:fs";
import path from "node:path";

import type {
    AITool,
    ToolResult,
} from "./AITool.js";

export class ReadFileTool implements AITool {

    public readonly name = "read_file";

    public readonly description =
        "Reads a UTF-8 text file from the local workspace.";

    public readonly parameters = {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Workspace-relative file path.",
            },
        },
        required: ["path"],
        additionalProperties: false,
    };

    constructor(
        private readonly workspaceRoot: string,
    ) {}

    public async execute(
        args: Record<string, string>,
    ): Promise<ToolResult> {

        const file = args.path;

        if (!file) {
            return {
                success: false,
                content: "Missing required argument: path",
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

            const content = await fs.readFile(absolute, "utf8");

            return {
                success: true,
                content,
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
