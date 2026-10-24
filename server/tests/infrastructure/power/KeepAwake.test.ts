import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it } from "vitest";

import { KeepAwake, keepAwakeCommand, keepAwakeModeFromEnv } from "../../../src/infrastructure/power/KeepAwake.js";

/** Поддельный процесс-помощник: запоминает, что его завершили. */
function fakeChild(): ChildProcess & { stopped: boolean } {
    const child = new EventEmitter() as ChildProcess & { stopped: boolean };
    Object.assign(child, { exitCode: null, killed: false, stopped: false });
    child.kill = () => {
        child.stopped = true;
        Object.assign(child, { killed: true });
        return true;
    };
    return child;
}

describe("KeepAwake", () => {
    it("starts one helper while any work is running and stops it when the last one ends", () => {
        const started: Array<{ file: string; child: ReturnType<typeof fakeChild> }> = [];
        const awake = new KeepAwake({
            platform: "win32",
            spawner: file => {
                const child = fakeChild();
                started.push({ file, child });
                return child;
            },
        });

        const task = awake.acquire();
        const command = awake.acquire();
        expect(started).toHaveLength(1);
        expect(started[0]!.file).toBe("powershell.exe");
        expect(awake.active).toBe(true);

        task();
        task();
        expect(started[0]!.child.stopped).toBe(false);

        command();
        expect(started[0]!.child.stopped).toBe(true);
        expect(awake.active).toBe(false);

        // Следующая задача — новый помощник.
        awake.acquire();
        expect(started).toHaveLength(2);
    });

    it("prevents idle sleep on each platform and exits with JustAI", () => {
        const windows = keepAwakeCommand("win32", 4242)!;
        // Система и экран: на Modern Standby погасший экран усыпляет ноутбук.
        expect(windows.args.join(" ")).toContain("SetThreadExecutionState([uint32]2147483651)");
        expect(windows.args.join(" ")).toContain("Get-Process -Id 4242");

        expect(keepAwakeCommand("darwin", 7)).toEqual({ file: "caffeinate", args: ["-i", "-w", "7"] });
        expect(keepAwakeCommand("linux", 7)!.args).toContain("--pid=7");
        expect(keepAwakeCommand("aix", 7)).toBeNull();
    });

    it("reads the mode from settings", () => {
        expect(keepAwakeModeFromEnv(undefined)).toBe("task");
        expect(keepAwakeModeFromEnv("always")).toBe("always");
        expect(keepAwakeModeFromEnv("off")).toBe("off");
        expect(keepAwakeModeFromEnv("whatever")).toBe("task");
    });
});
