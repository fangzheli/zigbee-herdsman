import {afterEach, describe, expect, it, vi} from "vitest";
import {CancellableDelay} from "../../../../src/adapter/blz/driver/cancellableDelay";

describe("BLZ cancellable delay", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("resolves true when the delay expires while active", async () => {
        vi.useFakeTimers();
        const delay = new CancellableDelay();
        const wait = delay.wait(1000, () => true);
        expect(delay.count()).toBe(1);

        await vi.advanceTimersByTimeAsync(1000);

        await expect(wait).resolves.toBe(true);
        expect(delay.count()).toBe(0);
    });

    it("resolves false immediately when inactive", async () => {
        vi.useFakeTimers();
        const delay = new CancellableDelay();

        await expect(delay.wait(1000, () => false)).resolves.toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        expect(delay.count()).toBe(0);
    });

    it("resolves false when cancelled before the delay expires", async () => {
        vi.useFakeTimers();
        const delay = new CancellableDelay();
        const wait = delay.wait(1000, () => true);

        delay.cancel();

        await expect(wait).resolves.toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        expect(delay.count()).toBe(0);
    });

    it("rejects and releases waiters when the active guard throws at expiry", async () => {
        vi.useFakeTimers();
        const delay = new CancellableDelay();
        let activeChecks = 0;
        const wait = delay.wait(1000, () => {
            activeChecks += 1;
            if (activeChecks === 1) {
                return true;
            }
            throw new Error("guard failed");
        });
        const rejection = expect(wait).rejects.toThrow("guard failed");

        await vi.advanceTimersByTimeAsync(1000);

        await rejection;
        expect(delay.count()).toBe(0);
    });

    it("notifies active waiters before clearing the tracked set", () => {
        const delay = new CancellableDelay();
        const waiters = (delay as unknown as {waiters: Set<() => void>}).waiters;
        let sizeWhileCancelling = -1;
        const waiter = vi.fn(() => {
            sizeWhileCancelling = waiters.size;
        });

        waiters.add(waiter);

        delay.cancel();

        expect(waiter).toHaveBeenCalledOnce();
        expect(sizeWhileCancelling).toBe(1);
        expect(waiters.size).toBe(0);
    });
});
