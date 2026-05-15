interface Waiter<TPayload, TMatcher> {
    ID: number;
    resolve: (payload: TPayload) => void;
    reject: (error: Error) => void;
    promise: Promise<TPayload>;
    timer?: NodeJS.Timeout;
    resolved: boolean;
    started: boolean;
    timedout: boolean;
    matcher: TMatcher;
}

type Validator<TPayload, TMatcher> = (payload: TPayload, matcher: TMatcher) => boolean;
type TimeoutFormatter<TMatcher> = (matcher: TMatcher, timeout: number) => string;

function errorFromUnknown(error: unknown): Error {
    if (error instanceof Error) {
        return error;
    }

    try {
        return new Error(String(error), {cause: error});
    } catch {
        return new Error("<unprintable error>", {cause: error});
    }
}

export class Waitress<TPayload, TMatcher> {
    private waiters: Map<number, Waiter<TPayload, TMatcher>>;
    private readonly validator: Validator<TPayload, TMatcher>;
    private readonly timeoutFormatter: TimeoutFormatter<TMatcher>;
    private currentID: number;

    public constructor(validator: Validator<TPayload, TMatcher>, timeoutFormatter: TimeoutFormatter<TMatcher>) {
        this.waiters = new Map();
        this.timeoutFormatter = timeoutFormatter;
        this.validator = validator;
        this.currentID = 0;
    }

    public clear(error = new Error("Waitress cleared")): void {
        for (const [, waiter] of this.waiters) {
            clearTimeout(waiter.timer);
            this.rejectWaiter(waiter, error);
        }

        this.waiters.clear();
    }

    public resolve(payload: TPayload): boolean {
        return this.forEachMatching(payload, (waiter) => waiter.resolve(payload));
    }

    public reject(payload: TPayload, message: string): boolean {
        return this.forEachMatching(payload, (waiter) => this.rejectWaiter(waiter, new Error(message)));
    }

    public remove(id: number): void {
        const waiter = this.waiters.get(id);
        if (waiter) {
            if (!waiter.timedout && waiter.timer) {
                clearTimeout(waiter.timer);
            }

            this.rejectWaiter(waiter, new Error("Waitress removed"));
            this.waiters.delete(id);
        }
    }

    public waitFor(matcher: TMatcher, timeout: number): {ID: number; start: () => {promise: Promise<TPayload>; ID: number}} {
        this.currentID += 1;
        const ID = this.currentID;

        let resolvePromise!: (payload: TPayload) => void;
        let rejectPromise!: (error: Error) => void;
        const promise: Promise<TPayload> = new Promise((resolve, reject): void => {
            resolvePromise = resolve;
            rejectPromise = reject;
        });
        const object: Waiter<TPayload, TMatcher> = {
            matcher,
            resolve: resolvePromise,
            reject: rejectPromise,
            promise,
            timedout: false,
            resolved: false,
            started: false,
            ID,
        };
        this.waiters.set(ID, object);

        const start = (): {promise: Promise<TPayload>; ID: number} => {
            const waiter = this.waiters.get(ID);
            if (waiter && !waiter.resolved && !waiter.timer) {
                waiter.started = true;
                // Capture the stack trace from the caller of start()
                const error = new Error();
                Error.captureStackTrace(error);
                waiter.timer = setTimeout((): void => {
                    waiter.timedout = true;
                    try {
                        Object.defineProperty(error, "message", {
                            value: this.timeoutFormatter(matcher, timeout),
                            writable: true,
                            configurable: true,
                        });
                        waiter.reject(error);
                    } catch (formatError) {
                        waiter.reject(errorFromUnknown(formatError));
                    } finally {
                        this.waiters.delete(ID);
                    }
                }, timeout);
            }

            return {promise, ID};
        };

        return {ID, start};
    }

    private forEachMatching(payload: TPayload, action: (waiter: Waiter<TPayload, TMatcher>) => void): boolean {
        let foundMatching = false;
        for (const [index, waiter] of this.waiters.entries()) {
            if (waiter.timedout) {
                this.waiters.delete(index);
                continue;
            }

            let matches = false;
            try {
                matches = this.validator(payload, waiter.matcher);
            } catch (error) {
                clearTimeout(waiter.timer);
                this.waiters.delete(index);
                this.rejectWaiter(waiter, errorFromUnknown(error));
                continue;
            }

            if (matches) {
                clearTimeout(waiter.timer);
                waiter.resolved = true;
                this.waiters.delete(index);
                action(waiter);
                foundMatching = true;
            }
        }
        return foundMatching;
    }

    private rejectWaiter(waiter: Waiter<TPayload, TMatcher>, error: Error): void {
        waiter.reject(error);

        if (!waiter.started) {
            waiter.promise.catch(() => {});
        }
    }

    public count(): number {
        return this.waiters.size;
    }
}
