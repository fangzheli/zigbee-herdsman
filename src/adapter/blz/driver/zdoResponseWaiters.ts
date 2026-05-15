import {Waitress} from "../../../utils";
import {logger} from "../../../utils/logger";
import type {GenericZdoResponse} from "../../../zspec/zdo/definition/tstypes";
import {normalizeIeeeAddress} from "../ieee";
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
    private readonly waitress = new Waitress<ZdoResponseFrame, ZdoResponseMatcher>(zdoResponseWaitressValidator, zdoResponseWaitressTimeoutFormatter);

    public waitFor(address: number | string, clusterId: number, timeout = 10000): ZdoResponseWaiter {
        const waiter = this.waitress.waitFor({address, clusterId}, timeout);
        const cancel = (): void => this.waitress.remove(waiter.ID);

        return {start: waiter.start, cancel};
    }

    public resolve(frame: ZdoResponseFrame): boolean {
        return this.waitress.resolve(frame);
    }

    public cancel(waiter: ZdoResponseWaiter | undefined): void {
        waiter?.cancel();
    }

    public clear(error: Error): void {
        this.waitress.clear(error);
    }

    public count(): number {
        return this.waitress.count();
    }

    public matches(payload: ZdoResponseFrame, matcher: ZdoResponseMatcher): boolean {
        return zdoResponseWaitressValidator(payload, matcher);
    }
}
