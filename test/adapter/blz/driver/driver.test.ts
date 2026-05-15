import * as fs from "node:fs";

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
import {BlzApsFrame, BlzNetworkParameters} from "../../../../src/adapter/blz/driver/types/struct";
import type {NetworkOptions, SerialPortOptions} from "../../../../src/adapter/tstype";
import {logger} from "../../../../src/utils/logger";
import * as ZSpec from "../../../../src/zspec";
import * as Zdo from "../../../../src/zspec/zdo";

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

    it("keeps the lower BLZ transport behind driver APIs", () => {
        const source = fs.readFileSync("src/adapter/blz/driver/driver.ts", "utf8");

        expect(source).toContain("private blz?: Blz;");
        expect(source).not.toContain("public blz?: Blz;");
        expect(source).toContain("private networkParams?: BlzNetworkParameters;");
        expect(source).not.toContain("public networkParams?: BlzNetworkParameters;");
        expect(source).toContain("private getBlz(): Blz");
        expect(source).not.toContain("public getBlz(): Blz");
        expect(source).toContain("private nextTransactionID(): number");
        expect(source).not.toContain("public nextTransactionID(): number");
        expect(source).not.toContain("disableResponse: boolean,\n  ): BlzApsFrame");
        expect(source).not.toContain("extendedTimeout = false");
        expect(source).not.toContain("timeout = 30000,\n  ): Promise<boolean>");
        expect(source).toContain("private onBlzReset(): void");
        expect(source).not.toContain("private async onBlzReset");
        expect(source).toContain("void this.reset().catch");
        expect(source).not.toContain("extPanIdArray.push");
        expect(source).toContain("public async sendZdo(");
        expect(source).toContain("private async sendZdoFrame(");
        expect(source).toContain("private waitFor(");
        expect(source).not.toContain("public waitFor(");
        expect(source).toContain("private async mrequest(");
        expect(source).not.toContain("public async mrequest(");
        expect(source).toContain("private async brequest(");
        expect(source).not.toContain("public async brequest(");
        expect(source).toContain("private async request(");
        expect(source).not.toContain("public async request(");
        expect(source).toContain("private makeApsFrame(");
        expect(source).not.toContain("public makeApsFrame(");
        expect(source).not.toContain("public setNode(");
        expect(source).toContain("private handleNodeJoined(");
        expect(source).not.toContain("public handleNodeJoined(");
        expect(source).toContain("private handleNodeLeft(");
        expect(source).not.toContain("public handleNodeLeft(");
        expect(source).toContain("private updateNetworkParametersSnapshot(");
        expect(source).not.toContain("public updateNetworkParametersSnapshot(");
        expect(source).toContain("private async leaveNetwork(");
        expect(source).not.toContain("public async leaveNetwork(");
        expect(source).toContain("private async formNetworkWithParameters(");
        expect(source).not.toContain("public async formNetworkWithParameters(");
        expect(source).toContain("private async setGlobalTcLinkKey(");
        expect(source).not.toContain("public async setGlobalTcLinkKey(");
        expect(source).toContain("private async setNetworkKeyInfo(");
        expect(source).not.toContain("public async setNetworkKeyInfo(");
        expect(source).toContain("private async getGlobalTcLinkKey(");
        expect(source).not.toContain("public async getGlobalTcLinkKey(");
        expect(source).toContain("private async getNetworkKeyInfo(");
        expect(source).not.toContain("public async getNetworkKeyInfo(");
        expect(source).toContain("private async getCurrentNetworkParameters(");
        expect(source).not.toContain("public async getCurrentNetworkParameters(");
        expect(source).toContain("private async getMacAddress(");
        expect(source).not.toContain("public async getMacAddress(");
    });

    it("converts BLZ MAC bytes to IEEE EUI64 without copying then reversing", () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const raw = Buffer.from([0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]);
        const original = Buffer.from(raw);
        const expected = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
        const fromSpy = vi.spyOn(Buffer, "from").mockImplementation(() => {
            throw new Error("Buffer.from used");
        });

        try {
            const result = (
                driver as unknown as {convertBlzMacToIeeeEui64: (rawMacBuffer: Buffer) => Buffer}
            ).convertBlzMacToIeeeEui64(raw);

            expect(result).toEqual(expected);
            expect(raw).toEqual(original);
            expect(fromSpy).not.toHaveBeenCalled();
        } finally {
            fromSpy.mockRestore();
        }
    });

    afterEach(() => {
        vi.useRealTimers();
        blzConstructorMock.mockReset();
        vi.restoreAllMocks();
    });

    function makeDriverWithApsSender(sendApsData: ReturnType<typeof vi.fn>): Driver {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        setDriverBlz(driver, {sendApsData});

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

    function makeIncomingZdoResponseFrame(srcShortAddr: number, message: Buffer): BLZFrameData {
        return {
            ...makeIncomingApsFrame(srcShortAddr),
            profileId: Zdo.ZDO_PROFILE_ID,
            clusterId: Zdo.ClusterId.NETWORK_ADDRESS_RESPONSE,
            message,
        } as BLZFrameData;
    }

    function makeNetworkAddressResponseMessage(eui64: string, nwk: number): Buffer {
        const normalized = eui64.replace(/^0x/i, "");
        const eui64Bytes = Buffer.from(normalized, "hex").reverse();
        return Buffer.from([
            0x01,
            0x00,
            ...eui64Bytes,
            nwk & 0xff,
            (nwk >> 8) & 0xff,
        ]);
    }

    function seedNetworkSnapshot(driver: Driver): void {
        const networkParams = new BlzNetworkParameters();
        networkParams.panId = 0x1234;
        networkParams.extendedPanId = Buffer.from("0102030405060708", "hex");
        networkParams.Channel = 11;
        networkParams.nwkUpdateId = 0;
        networkParams.channels = 2 ** 11;
        (driver as unknown as {networkParams: BlzNetworkParameters}).networkParams = networkParams;
        (driver as unknown as {ieee: BlzEUI64}).ieee = new BlzEUI64("0102030405060708");
    }

    function setDriverBlz(driver: Driver, blz: unknown): void {
        (driver as unknown as {blz?: unknown}).blz = blz;
    }

    function cacheDriverNode(
        driver: Driver,
        nwk: number,
        ieee: BlzEUI64 | ArrayLike<number> | string | number | bigint,
    ): BlzEUI64 {
        return (driver as unknown as {
            cacheNodeIeee: (
                nwk: number,
                ieee: BlzEUI64 | ArrayLike<number> | string | number | bigint,
            ) => BlzEUI64;
        }).cacheNodeIeee(nwk, ieee);
    }

    function handleDriverNodeJoined(driver: Driver, nwk: number, ieee: number | bigint): void {
        (driver as unknown as {
            handleNodeJoined: (nwk: number, ieee: number | bigint) => void;
        }).handleNodeJoined(nwk, ieee);
    }

    function handleDriverNodeLeft(driver: Driver, nwk: number, ieeeAddr: string): void {
        (driver as unknown as {
            handleNodeLeft: (nwk: number, ieeeAddr: string) => void;
        }).handleNodeLeft(nwk, ieeeAddr);
    }

    function updateDriverNetworkParametersSnapshot(
        driver: Driver,
        channel: number,
        nwkUpdateId: number,
    ): void {
        (driver as unknown as {
            updateNetworkParametersSnapshot: (channel: number, nwkUpdateId: number) => void;
        }).updateNetworkParametersSnapshot(channel, nwkUpdateId);
    }

    function driverLeaveNetwork(driver: Driver): Promise<BlzStatus> {
        return (driver as unknown as {
            leaveNetwork: () => Promise<BlzStatus>;
        }).leaveNetwork();
    }

    function driverFormNetworkWithParameters(
        driver: Driver,
        extendedPanId: bigint,
        panId: number,
        channel: number,
    ): Promise<BlzStatus> {
        return (driver as unknown as {
            formNetworkWithParameters: (
                extendedPanId: bigint,
                panId: number,
                channel: number,
            ) => Promise<BlzStatus>;
        }).formNetworkWithParameters(extendedPanId, panId, channel);
    }

    function driverSetGlobalTcLinkKey(
        driver: Driver,
        linkKey: Buffer,
        outgoingFrameCounter: number,
    ): Promise<BlzStatus> {
        return (driver as unknown as {
            setGlobalTcLinkKey: (
                linkKey: Buffer,
                outgoingFrameCounter: number,
            ) => Promise<BlzStatus>;
        }).setGlobalTcLinkKey(linkKey, outgoingFrameCounter);
    }

    function driverSetNetworkKeyInfo(
        driver: Driver,
        nwkKey: Buffer,
        outgoingFrameCounter: number,
        nwkKeySeqNum: number,
    ): Promise<BlzStatus> {
        return (driver as unknown as {
            setNetworkKeyInfo: (
                nwkKey: Buffer,
                outgoingFrameCounter: number,
                nwkKeySeqNum: number,
            ) => Promise<BlzStatus>;
        }).setNetworkKeyInfo(nwkKey, outgoingFrameCounter, nwkKeySeqNum);
    }

    function driverGetGlobalTcLinkKey(driver: Driver): Promise<BLZFrameData> {
        return (driver as unknown as {
            getGlobalTcLinkKey: () => Promise<BLZFrameData>;
        }).getGlobalTcLinkKey();
    }

    function driverGetNetworkKeyInfo(driver: Driver): Promise<BLZFrameData> {
        return (driver as unknown as {
            getNetworkKeyInfo: () => Promise<BLZFrameData>;
        }).getNetworkKeyInfo();
    }

    function driverGetCurrentNetworkParameters(driver: Driver): Promise<BLZFrameData> {
        return (driver as unknown as {
            getCurrentNetworkParameters: () => Promise<BLZFrameData>;
        }).getCurrentNetworkParameters();
    }

    function driverGetMacAddress(driver: Driver): Promise<Buffer> {
        return (driver as unknown as {
            getMacAddress: () => Promise<Buffer>;
        }).getMacAddress();
    }

    function spyOnDriverSetNetworkKeyInfo(
        driver: Driver,
    ): ReturnType<typeof vi.spyOn> {
        return vi.spyOn(
            driver as unknown as {
                setNetworkKeyInfo: (
                    nwkKey: Buffer,
                    outgoingFrameCounter: number,
                    nwkKeySeqNum: number,
                ) => Promise<BlzStatus>;
            },
            "setNetworkKeyInfo",
        );
    }

    function waitForDriverZdo(
        driver: Driver,
        address: number | string,
        clusterId: number,
        timeout?: number,
    ) {
        return (driver as unknown as {
            waitFor: (
                address: number | string,
                clusterId: number,
                timeout?: number,
            ) => {
                start: () => {promise: Promise<{zdoResponse?: unknown}>};
                cancel: () => void;
            };
        }).waitFor(address, clusterId, timeout);
    }

    function driverMrequest(
        driver: Driver,
        apsFrame: BlzApsFrame,
        data: Buffer,
    ): Promise<boolean> {
        return (driver as unknown as {
            mrequest: (apsFrame: BlzApsFrame, data: Buffer) => Promise<boolean>;
        }).mrequest(apsFrame, data);
    }

    function driverBrequest(
        driver: Driver,
        destination: number,
        apsFrame: BlzApsFrame,
        data: Buffer,
    ): Promise<boolean> {
        return (driver as unknown as {
            brequest: (
                destination: number,
                apsFrame: BlzApsFrame,
                data: Buffer,
            ) => Promise<boolean>;
        }).brequest(destination, apsFrame, data);
    }

    function driverRequest(
        driver: Driver,
        nwk: number | BlzEUI64,
        apsFrame: BlzApsFrame,
        data: Buffer,
    ): Promise<boolean> {
        return (driver as unknown as {
            request: (
                nwk: number | BlzEUI64,
                apsFrame: BlzApsFrame,
                data: Buffer,
            ) => Promise<boolean>;
        }).request(nwk, apsFrame, data);
    }

    function getBackupMan(driver: Driver): {
        createBackup: (assertActive?: () => void) => Promise<unknown>;
        getStoredBackup: () => Promise<unknown>;
    } {
        return (driver as unknown as {
            backupMan: {
                createBackup: (assertActive?: () => void) => Promise<unknown>;
                getStoredBackup: () => Promise<unknown>;
            };
        }).backupMan;
    }

    function bytesThatThrowWhenHexLogged(values: number[], message: string): number[] {
        return new Proxy(values, {
            get(target, property, receiver) {
                if (typeof property === "string" && /^\d+$/.test(property)) {
                    const stack = new Error().stack ?? "";
                    if (stack.includes("bytesToHex")) {
                        throw new Error(message);
                    }
                }

                return Reflect.get(target, property, receiver);
            },
        });
    }

    it("reports coordinator version from the active BLZ transport", () => {
        const version = {product: 7, major: "1", minor: "2", patch: "3", build: "4"};
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        setDriverBlz(driver, {getVersionSnapshot: () => version});

        const coordinatorVersion = driver.getCoordinatorVersion();

        expect(coordinatorVersion).toEqual({
            type: "BLZ v7",
            meta: version,
        });
        expect(coordinatorVersion.meta).not.toBe(version);
    });

    it("does not expose mutable coordinator version metadata", () => {
        const version = {product: 7, major: "1", minor: "2", patch: "3", build: "4"};
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        setDriverBlz(driver, {getVersionSnapshot: () => version});

        const coordinatorVersion = driver.getCoordinatorVersion();
        coordinatorVersion.meta.product = 99;

        expect(driver.getCoordinatorVersion().meta.product).toBe(7);
        expect(version.product).toBe(7);
    });

    it("does not expose mutable coordinator IEEE state", () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        seedNetworkSnapshot(driver);

        const coordinatorIeee = driver.getCoordinatorIeee();
        coordinatorIeee.value[0] = 0xff;

        expect(driver.getCoordinatorIeee().toString()).toBe("0102030405060708");
    });

    it("copies cached coordinator IEEE without a string round trip", () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        seedNetworkSnapshot(driver);
        const expected = Buffer.from("0102030405060708", "hex");
        const toStringSpy = vi.spyOn(BlzEUI64.prototype, "toString").mockImplementation(() => {
            throw new Error("toString used");
        });

        try {
            const ieee = driver.getCoordinatorIeee();

            expect(ieee.value).toEqual(expected);
            expect(toStringSpy).not.toHaveBeenCalled();
        } finally {
            toStringSpy.mockRestore();
        }
    });

    it("routes leave network through the driver command operation path", async () => {
        const leaveNetwork = vi.fn().mockResolvedValue(BlzStatus.SUCCESS);
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        setDriverBlz(driver, {leaveNetwork});

        await expect(driverLeaveNetwork(driver)).resolves.toBe(BlzStatus.SUCCESS);

        expect(leaveNetwork).toHaveBeenCalledTimes(1);
    });

    it("routes explicit form network through the driver command operation path", async () => {
        const formNetwork = vi.fn().mockResolvedValue(BlzStatus.SUCCESS);
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        setDriverBlz(driver, {formNetwork});

        await expect(
            driverFormNetworkWithParameters(driver, 0x0102030405060708n, 0x1234, 15),
        ).resolves.toBe(BlzStatus.SUCCESS);

        expect(formNetwork).toHaveBeenCalledWith(0x0102030405060708n, 0x1234, 15);
    });

    it("creates backups through the driver API", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const backup = {devices: []};
        const assertActive = vi.fn();
        const createBackup = vi.spyOn(getBackupMan(driver), "createBackup").mockResolvedValue(backup);

        await expect(driver.createBackup(assertActive)).resolves.toBe(backup);

        expect(createBackup).toHaveBeenCalledWith(assertActive);
    });

    it("clears pending waiters even when BLZ close rejects", async () => {
        vi.useFakeTimers();
        const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const waiter = waitForDriverZdo(driver, 0x1234, 0x8000, 1000);
        const waiterResult = waiter.start().promise.catch((error: Error) => error);

        setDriverBlz(driver, {
            off: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockRejectedValue(new Error("close failed")),
        });

        await expect(driver.stop()).rejects.toThrow("close failed");

        expect(clearTimeoutSpy).toHaveBeenCalled();
        await expect(waiterResult).resolves.toEqual(new Error("Driver stopped"));
        expect((driver as unknown as {blz?: unknown}).blz).toBeUndefined();
    });

    it("cleans pending state when the lower BLZ transport closes unexpectedly", async () => {
        vi.useFakeTimers();
        const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const waiter = waitForDriverZdo(driver, 0x1234, 0x8000, 1000);
        const waiterResult = waiter.start().promise.catch((error: Error) => error);
        const callback = vi.fn();
        const blzMock = {
            off: vi.fn(),
            close: vi.fn(),
        };
        setDriverBlz(driver, blzMock);
        handleDriverNodeJoined(driver, 0x3344, 0x1111);
        driver.on("close", callback);

        (driver as unknown as {onBlzClose: () => void}).onBlzClose();
        const observed = await Promise.race([
            waiterResult,
            new Promise((resolve) => setImmediate(() => resolve("pending"))),
        ]);

        expect(clearTimeoutSpy).toHaveBeenCalled();
        expect(observed).toEqual(new Error("Driver closed"));
        expect(blzMock.off).toHaveBeenCalledWith("close", expect.any(Function));
        expect(blzMock.off).toHaveBeenCalledWith("reset", expect.any(Function));
        expect(blzMock.off).toHaveBeenCalledWith("frame", expect.any(Function));
        expect((driver as unknown as {blz?: unknown}).blz).toBeUndefined();
        expect(callback).toHaveBeenCalledTimes(1);
    });

    it("clears pending waiters with the reset reason when reset starts", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const waiter = waitForDriverZdo(driver, 0x1234, 0x8000, 1000);
        const waiterResult = waiter.start().promise.catch((error: Error) => error);

        setDriverBlz(driver, {
            off: vi.fn(),
            setResetingProcess: vi.fn(),
            forceReset: vi.fn().mockResolvedValue(undefined),
            close: vi.fn().mockResolvedValue(undefined),
        });

        const reset = driver.reset();
        const observed = await Promise.race([
            waiterResult,
            new Promise((resolve) => setImmediate(() => resolve("pending"))),
        ]);
        void reset.catch(() => {});

        expect(observed).toEqual(new Error("Driver reset"));
    });

    it("handles waiter cancellation before waiters start", () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const waiter = waitForDriverZdo(driver, 0x1234, 0x8000, 1000);

        waiter.cancel();
    });

    it("matches network address response waiters with normalized EUI64 strings", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const waiter = waitForDriverZdo(driver, "0X1122334455667788", Zdo.ClusterId.NETWORK_ADDRESS_RESPONSE, 1000);
        const result = waiter.start().promise.then(
            (response) => response.zdoResponse,
            (error: Error) => `rejected:${error.message}`,
        );

        (driver as unknown as {handleFrame: (frameName: string, frame: BLZFrameData) => void}).handleFrame(
            "apsDataIndication",
            makeIncomingZdoResponseFrame(
                0x3344,
                makeNetworkAddressResponseMessage("0x1122334455667788", 0x3344),
            ),
        );

        await expect(result).resolves.toEqual([
            Zdo.Status.SUCCESS,
            expect.objectContaining({
                eui64: "0x1122334455667788",
                nwkAddress: 0x3344,
            }),
        ]);
    });

    it("sends ZDO requests through driver-owned response waiters", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        setDriverBlz(driver, {});
        const request = vi.spyOn(driver, "request").mockResolvedValue(true);
        const payload = Buffer.from([
            0x00,
            0x88,
            0x77,
            0x66,
            0x55,
            0x44,
            0x33,
            0x22,
            0x11,
            0x00,
            0x00,
        ]);

        const send = driver.sendZdo(
            "0x1122334455667788",
            0x3344,
            Zdo.ClusterId.NETWORK_ADDRESS_REQUEST,
            payload,
            false,
        );
        await Promise.resolve();

        expect(request).toHaveBeenCalledWith(
            0x3344,
            expect.objectContaining({
                profileId: 0,
                clusterId: Zdo.ClusterId.NETWORK_ADDRESS_REQUEST,
                sourceEndpoint: 0,
                destinationEndpoint: 0,
                sequence: 2,
            }),
            Buffer.from([
                0x02,
                0x88,
                0x77,
                0x66,
                0x55,
                0x44,
                0x33,
                0x22,
                0x11,
                0x00,
                0x00,
            ]),
        );

        (driver as unknown as {handleFrame: (frameName: string, frame: BLZFrameData) => void}).handleFrame(
            "apsDataIndication",
            makeIncomingZdoResponseFrame(
                0x3344,
                makeNetworkAddressResponseMessage("0x1122334455667788", 0x3344),
            ),
        );

        await expect(send).resolves.toEqual([
            Zdo.Status.SUCCESS,
            expect.objectContaining({
                eui64: "0x1122334455667788",
                nwkAddress: 0x3344,
            }),
        ]);
        expect(payload[0]).toBe(0x00);
    });

    it("cancels driver-owned ZDO waiters when the lower send rejects", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        setDriverBlz(driver, {});
        vi.spyOn(driver, "request").mockRejectedValue(new Error("driver send failed"));

        await expect(
            driver.sendZdo(
                "0x0102030405060708",
                0x1234,
                Zdo.ClusterId.NODE_DESCRIPTOR_REQUEST,
                Buffer.from([0x00, 0x34, 0x12]),
                false,
            ),
        ).rejects.toThrow("driver send failed");

        expect((driver as unknown as {waitress: {waiters: Map<number, unknown>}}).waitress.waiters.size).toBe(0);
    });

    it("does not mutate or clone caller-owned ZDO payload buffers through Buffer.from when assigning TSN", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        setDriverBlz(driver, {});
        const request = vi.spyOn(driver, "request").mockResolvedValue(true);
        const payload = Buffer.from([0xaa, 0xbb, 0xcc]);
        const originalFrom = Buffer.from;
        const fromSpy = vi.spyOn(Buffer, "from").mockImplementation(((value: unknown, ...args: unknown[]) => {
            if (value === payload) {
                throw new Error("caller payload cloned");
            }

            return (originalFrom as (...parameters: unknown[]) => Buffer)(value, ...args);
        }) as typeof Buffer.from);

        try {
            await driver.sendZdo(
                "0x0102030405060708",
                0x1234,
                Zdo.ClusterId.NODE_DESCRIPTOR_REQUEST,
                payload,
                true,
            );

            expect(payload).toEqual(Buffer.of(0xaa, 0xbb, 0xcc));
            expect(request).toHaveBeenCalledWith(
                0x1234,
                expect.objectContaining({
                    sequence: 2,
                    clusterId: Zdo.ClusterId.NODE_DESCRIPTOR_REQUEST,
                }),
                Buffer.of(2, 0xbb, 0xcc),
            );
            expect(fromSpy).not.toHaveBeenCalledWith(payload);
        } finally {
            fromSpy.mockRestore();
        }
    });

    it("clears address cache when sending a leave request", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        setDriverBlz(driver, {});
        vi.spyOn(driver, "request").mockResolvedValue(true);
        const deviceLeft = vi.fn();
        driver.on("deviceLeft", deviceLeft);
        handleDriverNodeJoined(driver, 0x1234, 0x0102030405060708n);

        await driver.sendZdo(
            "0x0102030405060708",
            0x1234,
            Zdo.ClusterId.LEAVE_REQUEST,
            Buffer.from([0x00]),
            true,
        );

        expect(deviceLeft).toHaveBeenCalledWith(
            0x1234,
            "0x0102030405060708",
        );
        expect((driver as unknown as {nodeIdToEui64: Map<number, unknown>}).nodeIdToEui64.has(0x1234)).toBe(false);
        expect((driver as unknown as {eui64ToNodeId: Map<string, number>}).eui64ToNodeId.has("0102030405060708")).toBe(false);
    });

    it("clears address cache when stopping", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        handleDriverNodeJoined(driver, 0x3344, 0x1111);
        setDriverBlz(driver, {
            off: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        });

        await driver.stop(false);

        const execCommand = vi.fn().mockResolvedValue({
            status: BlzStatus.SUCCESS,
            eui64: Buffer.from("0000000000003344", "hex"),
        });
        setDriverBlz(driver, {execCommand});
        const eui64 = await driver.networkIdToEUI64(0x3344);

        expect(execCommand).toHaveBeenCalledWith("getEui64ByNodeId", {nodeId: 0x3344});
        expect(eui64.toString()).toBe("0000000000003344");
    });

    it("does not expose mutable cached EUI64 objects", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const source = new BlzEUI64("0000000000003344");

        cacheDriverNode(driver, 0x3344, source);
        (source as unknown as {_value: Buffer})._value[7] = 0xff;

        const firstLookup = await driver.networkIdToEUI64(0x3344);
        expect(firstLookup.toString()).toBe("0000000000003344");

        (firstLookup as unknown as {_value: Buffer})._value[7] = 0xee;

        const secondLookup = await driver.networkIdToEUI64(0x3344);
        expect(secondLookup.toString()).toBe("0000000000003344");
    });

    it("clears cached coordinator and network snapshot when stopping", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        seedNetworkSnapshot(driver);
        setDriverBlz(driver, {
            off: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        });

        await driver.stop(false);

        expect((driver as unknown as {networkParams?: BlzNetworkParameters}).networkParams).toBeUndefined();
        expect((driver as unknown as {ieee?: BlzEUI64}).ieee).toBeUndefined();
    });

    it("does not expose mutable network parameter snapshots", () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        seedNetworkSnapshot(driver);

        const snapshot = driver.getNetworkParametersSnapshot();
        snapshot.Channel = 20;
        snapshot.nwkUpdateId = 10;
        snapshot.extendedPanId[0] = 0xff;

        const sourceExtendedPanId = (
            driver as unknown as {networkParams: BlzNetworkParameters}
        ).networkParams.extendedPanId;
        const originalFrom = Buffer.from;
        const fromSpy = vi.spyOn(Buffer, "from").mockImplementation(((value: unknown, ...args: unknown[]) => {
            if (value === sourceExtendedPanId) {
                throw new Error("snapshot extended PAN ID clone used");
            }

            return (originalFrom as (...parameters: unknown[]) => Buffer)(value, ...args);
        }) as typeof Buffer.from);

        try {
            const freshSnapshot = driver.getNetworkParametersSnapshot();

            expect(freshSnapshot).not.toBe(snapshot);
            expect(freshSnapshot.Channel).toBe(11);
            expect(freshSnapshot.nwkUpdateId).toBe(0);
            expect(freshSnapshot.channels).toBe(2 ** 11);
            expect(freshSnapshot.extendedPanId).toEqual(Buffer.of(1, 2, 3, 4, 5, 6, 7, 8));
            expect(freshSnapshot.extendedPanId).not.toBe(sourceExtendedPanId);
            expect(fromSpy).not.toHaveBeenCalledWith(sourceExtendedPanId);
        } finally {
            fromSpy.mockRestore();
        }
    });

    it("keeps cached channel mask aligned when network parameters are updated", () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        seedNetworkSnapshot(driver);

        updateDriverNetworkParametersSnapshot(driver, 20, 3);

        const snapshot = driver.getNetworkParametersSnapshot();
        expect(snapshot.Channel).toBe(20);
        expect(snapshot.nwkUpdateId).toBe(3);
        expect(snapshot.channels).toBe(2 ** 20);
    });

    it("changes channel inside the driver while preserving network identity", async () => {
        vi.useFakeTimers();
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        seedNetworkSnapshot(driver);
        (driver as unknown as {networkParams: BlzNetworkParameters}).networkParams.panId = 0x2ea0;
        (driver as unknown as {networkParams: BlzNetworkParameters}).networkParams.extendedPanId = Buffer.from(
            "b3c6675b7437d674",
            "hex",
        );
        const nwkKey = Buffer.from("05b02757f70f2384c89cf08592bdfb4f", "hex");
        const linkKey = Buffer.alloc(16);
        const execCommand = vi.fn((command: string) => {
            switch (command) {
                case "getNwkSecurityInfos":
                    return Promise.resolve({
                        status: BlzStatus.SUCCESS,
                        nwkKey,
                        outgoingFrameCounter: 40968,
                        nwkKeySeqNum: 0,
                    });
                case "getGlobalTcLinkKey":
                    return Promise.resolve({
                        status: BlzStatus.SUCCESS,
                        linkKey,
                        outgoingFrameCounter: 7,
                        trustCenterAddress: 0,
                    });
                case "setNwkSecurityInfos":
                case "setGlobalTcLinkKey":
                    return Promise.resolve({status: BlzStatus.SUCCESS});
                default:
                    throw new Error(`unexpected command ${command}`);
            }
        });
        const leaveNetwork = vi.fn().mockResolvedValue(BlzStatus.SUCCESS);
        const formNetwork = vi.fn().mockResolvedValue(BlzStatus.SUCCESS);
        setDriverBlz(driver, {execCommand, leaveNetwork, formNetwork});

        const change = driver.changeChannel(15, 1);
        await vi.advanceTimersByTimeAsync(24000);
        await change;

        expect(leaveNetwork).toHaveBeenCalledTimes(1);
        expect(execCommand).toHaveBeenCalledWith("setNwkSecurityInfos", {
            nwkKey,
            outgoingFrameCounter: 40968,
            nwkKeySeqNum: 0,
        });
        expect(execCommand).toHaveBeenCalledWith("setGlobalTcLinkKey", {
            linkKey,
            outgoingFrameCounter: 7,
        });
        expect(formNetwork).toHaveBeenCalledWith(
            BigInt("0xb3c6675b7437d674"),
            0x2ea0,
            15,
        );
        const snapshot = driver.getNetworkParametersSnapshot();
        expect(snapshot.Channel).toBe(15);
        expect(snapshot.nwkUpdateId).toBe(1);
        expect(snapshot.channels).toBe(2 ** 15);
    });

    it("cancels a driver-owned channel change delay when stopping", async () => {
        vi.useFakeTimers();
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        seedNetworkSnapshot(driver);
        const execCommand = vi.fn((command: string) => {
            switch (command) {
                case "getNwkSecurityInfos":
                    return Promise.resolve({
                        status: BlzStatus.SUCCESS,
                        nwkKey: Buffer.alloc(16),
                        outgoingFrameCounter: 1,
                        nwkKeySeqNum: 0,
                    });
                case "getGlobalTcLinkKey":
                    return Promise.resolve({
                        status: BlzStatus.SUCCESS,
                        linkKey: Buffer.alloc(16),
                        outgoingFrameCounter: 1,
                        trustCenterAddress: 0,
                    });
                default:
                    throw new Error(`unexpected command ${command}`);
            }
        });
        const leaveNetwork = vi.fn();
        const formNetwork = vi.fn();
        setDriverBlz(driver, {
            execCommand,
            leaveNetwork,
            formNetwork,
            off: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        });

        const change = driver.changeChannel(15, 1);
        const changeResult = change.then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
        );
        await vi.advanceTimersByTimeAsync(0);

        await driver.stop(false);
        await vi.advanceTimersByTimeAsync(0);
        const observed = await Promise.race([
            changeResult,
            Promise.resolve("pending"),
        ]);

        void change.catch(() => {});

        expect(observed).toBe("rejected:Driver stopped");
        expect(leaveNetwork).not.toHaveBeenCalled();
        expect(formNetwork).not.toHaveBeenCalled();
    });

    it("cancels network ID to EUI64 lookup when stopping", async () => {
        vi.useFakeTimers();
        const execCommand = vi.fn().mockReturnValue(new Promise(() => {}));
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        setDriverBlz(driver, {
            execCommand,
            off: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        });
        const lookup = driver.networkIdToEUI64(0x3344);
        const lookupResult = lookup.then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
        );
        await vi.advanceTimersByTimeAsync(0);

        await driver.stop(false);
        await vi.advanceTimersByTimeAsync(0);
        const observed = await Promise.race([
            lookupResult,
            Promise.resolve("pending"),
        ]);

        void lookup.catch(() => {});

        expect(observed).toBe("rejected:Driver stopped");
        expect(execCommand).toHaveBeenCalledWith("getEui64ByNodeId", {nodeId: 0x3344});
    });

    it.each([
        {
            name: "permitJoining",
            invoke: (driver: Driver) => driver.permitJoining(60),
            expectedCommand: "permitJoining",
            hasParameters: true,
        },
        {
            name: "addEndpoint",
            invoke: (driver: Driver) => driver.addEndpoint({endpoint: 1}),
            expectedCommand: "addEndpoint",
            hasParameters: true,
        },
        {
            name: "getGlobalTcLinkKey",
            invoke: (driver: Driver) => driverGetGlobalTcLinkKey(driver),
            expectedCommand: "getGlobalTcLinkKey",
            hasParameters: false,
        },
        {
            name: "setGlobalTcLinkKey",
            invoke: (driver: Driver) =>
                driverSetGlobalTcLinkKey(driver, Buffer.alloc(16), 0),
            expectedCommand: "setGlobalTcLinkKey",
            hasParameters: true,
        },
        {
            name: "getNetworkKeyInfo",
            invoke: (driver: Driver) => driverGetNetworkKeyInfo(driver),
            expectedCommand: "getNwkSecurityInfos",
            hasParameters: false,
        },
        {
            name: "getCurrentNetworkParameters",
            invoke: (driver: Driver) => driverGetCurrentNetworkParameters(driver),
            expectedCommand: "getNetworkParameters",
            hasParameters: false,
        },
        {
            name: "getMacAddress",
            invoke: (driver: Driver) => driverGetMacAddress(driver),
            expectedCommand: "getValue",
            hasParameters: true,
        },
        {
            name: "setNetworkKeyInfo",
            invoke: (driver: Driver) =>
                driverSetNetworkKeyInfo(driver, Buffer.alloc(16), 0, 0),
            expectedCommand: "setNwkSecurityInfos",
            hasParameters: true,
        },
    ])("cancels $name when stopping while the lower command is pending", async ({
        invoke,
        expectedCommand,
        hasParameters,
    }) => {
        const execCommand = vi.fn().mockReturnValue(new Promise(() => {}));
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        setDriverBlz(driver, {
            execCommand,
            off: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        });

        const operation = invoke(driver);
        const operationResult = operation.then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
        );
        await Promise.resolve();

        await driver.stop(false);
        await new Promise((resolve) => setImmediate(resolve));
        const observed = await Promise.race([
            operationResult,
            Promise.resolve("pending"),
        ]);

        void operation.catch(() => {});

        expect(observed).toBe("rejected:Driver stopped");
        if (hasParameters) {
            expect(execCommand).toHaveBeenCalledWith(
                expectedCommand,
                expect.anything(),
            );
        } else {
            expect(execCommand).toHaveBeenCalledWith(expectedCommand);
        }
    });

    it("releases the BLZ instance reference when stopping", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const blzMock = {
            off: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        setDriverBlz(driver, blzMock);

        await driver.stop(false);

        expect(blzMock.close).toHaveBeenCalledWith(false);
        expect((driver as unknown as {blz?: unknown}).blz).toBeUndefined();
    });

    it("emits close when explicitly stopped with emitClose", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const callback = vi.fn();
        const blzMock = {
            off: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        setDriverBlz(driver, blzMock);
        driver.on("close", callback);

        await driver.stop(true);

        expect(callback).toHaveBeenCalledTimes(1);
        expect(blzMock.close).toHaveBeenCalledWith(true);
    });

    it("coalesces concurrent stop calls against the same BLZ instance", async () => {
        let releaseClose: (() => void) | undefined;
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const blzMock = {
            off: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockReturnValue(
                new Promise<void>((resolve) => {
                    releaseClose = resolve;
                }),
            ),
        };
        setDriverBlz(driver, blzMock);

        const firstStop = driver.stop(false);
        await Promise.resolve();
        const secondStop = driver.stop(false);
        await Promise.resolve();

        expect(blzMock.close).toHaveBeenCalledTimes(1);

        releaseClose?.();
        await Promise.all([firstStop, secondStop]);
        expect((driver as unknown as {blz?: unknown}).blz).toBeUndefined();
    });

    it("emits close when a concurrent explicit stop joins an in-flight silent stop", async () => {
        let releaseClose: (() => void) | undefined;
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const callback = vi.fn();
        const blzMock = {
            off: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockReturnValue(
                new Promise<void>((resolve) => {
                    releaseClose = resolve;
                }),
            ),
        };
        setDriverBlz(driver, blzMock);
        driver.on("close", callback);

        const firstStop = driver.stop(false);
        await Promise.resolve();
        const secondStop = driver.stop(true);
        await Promise.resolve();

        expect(blzMock.close).toHaveBeenCalledWith(false);

        releaseClose?.();
        await Promise.all([firstStop, secondStop]);

        expect(callback).toHaveBeenCalledTimes(1);
    });

    it("detaches owned BLZ listeners without broad listener cleanup when stopping", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const blzMock = {
            off: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        setDriverBlz(driver, blzMock);

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
        setDriverBlz(driver, blzMock);
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
        setDriverBlz(driver, blzMock);
        const startup = vi.spyOn(driver, "startup").mockResolvedValue("resumed");

        const reset = driver.reset();
        await vi.advanceTimersByTimeAsync(1000);
        await driver.stop(false);
        await vi.advanceTimersByTimeAsync(3000);
        await reset;

        expect(startup).not.toHaveBeenCalled();
    });

    it("does not start reset recovery while driver stop is in progress", async () => {
        vi.useFakeTimers();
        let releaseClose: (() => void) | undefined;
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const blzMock = {
            setResetingProcess: vi.fn(),
            forceReset: vi.fn().mockResolvedValue(undefined),
            off: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockReturnValue(
                new Promise<void>((resolve) => {
                    releaseClose = resolve;
                }),
            ),
        };
        setDriverBlz(driver, blzMock);
        const startup = vi.spyOn(driver, "startup").mockResolvedValue("resumed");

        const stop = driver.stop(false);
        await vi.advanceTimersByTimeAsync(0);
        const reset = driver.reset();
        await vi.advanceTimersByTimeAsync(0);

        expect(blzMock.forceReset).not.toHaveBeenCalled();
        expect(startup).not.toHaveBeenCalled();

        releaseClose?.();
        await Promise.all([stop, reset]);
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
        setDriverBlz(driver, blzMock);
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
        setDriverBlz(driver, blzMock);
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
        setDriverBlz(driver, blzMock);

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

        await expect(driverMrequest(driver, apsFrame, data)).resolves.toBe(false);

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

        await expect(driverBrequest(driver, 0xfffc, apsFrame, data)).resolves.toBe(false);

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

    it("builds multicast ZCL APS frames inside the driver API", async () => {
        const sendApsData = vi.fn().mockResolvedValue(BlzStatus.SUCCESS);
        const driver = makeDriverWithApsSender(sendApsData);
        const data = Buffer.from([0x11, 0x12]);

        await expect(
            driver.sendZclMulticast(0x1234, 0x0006, 0x0105, 5, data),
        ).resolves.toBe(true);

        expect(sendApsData).toHaveBeenCalledWith(
            BlzOutgoingMessageType.BLZ_MSG_TYPE_MULTICAST,
            0x1234,
            0x0105,
            0x0006,
            5,
            0xff,
            0,
            5,
            0x03,
            data.length,
            data,
        );
    });

    it("builds broadcast ZCL APS frames inside the driver API", async () => {
        const sendApsData = vi.fn().mockResolvedValue(BlzStatus.SUCCESS);
        const driver = makeDriverWithApsSender(sendApsData);
        const data = Buffer.from([0x13, 0x14]);

        await expect(
            driver.sendZclBroadcast(ZSpec.BroadcastAddress.DEFAULT, 0x0006, 0x0105, 2, 3, data),
        ).resolves.toBe(true);

        expect(sendApsData).toHaveBeenCalledWith(
            BlzOutgoingMessageType.BLZ_MSG_TYPE_BROADCAST,
            ZSpec.BroadcastAddress.DEFAULT,
            0x0105,
            0x0006,
            2,
            3,
            0,
            5,
            0x03,
            data.length,
            data,
        );
    });

    it("builds endpoint ZCL APS frames and caches the destination inside the driver API", async () => {
        const sendApsData = vi.fn().mockResolvedValue(BlzStatus.SUCCESS);
        const driver = makeDriverWithApsSender(sendApsData);
        const data = Buffer.from([0x15, 0x16]);

        await expect(
            driver.sendZclEndpoint(
                "0x0102030405060708",
                0x1234,
                0x0006,
                0x0105,
                2,
                3,
                data,
            ),
        ).resolves.toBe(true);

        expect(sendApsData).toHaveBeenCalledWith(
            BlzOutgoingMessageType.BLZ_MSG_TYPE_UNICAST,
            0x1234,
            0x0105,
            0x0006,
            2,
            3,
            0,
            5,
            0x03,
            data.length,
            data,
        );
        expect((driver as unknown as {eui64ToNodeId: Map<string, number>}).eui64ToNodeId.get("0102030405060708")).toBe(0x1234);
    });

    it("stops active multicast and broadcast APS requests when driver stop interrupts the lower send", async () => {
        vi.useFakeTimers();
        const sendApsData = vi.fn().mockReturnValue(new Promise(() => {}));
        const blzMock = {
            sendApsData,
            off: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        setDriverBlz(driver, blzMock);
        const apsFrame = makeApsFrame();
        const data = Buffer.from([0x06, 0x07]);
        const multicast = driverMrequest(driver, apsFrame, data);
        const broadcast = driverBrequest(driver, 0xfffc, apsFrame, data);
        const multicastResult = multicast.then((value) => `resolved:${value}`);
        const broadcastResult = broadcast.then((value) => `resolved:${value}`);

        await vi.advanceTimersByTimeAsync(0);
        await driver.stop(false);
        await vi.advanceTimersByTimeAsync(0);
        const observedPromise = Promise.race([
            Promise.all([multicastResult, broadcastResult]),
            new Promise((resolve) => setTimeout(() => resolve("pending"), 1)),
        ]);
        await vi.advanceTimersByTimeAsync(1);
        const observed = await observedPromise;

        void multicast.catch(() => {});
        void broadcast.catch(() => {});

        expect(observed).toEqual(["resolved:false", "resolved:false"]);
        expect(sendApsData).toHaveBeenCalledTimes(2);
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
        setDriverBlz(driver, blzMock);
        const request = driverRequest(driver, 0x3344, makeApsFrame(), Buffer.from([0x0c]));
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
        setDriverBlz(driver, blzMock);
        const request = driverRequest(driver, 0x3344, makeApsFrame(), Buffer.from([0x0c]));
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

    it("stops active APS requests when driver reset starts", async () => {
        vi.useFakeTimers();
        const sendApsData = vi.fn().mockReturnValue(new Promise(() => {}));
        const blzMock = {
            sendApsData,
            setResetingProcess: vi.fn(),
            forceReset: vi.fn().mockResolvedValue(undefined),
        };
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        setDriverBlz(driver, blzMock);
        vi.spyOn(driver, "stop").mockResolvedValue(undefined);
        vi.spyOn(driver, "startup").mockResolvedValue("resumed");
        const request = driverRequest(driver, 0x3344, makeApsFrame(), Buffer.from([0x0c]));
        const requestResult = request.then((value) => `resolved:${value}`);

        await vi.advanceTimersByTimeAsync(0);
        const reset = driver.reset();
        await vi.advanceTimersByTimeAsync(0);
        const observed = await Promise.race([
            requestResult,
            Promise.resolve("pending"),
        ]);

        await vi.advanceTimersByTimeAsync(3000);
        await reset;
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
        setDriverBlz(driver, blzMock);
        const request = driverRequest(driver, new BlzEUI64("0000000000003344"), makeApsFrame(), Buffer.from([0x0c]));
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
        setDriverBlz(driver, oldBlzMock);

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

    it("cancels startup when reset interrupts BLZ connect", async () => {
        vi.useFakeTimers();
        const blzMock = {
            on: vi.fn(),
            off: vi.fn(),
            connect: vi.fn().mockReturnValue(new Promise<void>(() => {})),
            forceReset: vi.fn().mockResolvedValue(undefined),
            setResetingProcess: vi.fn(),
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

        const reset = driver.reset();
        await vi.advanceTimersByTimeAsync(0);
        const observed = await Promise.race([
            startupResult,
            Promise.resolve("pending"),
        ]);

        await vi.advanceTimersByTimeAsync(3000);
        void reset.catch(() => {});
        void startup.catch(() => {});

        expect(observed).toBe("rejected:Driver reset");
        expect(blzMock.close).toHaveBeenCalledWith(false);
    });

    it("restarts after reset interrupts a startup delay", async () => {
        vi.useFakeTimers();
        const firstBlzMock = {
            on: vi.fn(),
            off: vi.fn(),
            connect: vi.fn().mockResolvedValue(undefined),
            forceReset: vi.fn().mockResolvedValue(undefined),
            getVersion: vi.fn(),
            networkInit: vi.fn(),
            execCommand: vi.fn(),
            setResetingProcess: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        const secondBlzMock = {
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
                .mockResolvedValueOnce({
                    status: BlzStatus.SUCCESS,
                    value: Buffer.from("000052df5c74e14c", "hex"),
                }),
            setResetingProcess: vi.fn(),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        blzConstructorMock
            .mockImplementationOnce(() => firstBlzMock)
            .mockImplementationOnce(() => secondBlzMock);
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        vi.spyOn(driver, "addEndpoint").mockResolvedValue(undefined);

        const startup = driver.startup();
        const startupResult = startup.then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
        );
        await vi.advanceTimersByTimeAsync(1000);

        const reset = driver.reset();
        await vi.advanceTimersByTimeAsync(8000);

        await expect(reset).resolves.toBeUndefined();
        await expect(startupResult).resolves.toBe("rejected:Driver reset");
        expect(blzConstructorMock).toHaveBeenCalledTimes(2);
        expect((driver as unknown as {blz?: unknown}).blz).toBe(secondBlzMock);
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

    it("does not start runtime reset recovery for the expected startup reset", async () => {
        vi.useFakeTimers();
        let resetHandler: (() => void | Promise<void>) | undefined;
        const blzMock = {
            on: vi.fn((event: string, handler: () => void | Promise<void>) => {
                if (event === "reset") {
                    resetHandler = handler;
                }
            }),
            off: vi.fn(),
            connect: vi.fn().mockResolvedValue(undefined),
            forceReset: vi.fn().mockImplementation(async () => {
                resetHandler?.();
            }),
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
                .mockResolvedValueOnce({
                    status: BlzStatus.SUCCESS,
                    value: Buffer.from("000052df5c74e14c", "hex"),
                }),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        blzConstructorMock.mockImplementation(() => blzMock);
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const reset = vi.spyOn(driver, "reset").mockResolvedValue(undefined);
        vi.spyOn(driver, "addEndpoint").mockResolvedValue(undefined);

        const startup = driver.startup();
        await vi.advanceTimersByTimeAsync(3000);
        await startup;

        expect(reset).not.toHaveBeenCalled();
    });

    it("stores startup extended PAN ID without zero-fill allocation", async () => {
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
                .mockResolvedValueOnce({
                    status: BlzStatus.SUCCESS,
                    value: Buffer.from("000052df5c74e14c", "hex"),
                }),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        blzConstructorMock.mockImplementation(() => blzMock);
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        vi.spyOn(driver, "addEndpoint").mockResolvedValue(undefined);
        const originalAlloc = Buffer.alloc;
        const allocSpy = vi.spyOn(Buffer, "alloc").mockImplementation(((size: number, ...args: unknown[]) => {
            if (size === 8) {
                throw new Error("Buffer.alloc(8) used");
            }

            return (originalAlloc as (...parameters: unknown[]) => Buffer)(size, ...args);
        }) as typeof Buffer.alloc);

        try {
            const startup = driver.startup();
            await vi.advanceTimersByTimeAsync(3000);
            await startup;

            expect(driver.getNetworkParametersSnapshot().extendedPanId).toEqual(
                Buffer.from("0807060504030201", "hex"),
            );
            expect(allocSpy).not.toHaveBeenCalledWith(8);
        } finally {
            allocSpy.mockRestore();
        }
    });

    it("fails startup when final network parameter probe reports a non-success status", async () => {
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
                    status: BlzStatus.GENERAL_ERROR,
                    nodeType: 0,
                    panId: networkOptions.panID,
                    extPanId: 0x0807060504030201n,
                    channel: 11,
                    nwkUpdateId: 0,
                }),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        blzConstructorMock.mockImplementation(() => blzMock);
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        vi.spyOn(driver, "addEndpoint").mockResolvedValue(undefined);

        const startup = driver.startup();
        const rejection = expect(startup).rejects.toThrow("getNetworkParameters failed");
        await vi.advanceTimersByTimeAsync(3000);

        await rejection;
        expect(blzMock.execCommand).not.toHaveBeenCalledWith("getValue", expect.anything());
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

    it("does not continue startup network validation after stop interrupts network init", async () => {
        vi.useFakeTimers();
        let finishNetworkInit: (() => void) | undefined;
        const blzMock = {
            on: vi.fn(),
            off: vi.fn(),
            connect: vi.fn().mockResolvedValue(undefined),
            forceReset: vi.fn().mockResolvedValue(undefined),
            getVersion: vi.fn().mockResolvedValue(undefined),
            networkInit: vi.fn().mockReturnValue(
                new Promise<boolean>((resolve) => {
                    finishNetworkInit = () => resolve(true);
                }),
            ),
            execCommand: vi.fn(),
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
        await vi.advanceTimersByTimeAsync(2000);
        await vi.advanceTimersByTimeAsync(0);

        await driver.stop(false);
        finishNetworkInit?.();
        await vi.advanceTimersByTimeAsync(0);
        const observed = await Promise.race([
            startupResult,
            Promise.resolve("pending"),
        ]);

        void startup.catch(() => {});

        expect(observed).toBe("rejected:Driver stopped");
        expect(blzMock.execCommand).not.toHaveBeenCalled();
    });

    it("forms a new network when initial network parameters return only an error status", async () => {
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
                    status: BlzStatus.GENERAL_ERROR,
                })
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
                    value: Buffer.from("000052df5c74e14c", "hex"),
                }),
            leaveNetwork: vi.fn().mockResolvedValue(BlzStatus.SUCCESS),
            formNetwork: vi.fn().mockResolvedValue(BlzStatus.SUCCESS),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        blzConstructorMock.mockImplementation(() => blzMock);
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        vi.spyOn(driver, "addEndpoint").mockResolvedValue(undefined);
        spyOnDriverSetNetworkKeyInfo(driver).mockResolvedValue(BlzStatus.SUCCESS);
        vi.spyOn(getBackupMan(driver), "getStoredBackup").mockResolvedValue(undefined);

        const startup = driver.startup();
        const startupResult = expect(startup).resolves.toBe("reset");
        await vi.advanceTimersByTimeAsync(5000);

        await startupResult;
        expect(blzMock.formNetwork).toHaveBeenCalledTimes(1);
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
        vi.spyOn(getBackupMan(driver), "getStoredBackup").mockReturnValue(new Promise(() => {}));

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
        expect(getBackupMan(driver).getStoredBackup).toHaveBeenCalled();
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
        vi.spyOn(getBackupMan(driver), "getStoredBackup").mockResolvedValue(null);

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
        spyOnDriverSetNetworkKeyInfo(driver).mockResolvedValue(BlzStatus.SUCCESS);
        vi.spyOn(getBackupMan(driver), "getStoredBackup").mockResolvedValue(null);

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

    it("does not continue startup network formation after stop interrupts key update", async () => {
        vi.useFakeTimers();
        let finishSetNetworkKeyInfo: (() => void) | undefined;
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
            formNetwork: vi.fn().mockResolvedValue(BlzStatus.SUCCESS),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        blzConstructorMock.mockImplementation(() => blzMock);
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        vi.spyOn(driver, "addEndpoint").mockResolvedValue(undefined);
        spyOnDriverSetNetworkKeyInfo(driver).mockReturnValue(
            new Promise<BlzStatus>((resolve) => {
                finishSetNetworkKeyInfo = () => resolve(BlzStatus.SUCCESS);
            }),
        );
        vi.spyOn(getBackupMan(driver), "getStoredBackup").mockResolvedValue(null);

        const startup = driver.startup();
        const startupResult = startup.then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
        );
        await vi.advanceTimersByTimeAsync(4000);
        await vi.advanceTimersByTimeAsync(0);

        await driver.stop(false);
        finishSetNetworkKeyInfo?.();
        await vi.advanceTimersByTimeAsync(0);
        const observed = await Promise.race([
            startupResult,
            Promise.resolve("pending"),
        ]);

        void startup.catch(() => {});

        expect(observed).toBe("rejected:Driver stopped");
        expect(blzMock.formNetwork).not.toHaveBeenCalled();
        expect((driver as unknown as {blz?: unknown}).blz).toBeUndefined();
    });

    it("fails startup when forming a new network returns a non-success status", async () => {
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
            formNetwork: vi.fn().mockResolvedValue(BlzStatus.GENERAL_ERROR),
            removeAllListeners: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
        };
        blzConstructorMock.mockImplementation(() => blzMock);
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        vi.spyOn(driver, "addEndpoint").mockResolvedValue(undefined);
        spyOnDriverSetNetworkKeyInfo(driver).mockResolvedValue(BlzStatus.SUCCESS);
        vi.spyOn(getBackupMan(driver), "getStoredBackup").mockResolvedValue(undefined);

        const startup = driver.startup();
        const rejection = expect(startup).rejects.toThrow("Failed to form network");
        await vi.advanceTimersByTimeAsync(6000);

        await rejection;
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

        handleDriverNodeJoined(driver, 0x3344, 0x123456);
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

        handleDriverNodeLeft(driver, 0x3344, "0x0000000000123456");
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

    it("emits malformed ZDO responses without throwing from the receive handler", () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const incomingMessage = vi.fn();
        const message = Buffer.from([0x00]);
        driver.on("incomingMessage", incomingMessage);

        expect(() =>
            (driver as unknown as {handleFrame: (frameName: string, frame: BLZFrameData) => void}).handleFrame(
                "apsDataIndication",
                makeIncomingZdoResponseFrame(0x3344, message),
            ),
        ).not.toThrow();

        expect(incomingMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                sender: 0x3344,
                message,
                zdoResponse: undefined,
            }),
        );
    });

    it("handles bigint EUI64 values from device join callbacks", () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const deviceJoined = vi.fn();
        driver.on("deviceJoined", deviceJoined);

        expect(() =>
            (driver as unknown as {handleFrame: (frameName: string, frame: BLZFrameData) => void}).handleFrame(
                "deviceJoinCallback",
                {
                    nodeId: 0x3344,
                    eui64: 0x0000000000123456n,
                    status: 0x01,
                } as BLZFrameData,
            ),
        ).not.toThrow();

        expect(deviceJoined).toHaveBeenCalledWith(
            0x3344,
            "0x0000000000123456",
        );
    });

    it("removes stale EUI64 mappings when a node ID is re-cached with a new EUI64", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const execCommand = vi.fn().mockResolvedValue({nodeId: 0x5566});
        const sendApsData = vi.fn().mockResolvedValue(BlzStatus.SUCCESS);
        setDriverBlz(driver, {execCommand, sendApsData});
        const apsFrame = makeApsFrame();
        const data = Buffer.from([0x08, 0x09]);

        handleDriverNodeJoined(driver, 0x3344, 0x1111);
        handleDriverNodeJoined(driver, 0x3344, 0x2222);

        await expect(driverRequest(driver, new BlzEUI64("0000000000001111"), apsFrame, data)).resolves.toBe(true);

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

    it("removes cached EUI64 mappings by node ID when leave uses a different IEEE", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const execCommand = vi.fn().mockResolvedValue({nodeId: 0x5566});
        const sendApsData = vi.fn().mockResolvedValue(BlzStatus.SUCCESS);
        setDriverBlz(driver, {execCommand, sendApsData});
        const apsFrame = makeApsFrame();
        const data = Buffer.from([0x0d, 0x0e]);

        handleDriverNodeJoined(driver, 0x3344, 0x1111);
        handleDriverNodeLeft(driver, 0x3344, "0x0000000000002222");

        await expect(driverRequest(driver, new BlzEUI64("0000000000001111"), apsFrame, data)).resolves.toBe(true);

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
        setDriverBlz(driver, {execCommand, sendApsData});
        driver.on("incomingMessage", incomingMessage);
        const apsFrame = makeApsFrame();
        const data = Buffer.from([0x0a, 0x0b]);

        await expect(driverRequest(driver, new BlzEUI64("0000000000007788"), apsFrame, data)).resolves.toBe(true);
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

    it("treats node ID 0 as a valid EUI64 lookup result", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const execCommand = vi.fn().mockResolvedValue({nodeId: 0x0000});
        const sendApsData = vi.fn().mockResolvedValue(BlzStatus.SUCCESS);
        setDriverBlz(driver, {execCommand, sendApsData});
        const apsFrame = makeApsFrame();
        const data = Buffer.from([0x0f, 0x10]);

        await expect(driverRequest(driver, new BlzEUI64("0000000000000001"), apsFrame, data)).resolves.toBe(true);

        expect(sendApsData).toHaveBeenCalledWith(
            BlzOutgoingMessageType.BLZ_MSG_TYPE_UNICAST,
            0x0000,
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

    it("matches driver waiters for coordinator address 0 only against address 0", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const waiter = waitForDriverZdo(driver, 0x0000, 0x0006, 1000);
        const result = waiter.start().promise.then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
        );

        (driver as unknown as {handleFrame: (frameName: string, frame: BLZFrameData) => void}).handleFrame(
            "apsDataIndication",
            makeIncomingApsFrame(0x1234),
        );
        await Promise.resolve();
        const observed = await Promise.race([
            result,
            Promise.resolve("pending"),
        ]);
        waiter.cancel();

        expect(observed).toBe("pending");
    });

    it("clears address cache when forming a new network", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const formNetwork = vi.fn().mockResolvedValue(BlzStatus.SUCCESS);
        const execCommand = vi.fn().mockResolvedValue({
            status: BlzStatus.SUCCESS,
            eui64: Buffer.from("0000000000003344", "hex"),
        });
        spyOnDriverSetNetworkKeyInfo(driver).mockResolvedValue(BlzStatus.SUCCESS);
        setDriverBlz(driver, {formNetwork, execCommand});

        handleDriverNodeJoined(driver, 0x3344, 0x1111);
        seedNetworkSnapshot(driver);
        await (driver as unknown as {formNetwork: (restore: boolean) => Promise<void>}).formNetwork(false);
        const eui64 = await driver.networkIdToEUI64(0x3344);

        expect((driver as unknown as {networkParams?: BlzNetworkParameters}).networkParams).toBeUndefined();
        expect(execCommand).toHaveBeenCalledWith("getEui64ByNodeId", {nodeId: 0x3344});
        expect(eui64.toString()).toBe("0000000000003344");
    });

    it("forms a new network without cloning configured network bytes", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const formNetwork = vi.fn().mockResolvedValue(BlzStatus.SUCCESS);
        spyOnDriverSetNetworkKeyInfo(driver).mockResolvedValue(BlzStatus.SUCCESS);
        setDriverBlz(driver, {formNetwork});
        const originalFrom = Buffer.from;
        const fromSpy = vi.spyOn(Buffer, "from").mockImplementation(((value: unknown, ...args: unknown[]) => {
            if (value === networkOptions.extendedPanID || value === networkOptions.networkKey) {
                throw new Error("configured network bytes clone used");
            }

            return (originalFrom as (...parameters: unknown[]) => Buffer)(value, ...args);
        }) as typeof Buffer.from);

        try {
            await (driver as unknown as {formNetwork: (restore: boolean) => Promise<void>}).formNetwork(false);

            expect(formNetwork).toHaveBeenCalledWith(0x0807060504030201n, networkOptions.panID, 11);
            expect(fromSpy).not.toHaveBeenCalledWith(networkOptions.extendedPanID);
            expect(fromSpy).not.toHaveBeenCalledWith(networkOptions.networkKey);
        } finally {
            fromSpy.mockRestore();
        }
    });

    it("restores a network from a string backup key without Buffer.from hex conversion", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        const formNetwork = vi.fn().mockResolvedValue(BlzStatus.SUCCESS);
        const setNetworkKeyInfo = spyOnDriverSetNetworkKeyInfo(driver).mockResolvedValue(BlzStatus.SUCCESS);
        const networkKey = "0102030405060708090a0b0c0d0e0f10";
        vi.spyOn(getBackupMan(driver), "getStoredBackup").mockResolvedValue({
            networkOptions: {
                panId: networkOptions.panID,
                extendedPanId: Buffer.of(1, 2, 3, 4, 5, 6, 7, 8),
                networkKey,
            },
            networkKeyInfo: {
                sequenceNumber: 5,
                frameCounter: 1234,
            },
            logicalChannel: 11,
        } as any);
        setDriverBlz(driver, {formNetwork});
        const originalFrom = Buffer.from;
        const fromSpy = vi.spyOn(Buffer, "from").mockImplementation(((value: unknown, ...args: unknown[]) => {
            if (value === networkKey) {
                throw new Error("backup network key hex conversion used");
            }

            return (originalFrom as (...parameters: unknown[]) => Buffer)(value, ...args);
        }) as typeof Buffer.from);

        try {
            await (driver as unknown as {formNetwork: (restore: boolean) => Promise<void>}).formNetwork(true);

            expect(setNetworkKeyInfo).toHaveBeenCalledWith(
                Buffer.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16),
                1234,
                5,
            );
            expect(formNetwork).toHaveBeenCalledWith(0x0807060504030201n, networkOptions.panID, 11);
            expect(fromSpy).not.toHaveBeenCalledWith(networkKey, "hex");
        } finally {
            fromSpy.mockRestore();
        }
    });

    it("checks restore compatibility without cloning configured network bytes", async () => {
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        vi.spyOn(getBackupMan(driver), "getStoredBackup").mockResolvedValue({
            networkOptions: {
                panId: networkOptions.panID,
                extendedPanId: Buffer.from(networkOptions.extendedPanID!),
                networkKey: Buffer.from(networkOptions.networkKey!),
            },
            logicalChannel: 11,
        } as any);
        const originalFrom = Buffer.from;
        const fromSpy = vi.spyOn(Buffer, "from").mockImplementation(((value: unknown, ...args: unknown[]) => {
            if (value === networkOptions.extendedPanID || value === networkOptions.networkKey) {
                throw new Error("configured network bytes clone used");
            }

            return (originalFrom as (...parameters: unknown[]) => Buffer)(value, ...args);
        }) as typeof Buffer.from);

        try {
            const result = await (
                driver as unknown as {needsToBeRestore: (options: NetworkOptions) => Promise<boolean>}
            ).needsToBeRestore(networkOptions);

            expect(result).toBe(true);
            expect(fromSpy).not.toHaveBeenCalledWith(networkOptions.extendedPanID);
            expect(fromSpy).not.toHaveBeenCalledWith(networkOptions.networkKey);
        } finally {
            fromSpy.mockRestore();
        }
    });

    it("does not hex-format restore compatibility bytes unless debug logging evaluates the message", async () => {
        const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
        const extendedPanID = bytesThatThrowWhenHexLogged(
            [1, 2, 3, 4, 5, 6, 7, 8],
            "eager restore extended PAN ID hex",
        );
        const networkKey = bytesThatThrowWhenHexLogged(
            [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
            "eager restore network key hex",
        );
        const driver = new Driver(
            serialPortOptions,
            {
                ...networkOptions,
                extendedPanID,
                networkKey,
            },
            "/tmp/backup.json",
        );
        vi.spyOn(getBackupMan(driver), "getStoredBackup").mockResolvedValue({
            networkOptions: {
                panId: networkOptions.panID,
                extendedPanId: bytesThatThrowWhenHexLogged(
                    [1, 2, 3, 4, 5, 6, 7, 8],
                    "eager backup extended PAN ID hex",
                ),
                networkKey: bytesThatThrowWhenHexLogged(
                    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
                    "eager backup network key hex",
                ),
            },
            logicalChannel: 11,
        } as any);

        try {
            await expect(
                (
                    driver as unknown as {needsToBeRestore: (options: NetworkOptions) => Promise<boolean>}
                ).needsToBeRestore({
                    ...networkOptions,
                    extendedPanID,
                    networkKey,
                }),
            ).resolves.toBe(true);

            expect(debug).toHaveBeenCalledWith(expect.any(Function), expect.any(String));
        } finally {
            debug.mockRestore();
        }
    });

    it("does not stringify trust-center link keys unless debug logging evaluates the message", async () => {
        const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
        const linkKey = Buffer.alloc(16, 0x5a);
        const toStringSpy = vi.spyOn(linkKey, "toString").mockImplementation(() => {
            throw new Error("eager trust-center key string");
        });
        const execCommand = vi.fn()
            .mockResolvedValueOnce({
                status: BlzStatus.SUCCESS,
                linkKey,
                outgoingFrameCounter: 7,
                trustCenterAddress: 0,
            })
            .mockResolvedValueOnce({
                status: BlzStatus.SUCCESS,
            });
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        setDriverBlz(driver, {execCommand});

        try {
            await expect(driverGetGlobalTcLinkKey(driver)).resolves.toEqual(
                expect.objectContaining({linkKey}),
            );
            await expect(driverSetGlobalTcLinkKey(driver, linkKey, 7)).resolves.toBe(BlzStatus.SUCCESS);

            expect(debug).toHaveBeenCalledWith(expect.any(Function), expect.any(String));
        } finally {
            toStringSpy.mockRestore();
            debug.mockRestore();
        }
    });

    it("does not stringify network keys unless debug logging evaluates the message", async () => {
        const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
        const nwkKey = Buffer.alloc(16, 0xa5);
        const toStringSpy = vi.spyOn(nwkKey, "toString").mockImplementation(() => {
            throw new Error("eager network key string");
        });
        const execCommand = vi.fn()
            .mockResolvedValueOnce({
                status: BlzStatus.SUCCESS,
                nwkKey,
                outgoingFrameCounter: 9,
                nwkKeySeqNum: 2,
            })
            .mockResolvedValueOnce({
                status: BlzStatus.SUCCESS,
            });
        const driver = new Driver(serialPortOptions, networkOptions, "/tmp/backup.json");
        setDriverBlz(driver, {execCommand});

        try {
            await expect(driverGetNetworkKeyInfo(driver)).resolves.toEqual(
                expect.objectContaining({nwkKey}),
            );
            await expect(driverSetNetworkKeyInfo(driver, nwkKey, 9, 2)).resolves.toBe(BlzStatus.SUCCESS);

            expect(debug).toHaveBeenCalledWith(expect.any(Function), expect.any(String));
        } finally {
            toStringSpy.mockRestore();
            debug.mockRestore();
        }
    });
});
