import { IEventHandler } from '../IEventHandler.js';

import { FileCreatedEvent } from './FileCreatedEvent.js';
import { FileSavedEvent } from './FileSavedEvent.js';
import { FileDeletedEvent } from './FileDeletedEvent.js';
import { FileMovedEvent } from './FileMovedEvent.js';
import { FileRenamedEvent } from './FileRenamedEvent.js';

export class WorkspaceLogger
    implements
        IEventHandler<FileCreatedEvent>,
        IEventHandler<FileSavedEvent>,
        IEventHandler<FileDeletedEvent>,
        IEventHandler<FileMovedEvent>,
        IEventHandler<FileRenamedEvent> {

    public async handle(
        event:
            | FileCreatedEvent
            | FileSavedEvent
            | FileDeletedEvent
            | FileMovedEvent
            | FileRenamedEvent,
    ): Promise<void> {

        if (event instanceof FileCreatedEvent) {

            console.log(
                `[Workspace] File created: ${event.path}`,
            );

            return;

        }

        if (event instanceof FileSavedEvent) {

            console.log(
                `[Workspace] File saved: ${event.path}`,
            );

            return;

        }

        if (event instanceof FileDeletedEvent) {

            console.log(
                `[Workspace] File deleted: ${event.path}`,
            );

            return;

        }

        if (event instanceof FileRenamedEvent) {

            console.log(
                `[Workspace] File renamed: ${event.oldPath} -> ${event.newPath}`,
            );

            return;

        }

        if (event instanceof FileMovedEvent) {

            console.log(
                `[Workspace] File moved: ${event.source} -> ${event.destination}`,
            );

        }

    }

}