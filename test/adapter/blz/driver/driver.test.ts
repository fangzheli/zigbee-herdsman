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
import {BlzOutgoingMessageType, BlzStatus} from "../../../../src/adapter/blz/driver/types";
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
});
