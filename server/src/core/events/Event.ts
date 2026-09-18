export abstract class Event {

    public readonly timestamp: Date;

    constructor() {

        this.timestamp = new Date();

    }

}