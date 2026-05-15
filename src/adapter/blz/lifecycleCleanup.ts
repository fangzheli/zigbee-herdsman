type CleanupStep = () => void;
type AsyncCleanupStep = () => void | Promise<void>;

function throwCleanupErrors(errors: readonly unknown[]): void {
    if (errors.length === 1) {
        throw errors[0];
    }

    if (errors.length > 1) {
        throw new AggregateError(errors, "Multiple cleanup steps failed");
    }
}

export function runCleanupSteps(steps: readonly CleanupStep[]): void {
    const errors: unknown[] = [];

    for (const step of steps) {
        try {
            step();
        } catch (error) {
            errors.push(error);
        }
    }

    throwCleanupErrors(errors);
}

export async function runAsyncCleanupSteps(steps: readonly AsyncCleanupStep[]): Promise<void> {
    const errors: unknown[] = [];

    for (const step of steps) {
        try {
            await step();
        } catch (error) {
            errors.push(error);
        }
    }

    throwCleanupErrors(errors);
}
