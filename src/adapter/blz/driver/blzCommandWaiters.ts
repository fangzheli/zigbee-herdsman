import {WaitressBackedWaiters} from "../waitressBackedWaiters";
import {FRAME_NAMES_BY_ID} from "./commands";
import type {BLZFrameData} from "./frameData";

export interface BlzCommandFrame {
    sequence: number;
    frameId: number;
    frameName: string;
    payload: BLZFrameData;
}

export interface BlzCommandMatcher {
    frameId: number | string;
}

export interface BlzCommandWaiter {
    start: () => {promise: Promise<BlzCommandFrame>; ID: number};
    ID: number;
}

export function blzCommandWaitressValidator(payload: BlzCommandFrame, matcher: BlzCommandMatcher): boolean {
    if (typeof matcher.frameId === "string") {
        return payload.frameName === matcher.frameId;
    }

    const frameNames = FRAME_NAMES_BY_ID[matcher.frameId];
    return frameNames ? frameNames.includes(payload.frameName) : false;
}

function blzCommandWaitressTimeoutFormatter(matcher: BlzCommandMatcher, timeout: number): string {
    return `${JSON.stringify(matcher)} after ${timeout}ms`;
}

export class BlzCommandWaiters {
    private readonly waiters = new WaitressBackedWaiters<BlzCommandFrame, BlzCommandMatcher>(
        blzCommandWaitressValidator,
        blzCommandWaitressTimeoutFormatter,
    );

    public waitFor(frameId: string | number, timeout = 10000): BlzCommandWaiter {
        return this.waiters.waitFor({frameId}, timeout);
    }

    public resolve(frame: BlzCommandFrame): boolean {
        return this.waiters.resolve(frame);
    }

    public cancel(waiter: BlzCommandWaiter | undefined): void {
        this.waiters.cancel(waiter);
    }

    public clear(error: Error): void {
        this.waiters.clear(error);
    }

    public count(): number {
        return this.waiters.count();
    }

    public matches(payload: BlzCommandFrame, matcher: BlzCommandMatcher): boolean {
        return this.waiters.matches(payload, matcher);
    }
}
