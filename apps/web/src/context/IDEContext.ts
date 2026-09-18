import type { WorkspaceNode } from "../types/workspace";

export interface IDEContext {

    projectTree: WorkspaceNode[];

    activeFile: string;

    activeContent: string;

    openedFiles: string[];

}