import { Event } from '../Event.js';

export class FileRenamedEvent extends Event {

    constructor(
        public readonly oldPath: string,
        public readonly newPath: string,
    ) {

        super();

    }

}