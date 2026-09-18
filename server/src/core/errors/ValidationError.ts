import { BadRequestError } from './BadRequestError.js';

export class ValidationError extends BadRequestError {

    constructor(
        message: string,
    ) {

        super(message);

        this.name = 'ValidationError';

    }

}