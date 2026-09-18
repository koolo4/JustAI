export interface WorkspaceNode {

    name: string;

    path: string;

    type: 'file' | 'folder';

    children?: WorkspaceNode[];

}



export interface WorkspaceEvent {

    type:
        | 'FILE_CREATED'
        | 'FILE_SAVED'
        | 'FILE_DELETED'
        | 'FILE_MOVED'
        | 'FILE_RENAMED';

    path?: string;

    oldPath?: string;

    newPath?: string;

    timestamp?: string;

}