import type {
    WorkspaceNode,
} from '../types/workspace';


const API_URL =
    `${import.meta.env.VITE_API_URL ?? 'http://localhost:4302/api'}/workspace`;



export async function fetchWorkspaceTree()
: Promise<WorkspaceNode[]> {

    const response =
        await fetch(
            `${API_URL}/tree`,
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
        await fetch(
            `${API_URL}/file?path=${encodeURIComponent(path)}`,
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
        await fetch(
            `${API_URL}/file`,
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