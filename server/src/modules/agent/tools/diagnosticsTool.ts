import { z } from "zod";

import { formatDiagnostics, type DiagnosticsService } from "../diagnostics/Diagnostics.js";
import { defineTool, type Tool } from "./Tool.js";

/**
 * diagnostics: ошибки компилятора и линтера по всему проекту одним вызовом — быстрее и точнее, чем
 * искать их запуском тестов. Команды берутся из самого проекта (скрипты typecheck/lint), как у автопроверки.
 */
export function createDiagnosticsTool(service: DiagnosticsService): Tool {
    return defineTool({
        name: "diagnostics",
        description: [
            "Runs the project's own type-check and lint commands and returns the problems as file:line:column messages.",
            "Use it after editing code to find compile errors, and before finishing. Optionally filter by path prefix.",
        ].join(" "),
        inputSchema: z.object({
            path: z.string().optional().describe("Only report problems in files under this path, e.g. \"src/\"."),
        }),
        kind: "execute",
        run: async ({ path }, context) => {
            const result = await service.run(context.signal, context.sessionId);
            const prefix = path?.replace(/\\/g, "/").replace(/^\.\//, "");

            return formatDiagnostics(prefix
                ? { ...result, diagnostics: result.diagnostics.filter(item => item.path.startsWith(prefix)) }
                : result);
        },
    });
}
