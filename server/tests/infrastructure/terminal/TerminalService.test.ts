import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultShell, TerminalNotFoundError, TerminalService, type TerminalEvent } from "../../../src/infrastructure/terminal/TerminalService.js";
import { createTempWorkspace, type TempWorkspace } from "../../helpers/tempWorkspace.js";

async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
    const started = Date.now();

    while (!check()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error("timed out");
        }

        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

describe("TerminalService", () => {
    let workspace: TempWorkspace;
    let service: TerminalService;
    let events: TerminalEvent[];

    beforeEach(async () => {
        workspace = await createTempWorkspace();
        events = [];
        service = new TerminalService(workspace.root, event => events.push(event));
        process.env.FAKE_PROVIDER_API_KEY = "must-not-leak";
    });

    afterEach(async () => {
        delete process.env.FAKE_PROVIDER_API_KEY;
        service.closeAll();
        await new Promise(resolve => setTimeout(resolve, 200));
        await workspace.dispose().catch(() => undefined);
    });

    it("picks a shell for the platform or from JUSTAI_TERMINAL_SHELL", () => {
        expect(defaultShell({ JUSTAI_TERMINAL_SHELL: "pwsh" })).toEqual({ file: "pwsh", args: [] });
        expect(defaultShell({}).file).toBe(process.platform === "win32" ? "powershell.exe" : "/bin/bash");
    });

    it("runs commands in the project folder, streams output and hides secrets", async () => {
        const terminal = await service.create(100, 30);
        const output = () => events
            .filter((event): event is Extract<TerminalEvent, { type: "terminal.output" }> => event.type === "terminal.output" && event.terminalId === terminal.id)
            .map(event => event.data)
            .join("")
            .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

        const command = process.platform === "win32"
            ? "Write-Output \"cwd=$((Get-Location).Path) key=[$env:FAKE_PROVIDER_API_KEY]\"\r"
            : "echo \"cwd=$(pwd) key=[$FAKE_PROVIDER_API_KEY]\"\r";

        service.write(terminal.id, command);
        await waitFor(() => /key=\[\]/.test(output()));

        expect(output()).toContain(`cwd=${workspace.root}`);
        expect(output()).not.toContain("must-not-leak");
        expect(service.list()[0]).toMatchObject({ id: terminal.id, alive: true, buffer: expect.stringContaining("key=[]") });

        service.resize(terminal.id, 120, 40);
        service.close(terminal.id);
        expect(service.list()).toEqual([]);
        expect(() => service.write(terminal.id, "x")).toThrow(TerminalNotFoundError);
    }, 30_000);
});
