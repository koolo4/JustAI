import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProcessManager } from "../../../../src/infrastructure/process/ProcessManager.js";
import { DiagnosticsService, formatDiagnostics, parseDiagnostics } from "../../../../src/modules/agent/diagnostics/Diagnostics.js";
import { createDiagnosticsTool } from "../../../../src/modules/agent/tools/diagnosticsTool.js";
import { createTempWorkspace, type TempWorkspace } from "../../../helpers/tempWorkspace.js";

describe("parseDiagnostics", () => {
    it("parses tsc output and maps paths of a workspace package to the project root", () => {
        const output = [
            "src/app.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
            "src/util.ts(3,1): warning TS6133: 'x' is declared but its value is never read.",
            "Found 2 errors.",
        ].join("\n");

        expect(parseDiagnostics(output, "server")).toEqual([
            { path: "server/src/app.ts", line: 12, column: 5, severity: "error", code: "TS2322", message: "Type 'string' is not assignable to type 'number'." },
            { path: "server/src/util.ts", line: 3, column: 1, severity: "warning", code: "TS6133", message: "'x' is declared but its value is never read." },
        ]);
    });

    it("parses colon formats (eslint unix, gcc, mypy) including Windows drive paths", () => {
        const output = [
            "src/a.js:4:10: error: 'foo' is not defined [no-undef]",
            "lib/b.py:7:1: unused import os",
            "    at Object.<anonymous> (node:internal/main:1:1)",
        ].join("\n");

        expect(parseDiagnostics(output, ".")).toEqual([
            { path: "src/a.js", line: 4, column: 10, severity: "error", message: "'foo' is not defined [no-undef]" },
            { path: "lib/b.py", line: 7, column: 1, severity: "error", message: "unused import os" },
        ]);
        expect(parseDiagnostics("C:\\work\\app\\src\\x.ts:1:2: warning: careful", ".", "C:\\work\\app")[0]).toMatchObject(
            process.platform === "win32" ? { path: "src/x.ts", severity: "warning" } : { line: 1 },
        );
    });
});

describe("DiagnosticsService", () => {
    let workspace: TempWorkspace;
    const processes = new ProcessManager();

    beforeEach(async () => {
        workspace = await createTempWorkspace();
    });

    afterEach(async () => {
        await processes.killAll();
        await workspace.dispose();
    });

    it("runs the project's typecheck script and returns parsed problems", async () => {
        await workspace.write("check.js", "console.log(\"src/main.ts(2,7): error TS2304: Cannot find name 'foo'.\"); process.exit(2);\n");
        await workspace.write("package.json", JSON.stringify({ name: "p", scripts: { typecheck: "node check.js" } }));

        const service = new DiagnosticsService(processes, workspace.root, 60_000);
        const result = await service.run(new AbortController().signal);

        expect(result.checks).toEqual([{ cwd: ".", command: expect.stringContaining("typecheck"), ok: false }]);
        expect(result.diagnostics).toEqual([
            { path: "src/main.ts", line: 2, column: 7, severity: "error", code: "TS2304", message: "Cannot find name 'foo'." },
        ]);

        const tool = createDiagnosticsTool(service);
        const output = await tool.run({ path: "src/" }, { sessionId: "s", toolUseId: "t", workspaceRoot: workspace.root, signal: new AbortController().signal, emit: () => undefined });
        expect(output).toContain("1 error(s), 0 warning(s):\nsrc/main.ts:2:7 error TS2304: Cannot find name 'foo'.");
    }, 60_000);

    it("explains when the project has no checks", () => {
        expect(formatDiagnostics({ checks: [], diagnostics: [], unparsed: "" })).toContain("No type-check or lint command");
        expect(formatDiagnostics({ checks: [{ cwd: ".", command: "npm run lint", ok: true }], diagnostics: [], unparsed: "" })).toContain("No problems found.");
    });
});
