export interface AIChatRequest {

    prompt: string;

    provider?: string;

    agent?: string;

    activeFile?: string;

    activeContent?: string;

    openedFiles?: string[];

    projectTree?: unknown;

}
