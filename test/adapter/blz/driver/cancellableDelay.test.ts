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

        await vi.advanceTimersByTimeAsync(1000);

        await expect(wait).resolves.toBe(true);
    });

    it("resolves false immediately when inactive", async () => {
        vi.useFakeTimers();
        const delay = new CancellableDelay();

        await expect(delay.wait(1000, () => false)).resolves.toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("resolves false when cancelled before the delay expires", async () => {
        vi.useFakeTimers();
        const delay = new CancellableDelay();
        const wait = delay.wait(1000, () => true);

        delay.cancel();

        await expect(wait).resolves.toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });
});
