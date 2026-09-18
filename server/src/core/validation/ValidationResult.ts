export type ValidationResult<T> =
    | {
        success: true;
        value: T;
    }
    | {
        success: false;
        message: string;
    };