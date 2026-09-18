import type { ToolCall } from "../tools/ToolCall.js";

export class Planner {

    public plan(
        prompt: string,
    ): ToolCall | null {

        const match =
            prompt.match(
                /^(?:прочитай|открой|read|open)\s+(?:файл\s+|the\s+)?(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s]+))/i,
            );

        if (!match) {
            return null;
        }

        const filePath =
            match[1] ??
            match[2] ??
            match[3] ??
            match[4];

        if (!filePath) {
            return null;
        }

        return {
            tool: "read_file",
            arguments: {
                path: filePath,
            },
        };
    }
}
