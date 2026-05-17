import {CallbackRegistry} from "./callbackRegistry";

export class CancellableOperation {
    private readonly rejecters = new CallbackRegistry<(error: Error) => void>();

    public cancel(error: Error): void {
        this.rejecters.notify((reject) => {
            reject(error);
        });
    }

    public run<T>(
        operation: () => Promise<T>,
        isActive: () => boolean = () => true,
        createInactiveError: () => Error = () => new Error("Operation cancelled"),
    ): Promise<T> {
        const run = this.runInternal(operation, isActive, createInactiveError);
        run.catch(() => {});

        return run;
    }

    private async runInternal<T>(operation: () => Promise<T>, isActive: () => boolean, createInactiveError: () => Error): Promise<T> {
        if (!isActive()) {
            throw createInactiveError();
        }

        let rejectOperation: ((error: Error) => void) | undefined;
        const operationCancelled = new Promise<never>((_, reject): void => {
            rejectOperation = reject;
            this.rejecters.add(reject);
        });

        try {
            const result = await Promise.race([operation(), operationCancelled]);

            if (!isActive()) {
                throw createInactiveError();
            }

            return result;
        } finally {
            if (rejectOperation) {
                this.rejecters.delete(rejectOperation);
            }
        }
    }

    public count(): number {
        return this.rejecters.count();
    }
}
