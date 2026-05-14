import {afterEach, describe, expect, it, vi} from "vitest";
import {CancellableOperation} from "../../../../src/adapter/blz/driver/cancellableOperation";

describe("BLZ cancellable operation", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("resolves the operation result and removes the active rejecter", async () => {
        const operations = new CancellableOperation();

        await expect(operations.run(async () => "ok")).resolves.toBe("ok");

        expect(operations.count()).toBe(0);
    });

    it("rejects immediately when inactive without starting the operation", async () => {
        const operations = new CancellableOperation();
        const operation = vi.fn().mockResolvedValue("ok");

        await expect(
            operations.run(operation, () => false, () => new Error("stopped")),
        ).rejects.toThrow("stopped");

        expect(operation).not.toHaveBeenCalled();
        expect(operations.count()).toBe(0);
    });

    it("rejects all active operations when cancelled", async () => {
        vi.useFakeTimers();
        const operations = new CancellableOperation();
        const first = operations.run(() => new Promise(() => {}));
        const second = operations.run(() => new Promise(() => {}));

        await vi.advanceTimersByTimeAsync(0);
        expect(operations.count()).toBe(2);

        operations.cancel(new Error("cancelled"));
        await vi.advanceTimersByTimeAsync(0);

        await expect(first).rejects.toThrow("cancelled");
        await expect(second).rejects.toThrow("cancelled");
        expect(operations.count()).toBe(0);
    });

    it("removes the active rejecter when the operation rejects normally", async () => {
        const operations = new CancellableOperation();

        await expect(
            operations.run(async () => {
                throw new Error("failed");
            }),
        ).rejects.toThrow("failed");

        expect(operations.count()).toBe(0);
    });
});
