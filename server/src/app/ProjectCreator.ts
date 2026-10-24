import { existsSync, readdirSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { BadRequestError } from "../core/errors/BadRequestError.js";
import type { GitService } from "../infrastructure/git/GitService.js";
import { validateProjectFolder } from "./WorkspaceSettings.js";

export interface CreateProjectRequest {
    /** Папка, в которой создать проект (например C:\Projects). */
    parent: string;
    /** Имя папки проекта. */
    name: string;
    /** owner/name — клонировать этот репозиторий GitHub вместо пустого проекта. */
    repo?: string;
}

/**
 * Новый проект для JustAI: пустая папка с git (README и .gitignore с .justai) или клон репозитория GitHub.
 * Токен моста (если задан) передаётся git через окружение — не попадает в адрес и конфиг клона.
 */
export async function createProject(request: CreateProjectRequest, git: GitService, token: string | undefined): Promise<string> {
    const parent = validateProjectFolder(request.parent);
    const name = request.name.trim();

    if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,99}$/u.test(name) || /[. ]$/.test(name)) {
        throw new BadRequestError("Project name: letters, digits, spaces, dots, dashes and underscores (up to 100 characters), not ending with a dot or space.");
    }

    const target = path.join(parent, name);

    if (existsSync(target) && readdirSync(target).length > 0) {
        throw new BadRequestError(`Folder already exists and is not empty: ${target}. Open it instead, or choose another name.`);
    }

    if (request.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(request.repo)) {
        throw new BadRequestError(`Repository must look like owner/name, got "${request.repo}".`);
    }

    if (request.repo && !git.available) {
        throw new BadRequestError("git is not found: install Git (or GitHub Desktop) to clone repositories.");
    }

    const createdHere = !existsSync(target);

    try {
        if (request.repo) {
            const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0" };

            if (token) {
                Object.assign(env, {
                    GIT_CONFIG_COUNT: "1",
                    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
                    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
                });
            }

            const result = await git.run(["clone", `https://github.com/${request.repo}.git`, target], { cwd: parent, env });

            if (result.code !== 0) {
                const reason = result.stderr.trim().split("\n").filter(Boolean).at(-1) ?? "unknown error";
                throw new BadRequestError(/not found|could not read|403|denied/i.test(reason)
                    ? `Cannot clone ${request.repo}: ${reason}. Check the name and that the GitHub token (Settings → GitHub) has access to this repository.`
                    : `Cannot clone ${request.repo}: ${reason}`);
            }

            return target;
        }

        await mkdir(target, { recursive: true });
        await writeFile(path.join(target, "README.md"), `# ${name}\n`, "utf8");
        await writeFile(path.join(target, ".gitignore"), ".justai/\nnode_modules/\n", "utf8");

        if (git.available) {
            await git.run(["init", "-b", "main"], { cwd: target });
        }

        return target;
    }
    catch (error) {
        if (createdHere) await rm(target, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}
