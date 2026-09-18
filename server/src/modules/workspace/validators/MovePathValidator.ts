import {
    Validator,
    ValidationResult,
} from '../../../core/validation/index.js';

import { MovePathDto } from '../dto/MovePathDto.js';

export class MovePathValidator
    extends Validator<MovePathDto> {

    public validate(
        data: unknown,
    ): ValidationResult<MovePathDto> {

        if (
            typeof data !== 'object' ||
            data === null
        ) {

            return this.failure(
                'Request body must be an object.',
            );

        }

        const dto =
            data as Partial<MovePathDto>;

        const source =
            this.requiredString(
                dto.source,
                'source',
            );

        if (!source.success) {

            return source;

        }

        const destination =
            this.requiredString(
                dto.destination,
                'destination',
            );

        if (!destination.success) {

            return destination;

        }

        return this.success({

            source: source.value!,

            destination: destination.value!,

        });

    }

}