import { Event } from './Event.js';

export interface IEventHandler<
    T extends Event,
> {

    handle(
        event: T,
    ): Promise<void>;

}