import { IEventHandler } from '../IEventHandler.js';
import { FileCreatedEvent } from './FileCreatedEvent.js';

export class FileCreatedLogger
    implements IEventHandler<FileCreatedEvent> {

    public async handle(
        event: FileCreatedEvent,
    ): Promise<void> {

        console.log(
            `[Workspace] File created: ${event.path}`,
        );

    }

}