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

interface WaiterHandle<TPayload> {
    ID: number;
    start: () => {promise: Promise<TPayload>; ID: number};
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

class WaiterRegistry<TPayload, TMatcher> {
    private readonly waiters = new Map<number, Waiter<TPayload, TMatcher>>();
    private currentID = 0;

    public constructor(
        private readonly validator: Validator<TPayload, TMatcher>,
        private readonly timeoutFormatter: TimeoutFormatter<TMatcher>,
    ) {}

    public waitFor(matcher: TMatcher, timeout: number): WaiterHandle<TPayload> {
        this.currentID += 1;
        const ID = this.currentID;

        let resolvePromise!: (payload: TPayload) => void;
        let rejectPromise!: (error: Error) => void;
        const promise = new Promise<TPayload>((resolve, reject): void => {
            resolvePromise = resolve;
            rejectPromise = reject;
        });
        const waiter: Waiter<TPayload, TMatcher> = {
            matcher,
            resolve: resolvePromise,
            reject: rejectPromise,
            promise,
            timedout: false,
            resolved: false,
            started: false,
            ID,
        };
        this.waiters.set(ID, waiter);

        const start = (): {promise: Promise<TPayload>; ID: number} => {
            const pending = this.waiters.get(ID);
            if (pending && !pending.resolved && !pending.timer) {
                pending.started = true;
                const error = new Error();
                Error.captureStackTrace(error);
                pending.timer = setTimeout((): void => {
                    pending.timedout = true;
                    try {
                        Object.defineProperty(error, "message", {
                            value: this.timeoutFormatter(matcher, timeout),
                            writable: true,
                            configurable: true,
                        });
                        pending.reject(error);
                    } catch (formatError) {
                        pending.reject(errorFromUnknown(formatError));
                    } finally {
                        this.waiters.delete(ID);
                    }
                }, timeout);
            }

            return {promise, ID};
        };

        return {ID, start};
    }

    public resolve(payload: TPayload): boolean {
        return this.forEachMatching(payload, (waiter) => waiter.resolve(payload));
    }

    public remove(id: number): void {
        const waiter = this.waiters.get(id);
        if (!waiter) {
            return;
        }

        if (!waiter.timedout && waiter.timer) {
            clearTimeout(waiter.timer);
        }

        this.rejectWaiter(waiter, new Error("Waitress removed"));
        this.waiters.delete(id);
    }

    public clear(error: Error): void {
        for (const waiter of this.waiters.values()) {
            clearTimeout(waiter.timer);
            this.rejectWaiter(waiter, error);
        }

        this.waiters.clear();
    }

    public count(): number {
        return this.waiters.size;
    }

    private forEachMatching(payload: TPayload, action: (waiter: Waiter<TPayload, TMatcher>) => void): boolean {
        let foundMatching = false;
        for (const [ID, waiter] of this.waiters.entries()) {
            if (waiter.timedout) {
                this.waiters.delete(ID);
                continue;
            }

            let matches = false;
            try {
                matches = this.validator(payload, waiter.matcher);
            } catch (error) {
                clearTimeout(waiter.timer);
                this.waiters.delete(ID);
                this.rejectWaiter(waiter, errorFromUnknown(error));
                continue;
            }

            if (matches) {
                clearTimeout(waiter.timer);
                waiter.resolved = true;
                this.waiters.delete(ID);
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
}

export interface WaitressBackedCancellableWaiter<TPayload> {
    start: () => {promise: Promise<TPayload>; ID: number};
    cancel: () => void;
}

export class WaitressBackedWaiters<TPayload, TMatcher> {
    private readonly waiters: WaiterRegistry<TPayload, TMatcher>;

    public constructor(
        private readonly validator: (payload: TPayload, matcher: TMatcher) => boolean,
        timeoutFormatter: (matcher: TMatcher, timeout: number) => string,
    ) {
        this.waiters = new WaiterRegistry<TPayload, TMatcher>(validator, timeoutFormatter);
    }

    public waitFor(matcher: TMatcher, timeout: number): WaiterHandle<TPayload> {
        return this.waiters.waitFor(matcher, timeout);
    }

    public waitForCancellable(matcher: TMatcher, timeout: number): WaitressBackedCancellableWaiter<TPayload> {
        const waiter = this.waiters.waitFor(matcher, timeout);

        return {
            start: waiter.start,
            cancel: (): void => this.waiters.remove(waiter.ID),
        };
    }

    public resolve(payload: TPayload): boolean {
        return this.waiters.resolve(payload);
    }

    public cancel(waiter: {ID: number} | {cancel: () => void} | null | undefined): void {
        if (!waiter) {
            return;
        }

        if ("cancel" in waiter) {
            waiter.cancel();
            return;
        }

        this.waiters.remove(waiter.ID);
    }

    public clear(error: Error): void {
        this.waiters.clear(error);
    }

    public count(): number {
        return this.waiters.count();
    }

    public matches(payload: TPayload, matcher: TMatcher): boolean {
        return this.validator(payload, matcher);
    }
}
