import { ILogger } from './ILogger.js';

export class ConsoleLogger implements ILogger {

    public info(
        message: string,
    ): void {

        console.log(
            `[INFO] ${message}`,
        );

    }

    public warn(
        message: string,
    ): void {

        console.warn(
            `[WARN] ${message}`,
        );

    }

    public error(
        message: string,
    ): void {

        console.error(
            `[ERROR] ${message}`,
        );

    }

    public debug(
        message: string,
    ): void {

        console.debug(
            `[DEBUG] ${message}`,
        );

    }

}