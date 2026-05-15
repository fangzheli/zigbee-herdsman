import {describe, expect, it} from "vitest";

import {WaitressBackedWaiters} from "../../../src/adapter/blz/waitressBackedWaiters";

interface Payload {
    id: number;
    value: string;
}

interface Matcher {
    id: number;
}

describe("BLZ waitress-backed waiters", () => {
    it("wraps Waitress matching, resolving, cancellation, and cleanup", async () => {
        const waiters = makeWaiters();
        const waiter = waiters.waitFor({id: 1}, 1000);
        const started = waiter.start();

        expect(waiters.count()).toBe(1);
        expect(waiters.resolve({id: 2, value: "wrong"})).toBe(false);
        expect(waiters.resolve({id: 1, value: "ok"})).toBe(true);

        await expect(started.promise).resolves.toEqual({id: 1, value: "ok"});
        expect(waiters.count()).toBe(0);
    });

    it("cancels unstarted waiters without leaving tracked state", () => {
        const waiters = makeWaiters();
        const waiter = waiters.waitFor({id: 1}, 1000);

        expect(waiters.count()).toBe(1);

        waiters.cancel(waiter);
        waiters.cancel(undefined);

        expect(waiters.count()).toBe(0);
    });

    it("creates self-cancelling waiters for adapter-style consumers", () => {
        const waiters = makeWaiters();
        const waiter = waiters.waitForCancellable({id: 1}, 1000);

        expect(waiters.count()).toBe(1);

        waiter.cancel();

        expect(waiters.count()).toBe(0);
    });

    it("exposes matcher checks without allocating a waiter", () => {
        const waiters = makeWaiters();

        expect(waiters.matches({id: 1, value: "ok"}, {id: 1})).toBe(true);
        expect(waiters.matches({id: 2, value: "wrong"}, {id: 1})).toBe(false);
        expect(waiters.count()).toBe(0);
    });

    it("clears tracked waiters with the provided error", async () => {
        const waiters = makeWaiters();
        const error = new Error("stopped");
        const waiter = waiters.waitFor({id: 1}, 1000);
        const started = waiter.start();

        waiters.clear(error);

        await expect(started.promise).rejects.toBe(error);
        expect(waiters.count()).toBe(0);
    });
});

function makeWaiters(): WaitressBackedWaiters<Payload, Matcher> {
    return new WaitressBackedWaiters(
        (payload, matcher) => payload.id === matcher.id,
        (matcher, timeout) => `${JSON.stringify(matcher)} after ${timeout}ms`,
    );
}
