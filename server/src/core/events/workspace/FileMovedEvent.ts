import { Event } from '../Event.js';

export class FileMovedEvent extends Event {

    constructor(
        public readonly source: string,
        public readonly destination: string,
    ) {

        super();

    }

}