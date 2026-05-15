type CleanupStep = () => void;
type AsyncCleanupStep = () => void | Promise<void>;

function captureFirstError(state: {firstError: unknown; hasError: boolean}, error: unknown): void {
    if (!state.hasError) {
        state.firstError = error;
        state.hasError = true;
    }
}

export function runCleanupSteps(steps: readonly CleanupStep[]): void {
    const errorState = {firstError: undefined as unknown, hasError: false};

    for (const step of steps) {
        try {
            step();
        } catch (error) {
            captureFirstError(errorState, error);
        }
    }

    if (errorState.hasError) {
        throw errorState.firstError;
    }
}

export async function runAsyncCleanupSteps(steps: readonly AsyncCleanupStep[]): Promise<void> {
    const errorState = {firstError: undefined as unknown, hasError: false};

    for (const step of steps) {
        try {
            await step();
        } catch (error) {
            captureFirstError(errorState, error);
        }
    }

    if (errorState.hasError) {
        throw errorState.firstError;
    }
}
