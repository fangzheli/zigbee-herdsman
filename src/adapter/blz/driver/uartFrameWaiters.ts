import {Waitress} from "../../../utils";

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
    private readonly waitress = new Waitress<UartFrame, UartFrameMatcher>(uartFrameWaitressValidator, uartFrameWaitressTimeoutFormatter);

    public waitFor(frameId: number, timeout = 3000): UartFrameWaiter {
        return this.waitress.waitFor({frameId}, timeout);
    }

    public resolve(frameId: number): boolean {
        return this.waitress.resolve({frameId});
    }

    public cancel(waiter: UartFrameWaiter | undefined): void {
        if (waiter) {
            this.waitress.remove(waiter.ID);
        }
    }

    public clear(error: Error): void {
        this.waitress.clear(error);
    }

    public count(): number {
        return this.waitress.count();
    }
}
