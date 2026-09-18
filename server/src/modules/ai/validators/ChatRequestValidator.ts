import {
    Validator,
    ValidationResult,
} from '../../../core/validation/index.js';

import { ChatRequestDto } from '../dto/ChatRequestDto.js';

export class ChatRequestValidator
    extends Validator<ChatRequestDto> {

    public validate(
        data: unknown,
    ): ValidationResult<ChatRequestDto> {

        if (
            typeof data !== 'object' ||
            data === null
        ) {
            return this.failure(
                'Request body must be an object.',
            );
        }

        const dto =
            data as Partial<ChatRequestDto>;

        const message =
            this.requiredString(
                dto.message,
                'message',
            );

        if (!message.success) {
            return this.failure(
                message.message!,
            );
        }

        if (
            dto.context === undefined
        ) {
            return this.success({
                message: message.value!,
            });
        }

        if (
            typeof dto.context !== 'object' ||
            dto.context === null
        ) {
            return this.failure(
                'Field "context" must be an object.',
            );
        }

        const context = dto.context as {
            path?: unknown;
            content?: unknown;
        };

        if (
            context.path !== undefined &&
            typeof context.path !== 'string'
        ) {
            return this.failure(
                'Field "context.path" must be a string.',
            );
        }

        if (
            context.content !== undefined &&
            typeof context.content !== 'string'
        ) {
            return this.failure(
                'Field "context.content" must be a string.',
            );
        }

        return this.success({
            message: message.value!,
            context: {
                path:
                    context.path as
                        | string
                        | undefined,
                content:
                    context.content as
                        | string
                        | undefined,
            },
        });

    }

}