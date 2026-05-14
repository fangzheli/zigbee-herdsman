import {afterEach, describe, expect, it, vi} from "vitest";

const blzConstructorMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../src/adapter/blz/driver/blz", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../../src/adapter/blz/driver/blz")>();

    return {
        ...actual,
        Blz: blzConstructorMock,
    };
});

import type {BLZFrameData} from "../../../../src/adapter/blz/driver/blz";
import {Driver} from "../../../../src/adapter/blz/driver/driver";
import {BlzEUI64, BlzOutgoingMessageType, BlzStatus, BlzValueId} from "../../../../src/adapter/blz/driver/types";
import {BlzApsFrame} from "../../../../src/adapter/blz/driver/types/struct";
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
        blzConstructorMock.mockReset();
        vi.restoreAllMocks();
    });

    function makeDriverWithApsSender(sendApsData: ReturnType<typeof vi.fn>): Driver {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        driver.blz = {sendApsData} as unknown as Driver["blz"];

        return driver;
    }

    function makeApsFrame(): BlzApsFrame {
        const apsFrame = new BlzApsFrame();
        apsFrame.profileId = 0x0104;
        apsFrame.clusterId = 0x0006;
        apsFrame.sourceEndpoint = 1;
        apsFrame.destinationEndpoint = 2;
        apsFrame.groupId = 0x1234;
        apsFrame.sequence = 0x7f;

        return apsFrame;
    }

    function makeIncomingApsFrame(srcShortAddr: number): BLZFrameData {
        return {
            profileId: 0x0104,
            clusterId: 0x0006,
            srcShortAddr,
            dstShortAddr: 0x0000,
            srcEp: 1,
            dstEp: 1,
            msgType: 0,
            lqi: 255,
            rssi: -40,
            message: Buffer.from([0x18, 0x01, 0x0a]),
        } as BLZFrameData;
    }

    it("clears pending waiters even when BLZ close rejects", async () => {
        vi.useFakeTimers();
        const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const waiter = driver.waitFor(0x1234, 0x8000, 1000);
        const waiterResult = waiter.start().promise.catch((error: Error) => error);

        (driver as unknown as {blz: {off: () => void; close: () => Promise<void>}}).blz = {
            off: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockRejectedValue(new Error("close failed")),
        };

        await expect(driver.stop()).rejects.toThrow("close failed");

        expect(clearTimeoutSpy).toHaveBeenCalled();
        await expect(waiterResult).resolves.toEqual(new Error("Waitress cleared"));
        expect((driver as unknown as {blz?: unknown}).blz).toBeUndefined();
    });

    it("handles waiter cancellation before waiters start", () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const waiter = driver.waitFor(0x1234, 0x8000, 1000);

        waiter.cancel();
    });

    it("clears address cache when stopping", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        driver.handleNodeJoined(0x3344, 0x1111);
        driver.blz = {
            off: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        } as unknown as Driver["blz"];

        await driver.stop(false);

        const execCommand = vi.fn().mockResolvedValue({
            status: BlzStatus.SUCCESS,
            eui64: Buffer.from("0000000000003344", "hex"),
        });
        driver.blz = {execCommand} as unknown as Driver["blz"];
        const eui64 = await driver.networkIdToEUI64(0x3344);

        expect(execCommand).toHaveBeenCalledWith("getEui64ByNodeId", {nodeId: 0x3344});
        expect(eui64.toString()).toBe("0000000000003344");
    });

    it("releases the BLZ instance reference when stopping", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const blzMock = {
            off: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        driver.blz = blzMock as unknown as Driver["blz"];

        await driver.stop(false);

        expect(blzMock.close).toHaveBeenCalledWith(false);
        expect((driver as unknown as {blz?: unknown}).blz).toBeUndefined();
    });

    it("detaches owned BLZ listeners without broad listener cleanup when stopping", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const blzMock = {
            off: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        driver.blz = blzMock as unknown as Driver["blz"];

        await driver.stop(false);

        expect(blzMock.off).toHaveBeenCalledWith("close", expect.any(Function));
        expect(blzMock.off).toHaveBeenCalledWith("reset", expect.any(Function));
        expect(blzMock.off).toHaveBeenCalledWith("frame", expect.any(Function));
        expect(blzMock.removeAllListeners).not.toHaveBeenCalled();
    });

    it("coalesces concurrent reset attempts", async () => {
        vi.useFakeTimers();
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const blzMock = {
            setResetingProcess: vi.fn(),
            forceReset: vi.fn().mockResolvedValue(undefined),
        };
        driver.blz = blzMock as unknown as Driver["blz"];
        const stop = vi.spyOn(driver, "stop").mockResolvedValue(undefined);
        const startup = vi.spyOn(driver, "startup").mockResolvedValue("resumed");

        const firstReset = driver.reset();
        const secondReset = driver.reset();
        await vi.advanceTimersByTimeAsync(3000);
        await Promise.all([firstReset, secondReset]);

        expect(blzMock.forceReset).toHaveBeenCalledTimes(1);
        expect(stop).toHaveBeenCalledTimes(1);
        expect(startup).toHaveBeenCalledTimes(1);
    });

    it("does not restart after stop interrupts an in-flight reset", async () => {
        vi.useFakeTimers();
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const blzMock = {
            setResetingProcess: vi.fn(),
            forceReset: vi.fn().mockResolvedValue(undefined),
            off: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        driver.blz = blzMock as unknown as Driver["blz"];
        const startup = vi.spyOn(driver, "startup").mockResolvedValue("resumed");

        const reset = driver.reset();
        await vi.advanceTimersByTimeAsync(1000);
        await driver.stop(false);
        await vi.advanceTimersByTimeAsync(3000);
        await reset;

        expect(startup).not.toHaveBeenCalled();
    });

    it("cancels reset delay promptly when stop interrupts reset", async () => {
        vi.useFakeTimers();
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const blzMock = {
            setResetingProcess: vi.fn(),
            forceReset: vi.fn().mockResolvedValue(undefined),
            off: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        driver.blz = blzMock as unknown as Driver["blz"];
        const startup = vi.spyOn(driver, "startup").mockResolvedValue("resumed");

        const reset = driver.reset();
        const resetResult = reset.then(() => "resolved");
        await vi.advanceTimersByTimeAsync(1000);
        await driver.stop(false);
        await vi.advanceTimersByTimeAsync(0);
        const observed = await Promise.race([
            resetResult,
            Promise.resolve("pending"),
        ]);
        await vi.advanceTimersByTimeAsync(2000);
        await reset;

        expect(observed).toBe("resolved");
        expect(startup).not.toHaveBeenCalled();
    });

    it("cancels reset while BLZ forceReset is pending", async () => {
        vi.useFakeTimers();
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const blzMock = {
            setResetingProcess: vi.fn(),
            forceReset: vi.fn().mockReturnValue(new Promise<void>(() => {})),
            off: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        driver.blz = blzMock as unknown as Driver["blz"];
        const startup = vi.spyOn(driver, "startup").mockResolvedValue("resumed");

        const reset = driver.reset();
        const resetResult = reset.then(() => "resolved");
        await vi.advanceTimersByTimeAsync(0);

        await driver.stop(false);
        await vi.advanceTimersByTimeAsync(0);
        const observed = await Promise.race([
            resetResult,
            Promise.resolve("pending"),
        ]);

        void reset.catch(() => {});

        expect(observed).toBe("resolved");
        expect(startup).not.toHaveBeenCalled();
        expect(blzMock.setResetingProcess).toHaveBeenCalledWith(false);
    });

    it("clears BLZ reset state when stop interrupts an in-flight reset", async () => {
        vi.useFakeTimers();
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const blzMock = {
            setResetingProcess: vi.fn(),
            forceReset: vi.fn().mockResolvedValue(undefined),
            off: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        driver.blz = blzMock as unknown as Driver["blz"];

        const reset = driver.reset();
        await vi.advanceTimersByTimeAsync(1000);
        await driver.stop(false);
        await vi.advanceTimersByTimeAsync(0);
        await reset;

        expect(blzMock.setResetingProcess).toHaveBeenCalledWith(true);
        expect(blzMock.setResetingProcess).toHaveBeenCalledWith(false);
    });

    it("returns false when multicast APS send returns a non-success status", async () => {
        const sendApsData = vi.fn().mockResolvedValue(BlzStatus.GENERAL_ERROR);
        const driver = makeDriverWithApsSender(sendApsData);
        const apsFrame = makeApsFrame();
        const data = Buffer.from([0x01, 0x02, 0x03]);

        await expect(driver.mrequest(apsFrame, data)).resolves.toBe(false);

        expect(sendApsData).toHaveBeenCalledWith(
            BlzOutgoingMessageType.BLZ_MSG_TYPE_MULTICAST,
            apsFrame.groupId,
            apsFrame.profileId,
            apsFrame.clusterId,
            apsFrame.sourceEndpoint,
            apsFrame.destinationEndpoint,
            0,
            5,
            0x80,
            data.length,
            data,
        );
    });

    it("returns false when broadcast APS send returns a non-success status", async () => {
        const sendApsData = vi.fn().mockResolvedValue(BlzStatus.GENERAL_ERROR);
        const driver = makeDriverWithApsSender(sendApsData);
        const apsFrame = makeApsFrame();
        const data = Buffer.from([0x04, 0x05]);

        await expect(driver.brequest(0xfffc, apsFrame, data)).resolves.toBe(false);

        expect(sendApsData).toHaveBeenCalledWith(
            BlzOutgoingMessageType.BLZ_MSG_TYPE_BROADCAST,
            0xfffc,
            apsFrame.profileId,
            apsFrame.clusterId,
            apsFrame.sourceEndpoint,
            apsFrame.destinationEndpoint,
            0,
            5,
            0x80,
            data.length,
            data,
        );
    });

    it("stops retrying APS requests when driver stop interrupts the retry delay", async () => {
        vi.useFakeTimers();
        const sendApsData = vi.fn().mockResolvedValue(BlzStatus.GENERAL_ERROR);
        const blzMock = {
            sendApsData,
            off: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        driver.blz = blzMock as unknown as Driver["blz"];
        const request = driver.request(0x3344, makeApsFrame(), Buffer.from([0x0c]));
        const requestResult = request.then((value) => `resolved:${value}`);

        await vi.advanceTimersByTimeAsync(0);
        await driver.stop(false);
        await vi.advanceTimersByTimeAsync(0);
        const observed = await Promise.race([
            requestResult,
            Promise.resolve("pending"),
        ]);
        await vi.advanceTimersByTimeAsync(3000);
        await request;

        expect(observed).toBe("resolved:false");
        expect(sendApsData).toHaveBeenCalledTimes(1);
    });

    it("stops active APS requests when driver stop interrupts the lower send", async () => {
        vi.useFakeTimers();
        const sendApsData = vi.fn().mockReturnValue(new Promise(() => {}));
        const blzMock = {
            sendApsData,
            off: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        driver.blz = blzMock as unknown as Driver["blz"];
        const request = driver.request(0x3344, makeApsFrame(), Buffer.from([0x0c]));
        const requestResult = request.then((value) => `resolved:${value}`);

        await vi.advanceTimersByTimeAsync(0);
        await driver.stop(false);
        await vi.advanceTimersByTimeAsync(0);
        const observed = await Promise.race([
            requestResult,
            Promise.resolve("pending"),
        ]);

        void request.catch(() => {});

        expect(observed).toBe("resolved:false");
        expect(sendApsData).toHaveBeenCalledTimes(1);
    });

    it("stops APS requests when driver stop interrupts EUI64 lookup", async () => {
        vi.useFakeTimers();
        const execCommand = vi.fn().mockReturnValue(new Promise(() => {}));
        const sendApsData = vi.fn();
        const blzMock = {
            execCommand,
            sendApsData,
            off: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        driver.blz = blzMock as unknown as Driver["blz"];
        const request = driver.request(new BlzEUI64("0000000000003344"), makeApsFrame(), Buffer.from([0x0c]));
        const requestResult = request.then((value) => `resolved:${value}`);

        await vi.advanceTimersByTimeAsync(0);
        await driver.stop(false);
        await vi.advanceTimersByTimeAsync(0);
        const observed = await Promise.race([
            requestResult,
            Promise.resolve("pending"),
        ]);

        void request.catch(() => {});

        expect(observed).toBe("resolved:false");
        expect(execCommand).toHaveBeenCalledWith("getNodeIdByEui64", {eui64: expect.any(BlzEUI64)});
        expect(sendApsData).not.toHaveBeenCalled();
    });

    it("closes BLZ resources when startup fails after connecting", async () => {
        const blzMock = {
            on: vi.fn(),
            off: vi.fn(),
            connect: vi.fn().mockResolvedValue(undefined),
            forceReset: vi.fn().mockRejectedValue(new Error("reset failed")),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        blzConstructorMock.mockImplementation(() => blzMock);
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");

        await expect(driver.startup()).rejects.toThrow("reset failed");

        expect(blzMock.off).toHaveBeenCalledWith("close", expect.any(Function));
        expect(blzMock.off).toHaveBeenCalledWith("reset", expect.any(Function));
        expect(blzMock.off).toHaveBeenCalledWith("frame", expect.any(Function));
        expect(blzMock.removeAllListeners).not.toHaveBeenCalled();
        expect(blzMock.close).toHaveBeenCalledWith(false);
    });

    it("closes an existing BLZ instance before replacing it during startup", async () => {
        const oldBlzMock = {
            off: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        const newBlzMock = {
            on: vi.fn(),
            off: vi.fn(),
            connect: vi.fn().mockResolvedValue(undefined),
            forceReset: vi.fn().mockRejectedValue(new Error("reset failed")),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        blzConstructorMock.mockImplementation(() => newBlzMock);
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        driver.blz = oldBlzMock as unknown as Driver["blz"];

        await expect(driver.startup()).rejects.toThrow("reset failed");

        expect(oldBlzMock.off).toHaveBeenCalledWith("close", expect.any(Function));
        expect(oldBlzMock.off).toHaveBeenCalledWith("reset", expect.any(Function));
        expect(oldBlzMock.off).toHaveBeenCalledWith("frame", expect.any(Function));
        expect(oldBlzMock.removeAllListeners).not.toHaveBeenCalled();
        expect(oldBlzMock.close).toHaveBeenCalledWith(false);
    });

    it("cancels startup delay when stop interrupts startup", async () => {
        vi.useFakeTimers();
        const blzMock = {
            on: vi.fn(),
            off: vi.fn(),
            connect: vi.fn().mockResolvedValue(undefined),
            forceReset: vi.fn().mockResolvedValue(undefined),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        blzConstructorMock.mockImplementation(() => blzMock);
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const addEndpoint = vi.spyOn(driver, "addEndpoint").mockResolvedValue(undefined);

        const startup = driver.startup();
        const startupResult = startup.then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
        );
        await vi.advanceTimersByTimeAsync(1000);
        await driver.stop(false);
        await vi.advanceTimersByTimeAsync(0);
        const observed = await Promise.race([
            startupResult,
            Promise.resolve("pending"),
        ]);
        await vi.advanceTimersByTimeAsync(2000);
        await startup.catch(() => {});

        expect(observed).toBe("rejected:Driver stopped");
        expect(addEndpoint).not.toHaveBeenCalled();
    });

    it("cancels startup while BLZ connect is pending", async () => {
        vi.useFakeTimers();
        const blzMock = {
            on: vi.fn(),
            off: vi.fn(),
            connect: vi.fn().mockReturnValue(new Promise<void>(() => {})),
            forceReset: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        blzConstructorMock.mockImplementation(() => blzMock);
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");

        const startup = driver.startup();
        const startupResult = startup.then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
        );
        await vi.advanceTimersByTimeAsync(0);

        await driver.stop(false);
        await vi.advanceTimersByTimeAsync(0);
        const observed = await Promise.race([
            startupResult,
            Promise.resolve("pending"),
        ]);

        void startup.catch(() => {});

        expect(observed).toBe("rejected:Driver stopped");
        expect(blzMock.close).toHaveBeenCalledWith(false);
        expect(blzMock.forceReset).not.toHaveBeenCalled();
        expect((driver as unknown as {blz?: unknown}).blz).toBeUndefined();
    });

    it("cancels startup while BLZ forceReset is pending", async () => {
        vi.useFakeTimers();
        const blzMock = {
            on: vi.fn(),
            off: vi.fn(),
            connect: vi.fn().mockResolvedValue(undefined),
            forceReset: vi.fn().mockReturnValue(new Promise<void>(() => {})),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        blzConstructorMock.mockImplementation(() => blzMock);
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const addEndpoint = vi.spyOn(driver, "addEndpoint").mockResolvedValue(undefined);

        const startup = driver.startup();
        const startupResult = startup.then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
        );
        await vi.advanceTimersByTimeAsync(0);

        await driver.stop(false);
        await vi.advanceTimersByTimeAsync(0);
        const observed = await Promise.race([
            startupResult,
            Promise.resolve("pending"),
        ]);

        void startup.catch(() => {});

        expect(observed).toBe("rejected:Driver stopped");
        expect(blzMock.close).toHaveBeenCalledWith(false);
        expect(addEndpoint).not.toHaveBeenCalled();
        expect((driver as unknown as {blz?: unknown}).blz).toBeUndefined();
    });

    it("cancels startup while addEndpoint is pending", async () => {
        vi.useFakeTimers();
        const blzMock = {
            on: vi.fn(),
            off: vi.fn(),
            connect: vi.fn().mockResolvedValue(undefined),
            forceReset: vi.fn().mockResolvedValue(undefined),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        blzConstructorMock.mockImplementation(() => blzMock);
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const addEndpoint = vi.spyOn(driver, "addEndpoint").mockReturnValue(new Promise<void>(() => {}));

        const startup = driver.startup();
        const startupResult = startup.then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
        );
        await vi.advanceTimersByTimeAsync(2000);

        await driver.stop(false);
        await vi.advanceTimersByTimeAsync(0);
        const observed = await Promise.race([
            startupResult,
            Promise.resolve("pending"),
        ]);

        void startup.catch(() => {});

        expect(observed).toBe("rejected:Driver stopped");
        expect(blzMock.close).toHaveBeenCalledWith(false);
        expect(addEndpoint).toHaveBeenCalledTimes(1);
        expect((driver as unknown as {blz?: unknown}).blz).toBeUndefined();
    });

    it("cancels startup while getVersion is pending", async () => {
        vi.useFakeTimers();
        const blzMock = {
            on: vi.fn(),
            off: vi.fn(),
            connect: vi.fn().mockResolvedValue(undefined),
            forceReset: vi.fn().mockResolvedValue(undefined),
            getVersion: vi.fn().mockReturnValue(new Promise<void>(() => {})),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        blzConstructorMock.mockImplementation(() => blzMock);
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const addEndpoint = vi.spyOn(driver, "addEndpoint").mockResolvedValue(undefined);

        const startup = driver.startup();
        const startupResult = startup.then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
        );
        await vi.advanceTimersByTimeAsync(2000);
        await vi.advanceTimersByTimeAsync(0);

        await driver.stop(false);
        await vi.advanceTimersByTimeAsync(0);
        const observed = await Promise.race([
            startupResult,
            Promise.resolve("pending"),
        ]);

        void startup.catch(() => {});

        expect(observed).toBe("rejected:Driver stopped");
        expect(blzMock.close).toHaveBeenCalledWith(false);
        expect(addEndpoint).toHaveBeenCalledTimes(1);
        expect((driver as unknown as {blz?: unknown}).blz).toBeUndefined();
    });

    it("cancels startup while network validation is pending", async () => {
        vi.useFakeTimers();
        const blzMock = {
            on: vi.fn(),
            off: vi.fn(),
            connect: vi.fn().mockResolvedValue(undefined),
            forceReset: vi.fn().mockResolvedValue(undefined),
            getVersion: vi.fn().mockResolvedValue(undefined),
            networkInit: vi.fn().mockReturnValue(new Promise<boolean>(() => {})),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        blzConstructorMock.mockImplementation(() => blzMock);
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const addEndpoint = vi.spyOn(driver, "addEndpoint").mockResolvedValue(undefined);

        const startup = driver.startup();
        const startupResult = startup.then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
        );
        await vi.advanceTimersByTimeAsync(2000);
        await vi.advanceTimersByTimeAsync(0);

        await driver.stop(false);
        await vi.advanceTimersByTimeAsync(0);
        const observed = await Promise.race([
            startupResult,
            Promise.resolve("pending"),
        ]);

        void startup.catch(() => {});

        expect(observed).toBe("rejected:Driver stopped");
        expect(blzMock.close).toHaveBeenCalledWith(false);
        expect(addEndpoint).toHaveBeenCalledTimes(1);
        expect((driver as unknown as {blz?: unknown}).blz).toBeUndefined();
    });

    it("cancels startup while final network parameters request is pending", async () => {
        vi.useFakeTimers();
        const blzMock = {
            on: vi.fn(),
            off: vi.fn(),
            connect: vi.fn().mockResolvedValue(undefined),
            forceReset: vi.fn().mockResolvedValue(undefined),
            getVersion: vi.fn().mockResolvedValue(undefined),
            networkInit: vi.fn().mockResolvedValue(true),
            execCommand: vi.fn()
                .mockResolvedValueOnce({
                    status: BlzStatus.SUCCESS,
                    nodeType: 0,
                    panId: networkOptions.panID,
                    extPanId: 0x0807060504030201n,
                    channel: 11,
                    nwkUpdateId: 0,
                })
                .mockReturnValueOnce(new Promise(() => {})),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        blzConstructorMock.mockImplementation(() => blzMock);
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        vi.spyOn(driver, "addEndpoint").mockResolvedValue(undefined);

        const startup = driver.startup();
        const startupResult = startup.then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
        );
        await vi.advanceTimersByTimeAsync(3000);
        await vi.advanceTimersByTimeAsync(0);

        await driver.stop(false);
        await vi.advanceTimersByTimeAsync(0);
        const observed = await Promise.race([
            startupResult,
            Promise.resolve("pending"),
        ]);

        void startup.catch(() => {});

        expect(observed).toBe("rejected:Driver stopped");
        expect(blzMock.close).toHaveBeenCalledWith(false);
        expect(blzMock.execCommand).toHaveBeenCalledTimes(2);
        expect(blzMock.execCommand).toHaveBeenLastCalledWith("getNetworkParameters");
        expect((driver as unknown as {blz?: unknown}).blz).toBeUndefined();
    });

    it("cancels startup while coordinator IEEE request is pending", async () => {
        vi.useFakeTimers();
        const blzMock = {
            on: vi.fn(),
            off: vi.fn(),
            connect: vi.fn().mockResolvedValue(undefined),
            forceReset: vi.fn().mockResolvedValue(undefined),
            getVersion: vi.fn().mockResolvedValue(undefined),
            networkInit: vi.fn().mockResolvedValue(true),
            execCommand: vi.fn()
                .mockResolvedValueOnce({
                    status: BlzStatus.SUCCESS,
                    nodeType: 0,
                    panId: networkOptions.panID,
                    extPanId: 0x0807060504030201n,
                    channel: 11,
                    nwkUpdateId: 0,
                })
                .mockResolvedValueOnce({
                    status: BlzStatus.SUCCESS,
                    panId: networkOptions.panID,
                    extPanId: 0x0807060504030201n,
                    channel: 11,
                    nwkUpdateId: 0,
                    nodeType: 0,
                })
                .mockReturnValueOnce(new Promise(() => {})),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        blzConstructorMock.mockImplementation(() => blzMock);
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        vi.spyOn(driver, "addEndpoint").mockResolvedValue(undefined);

        const startup = driver.startup();
        const startupResult = startup.then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
        );
        await vi.advanceTimersByTimeAsync(3000);
        await vi.advanceTimersByTimeAsync(0);

        await driver.stop(false);
        await vi.advanceTimersByTimeAsync(0);
        const observed = await Promise.race([
            startupResult,
            Promise.resolve("pending"),
        ]);

        void startup.catch(() => {});

        expect(observed).toBe("rejected:Driver stopped");
        expect(blzMock.close).toHaveBeenCalledWith(false);
        expect(blzMock.execCommand).toHaveBeenCalledTimes(3);
        expect(blzMock.execCommand).toHaveBeenLastCalledWith("getValue", {
            valueId: BlzValueId.BLZ_VALUE_ID_MAC_ADDRESS,
        });
        expect((driver as unknown as {blz?: unknown}).blz).toBeUndefined();
    });

    it("cancels startup while restore decision is pending", async () => {
        vi.useFakeTimers();
        const blzMock = {
            on: vi.fn(),
            off: vi.fn(),
            connect: vi.fn().mockResolvedValue(undefined),
            forceReset: vi.fn().mockResolvedValue(undefined),
            getVersion: vi.fn().mockResolvedValue(undefined),
            networkInit: vi.fn().mockResolvedValue(true),
            execCommand: vi.fn().mockResolvedValue({
                status: BlzStatus.SUCCESS,
                nodeType: 1,
                panId: networkOptions.panID,
                extPanId: 0x0807060504030201n,
                channel: 11,
                nwkUpdateId: 0,
            }),
            leaveNetwork: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        blzConstructorMock.mockImplementation(() => blzMock);
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        vi.spyOn(driver, "addEndpoint").mockResolvedValue(undefined);
        vi.spyOn(driver.backupMan, "getStoredBackup").mockReturnValue(new Promise(() => {}));

        const startup = driver.startup();
        const startupResult = startup.then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
        );
        await vi.advanceTimersByTimeAsync(3000);
        await vi.advanceTimersByTimeAsync(0);

        await driver.stop(false);
        await vi.advanceTimersByTimeAsync(0);
        const observed = await Promise.race([
            startupResult,
            Promise.resolve("pending"),
        ]);

        void startup.catch(() => {});

        expect(observed).toBe("rejected:Driver stopped");
        expect(blzMock.close).toHaveBeenCalledWith(false);
        expect(driver.backupMan.getStoredBackup).toHaveBeenCalled();
        expect(blzMock.leaveNetwork).not.toHaveBeenCalled();
        expect((driver as unknown as {blz?: unknown}).blz).toBeUndefined();
    });

    it("cancels startup while leaveNetwork is pending", async () => {
        vi.useFakeTimers();
        const blzMock = {
            on: vi.fn(),
            off: vi.fn(),
            connect: vi.fn().mockResolvedValue(undefined),
            forceReset: vi.fn().mockResolvedValue(undefined),
            getVersion: vi.fn().mockResolvedValue(undefined),
            networkInit: vi.fn().mockResolvedValue(true),
            execCommand: vi.fn().mockResolvedValue({
                status: BlzStatus.SUCCESS,
                nodeType: 1,
                panId: networkOptions.panID,
                extPanId: 0x0807060504030201n,
                channel: 11,
                nwkUpdateId: 0,
            }),
            leaveNetwork: vi.fn().mockReturnValue(new Promise(() => {})),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        blzConstructorMock.mockImplementation(() => blzMock);
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        vi.spyOn(driver, "addEndpoint").mockResolvedValue(undefined);
        vi.spyOn(driver.backupMan, "getStoredBackup").mockResolvedValue(null);

        const startup = driver.startup();
        const startupResult = startup.then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
        );
        await vi.advanceTimersByTimeAsync(3000);
        await vi.advanceTimersByTimeAsync(0);

        await driver.stop(false);
        await vi.advanceTimersByTimeAsync(0);
        const observed = await Promise.race([
            startupResult,
            Promise.resolve("pending"),
        ]);

        void startup.catch(() => {});

        expect(observed).toBe("rejected:Driver stopped");
        expect(blzMock.close).toHaveBeenCalledWith(false);
        expect(blzMock.leaveNetwork).toHaveBeenCalledTimes(1);
        expect((driver as unknown as {blz?: unknown}).blz).toBeUndefined();
    });

    it("cancels startup while formNetwork is pending", async () => {
        vi.useFakeTimers();
        const blzMock = {
            on: vi.fn(),
            off: vi.fn(),
            connect: vi.fn().mockResolvedValue(undefined),
            forceReset: vi.fn().mockResolvedValue(undefined),
            getVersion: vi.fn().mockResolvedValue(undefined),
            networkInit: vi.fn().mockResolvedValue(true),
            execCommand: vi.fn().mockResolvedValue({
                status: BlzStatus.SUCCESS,
                nodeType: 1,
                panId: networkOptions.panID,
                extPanId: 0x0807060504030201n,
                channel: 11,
                nwkUpdateId: 0,
            }),
            leaveNetwork: vi.fn().mockResolvedValue(BlzStatus.SUCCESS),
            formNetwork: vi.fn().mockReturnValue(new Promise(() => {})),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        blzConstructorMock.mockImplementation(() => blzMock);
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        vi.spyOn(driver, "addEndpoint").mockResolvedValue(undefined);
        vi.spyOn(driver, "setNetworkKeyInfo").mockResolvedValue(BlzStatus.SUCCESS);
        vi.spyOn(driver.backupMan, "getStoredBackup").mockResolvedValue(null);

        const startup = driver.startup();
        const startupResult = startup.then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
        );
        await vi.advanceTimersByTimeAsync(4000);
        await vi.advanceTimersByTimeAsync(0);

        await driver.stop(false);
        await vi.advanceTimersByTimeAsync(0);
        const observed = await Promise.race([
            startupResult,
            Promise.resolve("pending"),
        ]);

        void startup.catch(() => {});

        expect(observed).toBe("rejected:Driver stopped");
        expect(blzMock.close).toHaveBeenCalledWith(false);
        expect(blzMock.formNetwork).toHaveBeenCalledTimes(1);
        expect((driver as unknown as {blz?: unknown}).blz).toBeUndefined();
    });

    it("coalesces concurrent startup attempts", async () => {
        vi.useFakeTimers();
        const blzMock = {
            on: vi.fn(),
            off: vi.fn(),
            connect: vi.fn().mockResolvedValue(undefined),
            forceReset: vi.fn().mockResolvedValue(undefined),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        blzConstructorMock.mockImplementation(() => blzMock);
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const addEndpoint = vi.spyOn(driver, "addEndpoint").mockResolvedValue(undefined);

        const firstStartup = driver.startup().catch((error: Error) => error);
        await vi.advanceTimersByTimeAsync(0);
        const secondStartup = driver.startup().catch((error: Error) => error);
        await vi.advanceTimersByTimeAsync(0);

        expect(blzConstructorMock).toHaveBeenCalledTimes(1);

        await driver.stop(false);
        await vi.advanceTimersByTimeAsync(0);
        await Promise.all([firstStartup, secondStartup]);

        expect(addEndpoint).not.toHaveBeenCalled();
    });

    it("caches sender EUI64 by node ID for incoming APS messages and clears it on leave", () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const incomingMessage = vi.fn();
        driver.on("incomingMessage", incomingMessage);

        driver.handleNodeJoined(0x3344, 0x123456);
        (driver as unknown as {handleFrame: (frameName: string, frame: BLZFrameData) => void}).handleFrame(
            "apsDataIndication",
            makeIncomingApsFrame(0x3344),
        );

        expect(incomingMessage).toHaveBeenLastCalledWith(
            expect.objectContaining({
                sender: 0x3344,
                senderEui64: expect.objectContaining({
                    value: Buffer.from("0000000000123456", "hex"),
                }),
            }),
        );

        driver.handleNodeLeft(0x3344, "0x0000000000123456");
        (driver as unknown as {handleFrame: (frameName: string, frame: BLZFrameData) => void}).handleFrame(
            "apsDataIndication",
            makeIncomingApsFrame(0x3344),
        );

        expect(incomingMessage).toHaveBeenLastCalledWith(
            expect.objectContaining({
                sender: 0x3344,
                senderEui64: undefined,
            }),
        );
    });

    it("removes stale EUI64 mappings when a node ID is re-cached with a new EUI64", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const execCommand = vi.fn().mockResolvedValue({nodeId: 0x5566});
        const sendApsData = vi.fn().mockResolvedValue(BlzStatus.SUCCESS);
        driver.blz = {execCommand, sendApsData} as unknown as Driver["blz"];
        const apsFrame = makeApsFrame();
        const data = Buffer.from([0x08, 0x09]);

        driver.handleNodeJoined(0x3344, 0x1111);
        driver.handleNodeJoined(0x3344, 0x2222);

        await expect(driver.request(new BlzEUI64("0000000000001111"), apsFrame, data)).resolves.toBe(true);

        expect(execCommand).toHaveBeenCalledWith("getNodeIdByEui64", {eui64: expect.any(BlzEUI64)});
        expect(sendApsData).toHaveBeenCalledWith(
            BlzOutgoingMessageType.BLZ_MSG_TYPE_UNICAST,
            0x5566,
            apsFrame.profileId,
            apsFrame.clusterId,
            apsFrame.sourceEndpoint,
            apsFrame.destinationEndpoint,
            0,
            5,
            0x80,
            data.length,
            data,
        );
    });

    it("updates reverse address cache after resolving a request destination by EUI64", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const execCommand = vi.fn().mockResolvedValue({nodeId: 0x7788});
        const sendApsData = vi.fn().mockResolvedValue(BlzStatus.SUCCESS);
        const incomingMessage = vi.fn();
        driver.blz = {execCommand, sendApsData} as unknown as Driver["blz"];
        driver.on("incomingMessage", incomingMessage);
        const apsFrame = makeApsFrame();
        const data = Buffer.from([0x0a, 0x0b]);

        await expect(driver.request(new BlzEUI64("0000000000007788"), apsFrame, data)).resolves.toBe(true);
        (driver as unknown as {handleFrame: (frameName: string, frame: BLZFrameData) => void}).handleFrame(
            "apsDataIndication",
            makeIncomingApsFrame(0x7788),
        );

        expect(incomingMessage).toHaveBeenLastCalledWith(
            expect.objectContaining({
                sender: 0x7788,
                senderEui64: expect.objectContaining({
                    value: Buffer.from("0000000000007788", "hex"),
                }),
            }),
        );
    });

    it("clears address cache when forming a new network", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const formNetwork = vi.fn().mockResolvedValue(BlzStatus.SUCCESS);
        const execCommand = vi.fn().mockResolvedValue({
            status: BlzStatus.SUCCESS,
            eui64: Buffer.from("0000000000003344", "hex"),
        });
        vi.spyOn(driver, "setNetworkKeyInfo").mockResolvedValue(BlzStatus.SUCCESS);
        driver.blz = {formNetwork, execCommand} as unknown as Driver["blz"];

        driver.handleNodeJoined(0x3344, 0x1111);
        await (driver as unknown as {formNetwork: (restore: boolean) => Promise<void>}).formNetwork(false);
        const eui64 = await driver.networkIdToEUI64(0x3344);

        expect(execCommand).toHaveBeenCalledWith("getEui64ByNodeId", {nodeId: 0x3344});
        expect(eui64.toString()).toBe("0000000000003344");
    });
});
