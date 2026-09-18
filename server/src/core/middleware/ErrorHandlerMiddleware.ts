import type {
    NextFunction,
    Request,
    Response,
} from 'express';

import { AppError } from '../errors/AppError.js';

export class ErrorHandlerMiddleware {

    public handle(
        error: unknown,
        _: Request,
        res: Response,
        __: NextFunction,
    ): void {

        if (error instanceof AppError) {

            res.status(
                error.status,
            ).json({

                success: false,

                error: {

                    code: error.code,

                    message: error.message,

                },

            });

            return;

        }

        console.error(error);

        res.status(500).json({

            success: false,

            error: {

                code: 'INTERNAL_SERVER_ERROR',

                message: 'Internal server error.',

            },

        });

    }

}