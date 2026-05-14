import {afterEach, describe, expect, it, vi} from "vitest";

import {Driver} from "../../../../src/adapter/blz/driver/driver";
import type {NetworkOptions, SerialPortOptions} from "../../../../src/adapter/tstype";

describe("BLZ high-level driver lifecycle", () => {
    const networkOptions: NetworkOptions = {
        networkKey: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
        panID: 0x1234,
        extendedPanID: [1, 2, 3, 4, 5, 6, 7, 8],
        channelList: [11],
    };

    const serialPortOptions: SerialPortOptions = {
        path: "/dev/ttyUSB0",
        baudRate: 2000000,
        rtscts: false,
    };

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("clears pending waiters even when BLZ close rejects", async () => {
        vi.useFakeTimers();
        const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const waiter = driver.waitFor(0x1234, 0x8000, 1000);
        waiter.start();

        (driver as unknown as {blz: {removeAllListeners: () => void; close: () => Promise<void>}}).blz = {
            removeAllListeners: vi.fn(),
            close: vi.fn().mockRejectedValue(new Error("close failed")),
        };

        await expect(driver.stop()).rejects.toThrow("close failed");

        expect(clearTimeoutSpy).toHaveBeenCalled();
    });
});
