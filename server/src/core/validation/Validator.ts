import { ValidationResult } from './ValidationResult.js';

export abstract class Validator<T> {

    public abstract validate(
        data: unknown,
    ): ValidationResult<T>;

    protected success<V>(
        value: V,
    ): ValidationResult<V> {

        return {

            success: true,

            value,

        };

    }

    protected failure<V>(
        message: string,
    ): ValidationResult<V> {

        return {

            success: false,

            message,

        };

    }

    protected requiredString(

        value: unknown,

        field: string,

    ): ValidationResult<string> {

        if (

            typeof value !== 'string'

        ) {

            return this.failure(

                `Field "${field}" must be a string.`,

            );

        }

        if (

            value.trim() === ''

        ) {

            return this.failure(

                `Field "${field}" cannot be empty.`,

            );

        }

        return this.success(

            value,

        );

    }

    protected optionalString(

        value: unknown,

        field: string,

    ): ValidationResult<string | undefined> {

        if (

            value === undefined

        ) {

            return this.success(

                undefined,

            );

        }

        if (

            typeof value !== 'string'

        ) {

            return this.failure(

                `Field "${field}" must be a string.`,

            );

        }

        return this.success(

            value,

        );

    }

}