import { apiFetch } from "./http";

import type {
    WorkspaceNode,
} from '../types/workspace';





export async function fetchWorkspaceTree()
: Promise<WorkspaceNode[]> {

    const response =
        await apiFetch(
            `/workspace/tree`,
        );


    if (!response.ok) {

        throw new Error(
            'Failed to load workspace tree',
        );

    }


    return response.json();

}



export async function fetchWorkspaceFile(
    path: string,
) {

    const response =
        await apiFetch(
            `/workspace/file?path=${encodeURIComponent(path)}`,
        );


    if (!response.ok) {

        throw new Error(
            'Failed to load file',
        );

    }


    return response.json();

}



export async function saveWorkspaceFile(
    path: string,
    content: string,
): Promise<void> {


    const response =
        await apiFetch(
            `/workspace/file`,
            {

                method: 'PUT',

                headers: {

                    'Content-Type':
                        'application/json',

                },

                body: JSON.stringify({

                    path,

                    content,

                }),

            },
        );


    if (!response.ok) {

        throw new Error(
            'Failed to save file',
        );

    }

}