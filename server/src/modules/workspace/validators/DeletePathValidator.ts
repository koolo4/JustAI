import {
    Validator,
    ValidationResult,
} from '../../../core/validation/index.js';

import { DeletePathDto } from '../dto/DeletePathDto.js';

export class DeletePathValidator
    extends Validator<DeletePathDto> {

    public validate(
        data: unknown,
    ): ValidationResult<DeletePathDto> {

        if (
            typeof data !== 'object' ||
            data === null
        ) {

            return this.failure(
                'Request body must be an object.',
            );

        }

        const dto =
            data as Partial<DeletePathDto>;

        const path =
            this.requiredString(
                dto.path,
                'path',
            );

        if (!path.success) {

            return path;

        }

        return this.success({

            path: path.value!,

        });

    }

}