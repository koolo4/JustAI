import {
    Validator,
    ValidationResult,
} from '../../../core/validation/index.js';

import { SaveFileDto } from '../dto/SaveFileDto.js';

export class SaveFileValidator
    extends Validator<SaveFileDto> {

    public validate(
        data: unknown,
    ): ValidationResult<SaveFileDto> {

        if (
            typeof data !== 'object' ||
            data === null
        ) {

            return this.failure(
                'Request body must be an object.',
            );

        }

        const dto =
            data as Partial<SaveFileDto>;

        const path =
            this.requiredString(
                dto.path,
                'path',
            );

        if (!path.success) {

            return path;

        }

        const content =
            this.requiredString(
                dto.content,
                'content',
            );

        if (!content.success) {

            return content;

        }

        return this.success({

            path: path.value!,

            content: content.value!,

        });

    }

}