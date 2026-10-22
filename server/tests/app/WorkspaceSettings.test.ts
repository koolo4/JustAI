import { mkdir } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { validateProjectFolder, WorkspaceSettings } from "../../src/app/WorkspaceSettings.js";
import { createTempWorkspace, type TempWorkspace } from "../helpers/tempWorkspace.js";

describe("WorkspaceSettings", () => {
    let install: TempWorkspace;
    let projects: TempWorkspace;

    beforeEach(async () => {
        install = await createTempWorkspace();
        projects = await createTempWorkspace();
        await mkdir(path.join(projects.root, "app-one"));
        await mkdir(path.join(projects.root, "app-two"));
    });

    afterEach(async () => {
        await install.dispose();
        await projects.dispose();
    });

    it("starts in the install folder and remembers opened folders, newest first", () => {
        const settings = new WorkspaceSettings(install.root, {});
        const one = path.join(projects.root, "app-one");
        const two = path.join(projects.root, "app-two");

        expect(settings.currentRoot()).toBe(install.root);

        settings.open(one);
        settings.open(two);
        settings.open(one);

        const reloaded = new WorkspaceSettings(install.root, {});
        expect(reloaded.currentRoot()).toBe(one);
        expect(reloaded.recent()).toEqual([one, two, install.root]);
    });

    it("falls back to the install folder when the saved folder is gone", async () => {
        const settings = new WorkspaceSettings(install.root, {});
        const gone = path.join(projects.root, "app-one");
        settings.open(gone);
        await projects.dispose();

        expect(settings.currentRoot()).toBe(install.root);
        expect(settings.recent()).toEqual([install.root]);
    });

    it("is fixed by JUSTAI_WORKSPACE", () => {
        const settings = new WorkspaceSettings(install.root, { JUSTAI_WORKSPACE: projects.root });

        expect(settings.currentRoot()).toBe(projects.root);
        expect(settings.fixedByEnv).toBe(true);
        expect(() => settings.open(path.join(projects.root, "app-one"))).toThrow(/JUSTAI_WORKSPACE/);
    });

    it("accepts only existing absolute folders that are not a drive root or .justai", () => {
        expect(validateProjectFolder(`"${projects.root}"`)).toBe(projects.root);
        expect(() => validateProjectFolder("relative/path")).toThrow(/full path/);
        expect(() => validateProjectFolder(path.parse(projects.root).root)).toThrow(/drive/);
        expect(() => validateProjectFolder(path.join(projects.root, "missing"))).toThrow(/not found/);
        expect(() => validateProjectFolder(path.join(install.root, ".justai"))).toThrow(/\.justai/);
    });
});
