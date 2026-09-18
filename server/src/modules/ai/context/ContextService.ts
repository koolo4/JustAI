import type { AIContext } from "./AIContext.js";

export class ContextService {

    public async buildContext(): Promise<AIContext> {

        return {

            workspace: process.cwd(),

            openedFiles: [],

            activeFile: "",

            selection: "",

        };

    }

}