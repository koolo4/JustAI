import { Event } from '../Event.js';

export class FileDeletedEvent extends Event {

    constructor(
        public readonly path: string,
    ) {

        super();

    }

}