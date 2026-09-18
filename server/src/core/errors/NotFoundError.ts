import { AppError } from './AppError.js';

export class NotFoundError extends AppError {

    constructor(
        message = 'Not found.',
    ) {

        super(
            message,
            404,
            'NOT_FOUND',
        );

    }

}