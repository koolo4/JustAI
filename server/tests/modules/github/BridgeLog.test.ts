import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BridgeLog } from "../../../src/modules/github/BridgeLog.js";
import { createTempWorkspace, type TempWorkspace } from "../../helpers/tempWorkspace.js";

describe("BridgeLog", () => {
    let workspace: TempWorkspace;

    beforeEach(async () => {
        workspace = await createTempWorkspace();
    });

    afterEach(async () => {
        await workspace.dispose();
    });

    it("keeps one chronological feed and returns only new events after an id", async () => {
        const log = BridgeLog.inWorkspace(workspace.root);
        const first = log.add({ kind: "task", issue: 5, title: "Каркас", text: "Задача от koolo4" });
        log.add({ kind: "start", issue: 5, text: "Выполняю", sessionId: "s1" });
        log.add({ kind: "done", issue: 5, text: "Готово → PR 6" });

        expect((await log.list()).map(event => event.kind)).toEqual(["task", "start", "done"]);
        expect((await log.list({ after: first.id })).map(event => event.kind)).toEqual(["start", "done"]);
        expect(await log.list({ limit: 1 })).toEqual([expect.objectContaining({ kind: "done" })]);
    });

    it("survives a restart: events are read back from .justai/bridge-log.jsonl", async () => {
        const log = BridgeLog.inWorkspace(workspace.root);
        log.add({ kind: "merged", issue: 7, text: "Слито в main" });
        await log.flush();

        const restarted = new BridgeLog(path.join(workspace.root, ".justai", "bridge-log.jsonl"));
        restarted.add({ kind: "gap", text: "ПК спал" });

        expect((await restarted.list()).map(event => event.kind)).toEqual(["merged", "gap"]);
    });
});
