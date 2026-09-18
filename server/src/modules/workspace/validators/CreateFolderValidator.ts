import {
    Validator,
    ValidationResult,
} from '../../../core/validation/index.js';

import { CreateFolderDto } from '../dto/CreateFolderDto.js';

export class CreateFolderValidator
    extends Validator<CreateFolderDto> {

    public validate(
        data: unknown,
    ): ValidationResult<CreateFolderDto> {

        if (
            typeof data !== 'object' ||
            data === null
        ) {

            return this.failure(
                'Request body must be an object.',
            );

        }

        const dto =
            data as Partial<CreateFolderDto>;

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