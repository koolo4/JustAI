import { promises as fs } from "node:fs";
import path from "node:path";

import type {
    AITool,
    ToolResult,
} from "./AITool.js";

export class ListFilesTool implements AITool {

    public readonly name = "list_files";

    public readonly description =
        "Lists files and directories inside the local workspace.";

    public readonly parameters = {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Workspace-relative directory path. Defaults to '.'.",
            },
        },
        additionalProperties: false,
    };

    constructor(
        private readonly workspaceRoot: string,
    ) {}

    public async execute(
        args: Record<string, string>,
    ): Promise<ToolResult> {

        const requestedPath = args.path || ".";

        try {
            const absolute = path.resolve(this.workspaceRoot, requestedPath);
            const relative = path.relative(this.workspaceRoot, absolute);

            if (relative.startsWith("..") || path.isAbsolute(relative)) {
                return {
                    success: false,
                    content: "Access denied: path is outside workspace.",
                };
            }

            const entries = await fs.readdir(absolute, { withFileTypes: true });

            const result = entries
                .sort((a, b) => {
                    if (a.isDirectory() !== b.isDirectory()) {
                        return a.isDirectory() ? -1 : 1;
                    }
                    return a.name.localeCompare(b.name, "ru", {
                        numeric: true,
                        sensitivity: "base",
                    });
                })
                .map(entry =>
                    `${entry.isDirectory() ? "[DIR] " : "[FILE] "}${entry.name}`,
                );

            return {
                success: true,
                content: result.join("\n") || "(empty directory)",
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
