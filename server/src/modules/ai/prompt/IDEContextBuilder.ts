export interface IDEPayload {

    activeFile: string;

    activeContent: string;

    openedFiles: string[];

}

export class IDEContextBuilder {

    public build(

        payload: IDEPayload,

    ): string {

        return [

            "===== ACTIVE FILE =====",

            payload.activeFile || "None",

            "",

            "===== OPEN FILES =====",

            payload.openedFiles.join("\n"),

            "",

            "===== FILE CONTENT =====",

            payload.activeContent,

        ].join("\n");

    }

}