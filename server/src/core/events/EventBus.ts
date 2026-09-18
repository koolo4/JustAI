import { Event } from './Event.js';
import { IEventHandler } from './IEventHandler.js';

export class EventBus {

    private readonly handlers =
        new Map<
            string,
            IEventHandler<any>[]
        >();

    public subscribe<T extends Event>(
        event: new (...args: any[]) => T,
        handler: IEventHandler<T>,
    ): void {

        const key =
            event.name;

        if (
            !this.handlers.has(
                key,
            )
        ) {

            this.handlers.set(
                key,
                [],
            );

        }

        this.handlers
            .get(key)!
            .push(handler);

    }

    public async publish<T extends Event>(
        event: T,
    ): Promise<void> {

        const handlers =
            this.handlers.get(
                event.constructor.name,
            );

        if (!handlers) {

            return;

        }

        for (
            const handler
            of handlers
        ) {

            await handler.handle(
                event,
            );

        }

    }

}