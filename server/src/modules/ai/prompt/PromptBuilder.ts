import { IDEContextBuilder } from "./IDEContextBuilder.js";
import { WorkspaceContextBuilder } from "./WorkspaceContextBuilder.js";
import { SystemPromptBuilder } from "./SystemPromptBuilder.js";

export interface PromptRequest {

    prompt: string;

    activeFile: string;

    activeContent: string;

    openedFiles: string[];

    projectTree: unknown;

}

export class PromptBuilder {

    constructor(

        private readonly ide =

            new IDEContextBuilder(),

        private readonly workspace =

            new WorkspaceContextBuilder(),

        private readonly system =

            new SystemPromptBuilder(),

    ) {}

    public build(

        request: PromptRequest,

    ) {

        return {

            system:

                this.system.build(),

            prompt: [

                request.prompt,

                "",

                this.ide.build({

                    activeFile:

                        request.activeFile,

                    activeContent:

                        request.activeContent,

                    openedFiles:

                        request.openedFiles,

                }),

                "",

                this.workspace.build(

                    request.projectTree,

                ),

            ].join("\n\n"),

        };

    }

}