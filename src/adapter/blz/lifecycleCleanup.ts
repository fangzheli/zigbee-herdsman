type CleanupStep = () => void;
type AsyncCleanupStep = () => void | Promise<void>;

export function collectCleanupErrors(steps: readonly CleanupStep[]): unknown[] {
    const errors: unknown[] = [];

    for (const step of steps) {
        try {
            step();
        } catch (error) {
            errors.push(error);
        }
    }

    return errors;
}

export function throwCollectedErrors(errors: readonly unknown[], message: string): void {
    if (errors.length === 1) {
        throw errors[0];
    }

    if (errors.length > 1) {
        throw new AggregateError(errors, message);
    }
}

export function runCleanupSteps(steps: readonly CleanupStep[]): void {
    throwCollectedErrors(collectCleanupErrors(steps), "Multiple cleanup steps failed");
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

    throwCollectedErrors(errors, "Multiple cleanup steps failed");
}
