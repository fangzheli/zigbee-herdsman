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
import {BlzEUI64, BlzOutgoingMessageType, BlzStatus} from "../../../../src/adapter/blz/driver/types";
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
        waiter.start();

        (driver as unknown as {blz: {removeAllListeners: () => void; close: () => Promise<void>}}).blz = {
            removeAllListeners: vi.fn(),
            close: vi.fn().mockRejectedValue(new Error("close failed")),
        };

        await expect(driver.stop()).rejects.toThrow("close failed");

        expect(clearTimeoutSpy).toHaveBeenCalled();
    });

    it("clears address cache when stopping", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        driver.handleNodeJoined(0x3344, 0x1111);
        driver.blz = {
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
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        driver.blz = blzMock as unknown as Driver["blz"];

        await driver.stop(false);

        expect(blzMock.close).toHaveBeenCalledWith(false);
        expect((driver as unknown as {blz?: unknown}).blz).toBeUndefined();
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

    it("closes BLZ resources when startup fails after connecting", async () => {
        const blzMock = {
            on: vi.fn(),
            connect: vi.fn().mockResolvedValue(undefined),
            forceReset: vi.fn().mockRejectedValue(new Error("reset failed")),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        blzConstructorMock.mockImplementation(() => blzMock);
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");

        await expect(driver.startup()).rejects.toThrow("reset failed");

        expect(blzMock.removeAllListeners).toHaveBeenCalled();
        expect(blzMock.close).toHaveBeenCalledWith(false);
    });

    it("closes an existing BLZ instance before replacing it during startup", async () => {
        const oldBlzMock = {
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        const newBlzMock = {
            on: vi.fn(),
            connect: vi.fn().mockResolvedValue(undefined),
            forceReset: vi.fn().mockRejectedValue(new Error("reset failed")),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        blzConstructorMock.mockImplementation(() => newBlzMock);
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        driver.blz = oldBlzMock as unknown as Driver["blz"];

        await expect(driver.startup()).rejects.toThrow("reset failed");

        expect(oldBlzMock.removeAllListeners).toHaveBeenCalled();
        expect(oldBlzMock.close).toHaveBeenCalledWith(false);
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
