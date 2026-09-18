import {
    Validator,
    ValidationResult,
} from '../../../core/validation/index.js';

import { RenamePathDto } from '../dto/RenamePathDto.js';

export class RenamePathValidator
    extends Validator<RenamePathDto> {

    public validate(
        data: unknown,
    ): ValidationResult<RenamePathDto> {

        if (
            typeof data !== 'object' ||
            data === null
        ) {

            return this.failure(
                'Request body must be an object.',
            );

        }

        const dto =
            data as Partial<RenamePathDto>;

        const oldPath =
            this.requiredString(
                dto.oldPath,
                'oldPath',
            );

        if (!oldPath.success) {

            return oldPath;

        }

        const newPath =
            this.requiredString(
                dto.newPath,
                'newPath',
            );

        if (!newPath.success) {

            return newPath;

        }

        return this.success({

            oldPath: oldPath.value!,

            newPath: newPath.value!,

        });

    }

}