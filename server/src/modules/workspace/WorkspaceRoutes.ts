import { Router } from 'express';

import { WorkspaceController } from './WorkspaceController.js';



export function createWorkspaceRouter(
    controller: WorkspaceController,
): Router {


    const router =
        Router();



    router.get(
        '/tree',
        controller.getTree,
    );



    router.get(
        '/file',
        controller.getFile,
    );



    router.put(
        '/file',
        controller.saveFile,
    );



    router.post(
        '/file',
        controller.createFile,
    );



    router.post(
        '/folder',
        controller.createFolder,
    );


    router.delete(
        '/',
        controller.deletePath,
    );

    router.post(
        '/rename',
        controller.renamePath,
    );

    router.post(
        '/move',
        controller.movePath,
    );

    return router;

}