import {logger} from "../../../utils/logger";
import type {GenericZdoResponse} from "../../../zspec/zdo/definition/tstypes";
import {normalizeIeeeAddress} from "../ieee";
import {WaitressBackedWaiters} from "../waitressBackedWaiters";
import type {BlzApsFrame} from "./types/struct";

const NS = "zh:blz:driv";

export interface ZdoResponseFrame {
    address: number | string;
    payload: Buffer;
    frame: BlzApsFrame;
    zdoResponse?: GenericZdoResponse;
}

export interface ZdoResponseMatcher {
    address: number | string;
    clusterId: number;
}

export interface ZdoResponseWaiter {
    start: () => {promise: Promise<ZdoResponseFrame>};
    cancel: () => void;
}

function addressesMatch(left: number | string, right: number | string): boolean {
    if (typeof left === "string" && typeof right === "string") {
        return normalizeIeeeAddress(left) === normalizeIeeeAddress(right);
    }

    return left === right;
}

export function zdoResponseWaitressValidator(payload: ZdoResponseFrame, matcher: ZdoResponseMatcher): boolean {
    logger.debug(
        () =>
            `waitressValidator: payload.address=${payload.address}, matcher.address=${matcher.address}, payload.frame.clusterId=${payload.frame?.clusterId}, matcher.clusterId=${matcher.clusterId}`,
        NS,
    );
    return addressesMatch(payload.address, matcher.address) && payload.frame.clusterId === matcher.clusterId;
}

function zdoResponseWaitressTimeoutFormatter(matcher: ZdoResponseMatcher, timeout: number): string {
    return `${JSON.stringify(matcher)} after ${timeout}ms`;
}

export class ZdoResponseWaiters {
    private readonly waiters = new WaitressBackedWaiters<ZdoResponseFrame, ZdoResponseMatcher>(
        zdoResponseWaitressValidator,
        zdoResponseWaitressTimeoutFormatter,
    );

    public waitFor(address: number | string, clusterId: number, timeout = 10000): ZdoResponseWaiter {
        return this.waiters.waitForCancellable({address, clusterId}, timeout);
    }

    public resolve(frame: ZdoResponseFrame): boolean {
        return this.waiters.resolve(frame);
    }

    public cancel(waiter: ZdoResponseWaiter | undefined): void {
        this.waiters.cancel(waiter);
    }

    public clear(error: Error): void {
        this.waiters.clear(error);
    }

    public count(): number {
        return this.waiters.count();
    }

    public matches(payload: ZdoResponseFrame, matcher: ZdoResponseMatcher): boolean {
        return this.waiters.matches(payload, matcher);
    }
}
