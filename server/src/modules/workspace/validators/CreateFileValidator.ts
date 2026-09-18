import {
    Validator,
    ValidationResult,
} from '../../../core/validation/index.js';

import { CreateFileDto } from '../dto/CreateFileDto.js';

export class CreateFileValidator
    extends Validator<CreateFileDto> {

    public validate(
        data: unknown,
    ): ValidationResult<CreateFileDto> {

        if (
            typeof data !== 'object' ||
            data === null
        ) {

            return this.failure(
                'Request body must be an object.',
            );

        }

        const dto =
            data as Partial<CreateFileDto>;

        const path =
            this.requiredString(
                dto.path,
                'path',
            );

        if (!path.success) {

            return path;

        }

        const content =
            this.optionalString(
                dto.content,
                'content',
            );

        if (!content.success) {

            return content;

        }

        return this.success({

            path: path.value!,

            content: content.value,

        });

    }

}