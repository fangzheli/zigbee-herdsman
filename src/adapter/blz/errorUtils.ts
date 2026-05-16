export function formatUnknownError(error: unknown): string {
    try {
        return String(error);
    } catch {
        return "<unprintable error>";
    }
}

export function formatErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        try {
            return error.message;
        } catch {
            // Fall through to the generic stringifier below.
        }
    }

    return formatUnknownError(error);
}

export function errorFromUnknown(error: unknown): Error {
    if (error instanceof Error) {
        return error;
    }

    return new Error(formatUnknownError(error), {cause: error});
}

export function errorFromUnknownWithSafeMessage(error: unknown): Error {
    if (error instanceof Error) {
        try {
            void error.message;
            return error;
        } catch {
            return new Error(formatErrorMessage(error), {cause: error});
        }
    }

    return new Error(formatErrorMessage(error), {cause: error});
}

export function formatLogMessage(message: () => string): string {
    try {
        return message();
    } catch (error) {
        return `Log message formatting failed: ${formatUnknownError(error)}`;
    }
}
