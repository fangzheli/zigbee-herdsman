import {describe, expect, it, vi} from "vitest";

import {BlzWatchdog} from "../../../../src/adapter/blz/driver/blzWatchdog";

describe("BLZ watchdog", () => {
    it("keeps the interval handler void and catches watchdog run failures", async () => {
        const error = vi.fn();
        const watchdog = new BlzWatchdog({
            periodSeconds: 30,
            maxFailures: 2,
            heartbeat: async () => {},
            isResetting: () => false,
            emitReset: () => {},
            debug: () => {
                throw new Error("debug failed");
            },
            error,
        });
        const handler = (watchdog as unknown as {handler: () => void}).handler;

        expect(handler()).toBeUndefined();

        await vi.waitFor(() => {
            expect(error).toHaveBeenCalledOnce();
        });
        expect(error.mock.calls[0][0]()).toContain("debug failed");
    });
});
