import {Waitress} from "../../utils";

type WaitressWaiter<TPayload> = ReturnType<Waitress<TPayload, unknown>["waitFor"]>;

export interface WaitressBackedCancellableWaiter<TPayload> {
    start: () => {promise: Promise<TPayload>; ID: number};
    cancel: () => void;
}

export class WaitressBackedWaiters<TPayload, TMatcher> {
    private readonly waitress: Waitress<TPayload, TMatcher>;

    public constructor(
        private readonly validator: (payload: TPayload, matcher: TMatcher) => boolean,
        timeoutFormatter: (matcher: TMatcher, timeout: number) => string,
    ) {
        this.waitress = new Waitress<TPayload, TMatcher>(validator, timeoutFormatter);
    }

    public waitFor(matcher: TMatcher, timeout: number): WaitressWaiter<TPayload> {
        return this.waitress.waitFor(matcher, timeout);
    }

    public waitForCancellable(matcher: TMatcher, timeout: number): WaitressBackedCancellableWaiter<TPayload> {
        const waiter = this.waitress.waitFor(matcher, timeout);

        return {
            start: waiter.start,
            cancel: (): void => this.waitress.remove(waiter.ID),
        };
    }

    public resolve(payload: TPayload): boolean {
        return this.waitress.resolve(payload);
    }

    public cancel(waiter: {ID: number} | {cancel: () => void} | null | undefined): void {
        if (!waiter) {
            return;
        }

        if ("cancel" in waiter) {
            waiter.cancel();
            return;
        }

        this.waitress.remove(waiter.ID);
    }

    public clear(error: Error): void {
        this.waitress.clear(error);
    }

    public count(): number {
        return this.waitress.count();
    }

    public matches(payload: TPayload, matcher: TMatcher): boolean {
        return this.validator(payload, matcher);
    }
}
