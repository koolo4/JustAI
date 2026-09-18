import { Event } from '../Event.js';

export class FileCreatedEvent extends Event {

    constructor(
        public readonly path: string,
    ) {

        super();

    }

}