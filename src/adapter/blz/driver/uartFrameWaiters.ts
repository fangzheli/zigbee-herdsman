import {WaitressBackedWaiters} from "../waitressBackedWaiters";

interface UartFrame {
    frameId: number;
}

interface UartFrameMatcher {
    frameId: number;
}

export interface UartFrameWaiter {
    start: () => {promise: Promise<UartFrame>; ID: number};
    ID: number;
}

function uartFrameWaitressValidator(payload: UartFrame, matcher: UartFrameMatcher): boolean {
    return payload.frameId === matcher.frameId;
}

function uartFrameWaitressTimeoutFormatter(matcher: UartFrameMatcher, timeout: number): string {
    return `${JSON.stringify(matcher)} after ${timeout}ms`;
}

export class UartFrameWaiters {
    private readonly waiters = new WaitressBackedWaiters<UartFrame, UartFrameMatcher>(uartFrameWaitressValidator, uartFrameWaitressTimeoutFormatter);

    public waitFor(frameId: number, timeout = 3000): UartFrameWaiter {
        return this.waiters.waitFor({frameId}, timeout);
    }

    public resolve(frameId: number): boolean {
        return this.waiters.resolve({frameId});
    }

    public cancel(waiter: UartFrameWaiter | undefined): void {
        this.waiters.cancel(waiter);
    }

    public clear(error: Error): void {
        this.waiters.clear(error);
    }

    public count(): number {
        return this.waiters.count();
    }
}
