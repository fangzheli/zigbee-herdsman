import * as fs from "node:fs";

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { BLZAdapter } from "../../../../src/adapter/blz/adapter/blzAdapter";
import { Driver } from "../../../../src/adapter/blz/driver/driver";
import { BlzOutgoingMessageType, BlzStatus } from "../../../../src/adapter/blz/driver/types/named";
import { BlzApsFrame } from "../../../../src/adapter/blz/driver/types/struct";
import {
  AdapterOptions,
  NetworkOptions,
  SerialPortOptions,
  StartResult,
} from "../../../../src/adapter/tstype";
import { logger } from "../../../../src/utils/logger";
import * as Zcl from "../../../../src/zspec/zcl";
import * as Zdo from "../../../../src/zspec/zdo";
import * as ZSpec from "../../../../src/zspec";

vi.mock("../../../../src/adapter/blz/driver/driver");

describe("BLZ Adapter", () => {
  let adapter: BLZAdapter;
  let driverMock: {
    startup: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    permitJoining: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
    brequest: ReturnType<typeof vi.fn>;
    mrequest: ReturnType<typeof vi.fn>;
    sendZdo: ReturnType<typeof vi.fn>;
    sendZclMulticast: ReturnType<typeof vi.fn>;
    sendZclBroadcast: ReturnType<typeof vi.fn>;
    sendZclEndpoint: ReturnType<typeof vi.fn>;
    changeChannel: ReturnType<typeof vi.fn>;
    makeApsFrame: ReturnType<typeof vi.fn>;
    waitFor: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    getBlz: ReturnType<typeof vi.fn>;
    isInitialized: ReturnType<typeof vi.fn>;
    createBackup: ReturnType<typeof vi.fn>;
    getCoordinatorVersion: ReturnType<typeof vi.fn>;
    getCoordinatorIeee: ReturnType<typeof vi.fn>;
    getNetworkParametersSnapshot: ReturnType<typeof vi.fn>;
    updateNetworkParametersSnapshot: ReturnType<typeof vi.fn>;
    leaveNetwork: ReturnType<typeof vi.fn>;
    formNetworkWithParameters: ReturnType<typeof vi.fn>;
    ieee: { toString: () => string };
    networkParams: {
      panId: number;
      extendedPanId: Buffer;
      Channel: number;
      nwkUpdateId: number;
    };
    blz: {
      isInitialized: ReturnType<typeof vi.fn>;
      leaveNetwork: ReturnType<typeof vi.fn>;
      formNetwork: ReturnType<typeof vi.fn>;
      version: { product: number };
    };
    setNode: ReturnType<typeof vi.fn>;
    getNetworkKeyInfo: ReturnType<typeof vi.fn>;
    getGlobalTcLinkKey: ReturnType<typeof vi.fn>;
    setNetworkKeyInfo: ReturnType<typeof vi.fn>;
    setGlobalTcLinkKey: ReturnType<typeof vi.fn>;
    handleNodeLeft: ReturnType<typeof vi.fn>;
  };

  const networkOptions: NetworkOptions = {
    networkKey: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    panID: 0x1234,
    extendedPanID: [1, 2, 3, 4, 5, 6, 7, 8],
    channelList: [11],
  };

  const serialPortOptions: SerialPortOptions = {
    path: "COM5",
    baudRate: 2000000,
    rtscts: false,
  };

  const adapterOptions: AdapterOptions = {
    concurrent: 1,
    disableLED: false,
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    driverMock = {
      startup: vi.fn(),
      stop: vi.fn(),
      permitJoining: vi.fn(),
      request: vi.fn(),
      brequest: vi.fn(),
      mrequest: vi.fn(),
      sendZdo: vi.fn(),
      sendZclMulticast: vi.fn(),
      sendZclBroadcast: vi.fn(),
      sendZclEndpoint: vi.fn(),
      changeChannel: vi.fn(),
      makeApsFrame: vi.fn(),
      waitFor: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      getBlz: vi.fn(),
      isInitialized: vi.fn(),
      createBackup: vi.fn(),
      getCoordinatorVersion: vi.fn(),
      getCoordinatorIeee: vi.fn(),
      getNetworkParametersSnapshot: vi.fn(),
      updateNetworkParametersSnapshot: vi.fn(),
      leaveNetwork: vi.fn(),
      formNetworkWithParameters: vi.fn(),
      ieee: { toString: () => "0102030405060708" },
      networkParams: {
        panId: 0x1234,
        extendedPanId: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
        Channel: 11,
        nwkUpdateId: 0,
      },
      blz: {
        isInitialized: vi.fn(),
        leaveNetwork: vi.fn(),
        formNetwork: vi.fn(),
        version: { product: 1 },
      },
      setNode: vi.fn(),
      getNetworkKeyInfo: vi.fn(),
      getGlobalTcLinkKey: vi.fn(),
      setNetworkKeyInfo: vi.fn(),
      setGlobalTcLinkKey: vi.fn(),
      handleNodeLeft: vi.fn(),
    };
    driverMock.getBlz.mockReturnValue(driverMock.blz);
    driverMock.isInitialized.mockImplementation(() => driverMock.blz.isInitialized());
    driverMock.getCoordinatorVersion.mockImplementation(() => ({
      type: `BLZ v${driverMock.blz.version.product}`,
      meta: driverMock.blz.version,
    }));
    driverMock.getCoordinatorIeee.mockImplementation(() => driverMock.ieee);
    driverMock.getNetworkParametersSnapshot.mockImplementation(() => driverMock.networkParams);
    driverMock.updateNetworkParametersSnapshot.mockImplementation((channel: number, nwkUpdateId: number) => {
      driverMock.networkParams.Channel = channel;
      driverMock.networkParams.nwkUpdateId = nwkUpdateId;
    });
    driverMock.leaveNetwork.mockImplementation(() => driverMock.blz.leaveNetwork());
    driverMock.formNetworkWithParameters.mockImplementation(
      (extendedPanId: bigint, panId: number, channel: number) =>
        driverMock.blz.formNetwork(extendedPanId, panId, channel),
    );

    vi.mocked(Driver).mockImplementation(() => driverMock as any);
    adapter = new BLZAdapter(
      networkOptions,
      serialPortOptions,
      "/path/to/backup",
      adapterOptions,
    );
  });

  describe("Startup and initialization", () => {
    it("keeps driver close handling behind adapter-owned listeners", () => {
      const source = fs.readFileSync("src/adapter/blz/adapter/blzAdapter.ts", "utf8");

      expect(source).toContain("private onDriverClose(): void");
      expect(source).not.toContain("public onDriverClose(): void");
      expect(source).toContain("private handleDeviceJoin(nwk: number, ieee: BlzEUI64): void");
      expect(source).not.toContain("private async handleDeviceJoin");
      expect(source).not.toContain('return await Promise.reject(new Error("Not supported"));');
    });

    it("keeps adapter ZCL response waiter ownership behind a helper", () => {
      const adapterSource = fs.readFileSync("src/adapter/blz/adapter/blzAdapter.ts", "utf8");
      const waiterSource = fs.readFileSync("src/adapter/blz/adapter/zclResponseWaiters.ts", "utf8");

      expect(adapterSource).toContain("private readonly zclResponseWaiters = new ZclResponseWaiters();");
      expect(adapterSource).not.toContain("private waitress:");
      expect(adapterSource).not.toContain("new Waitress<ZclWaitressPayload, ClusterWaitressMatcher>");
      expect(adapterSource).toContain("this.zclResponseWaiters.resolve(");
      expect(adapterSource).toContain("this.zclResponseWaiters.waitFor(");
      expect(adapterSource.match(/this\.zclResponseWaiters\.cancel\(response\);/g)).toHaveLength(2);
      expect(adapterSource).toContain("this.zclResponseWaiters.clear(error);");
      expect(waiterSource).toContain("export class ZclResponseWaiters");
      expect(waiterSource).toContain("private readonly waitress = new Waitress");
      expect(waiterSource).toContain("public cancel(waiter: ZclResponseWaiter | null): void");
    });

    it("centralizes adapter stop and close pending-operation cleanup", () => {
      const source = fs.readFileSync("src/adapter/blz/adapter/blzAdapter.ts", "utf8");

      expect(source).toContain("private enterStoppedState(error: Error): void");
      expect(source.match(/this\.queue\.clear\(/g)).toHaveLength(1);
      expect(source).toContain("private clearZclResponseWaiters(error: Error): void");
      expect(source.match(/this\.clearZclResponseWaiters\(/g)).toHaveLength(1);
      expect(source.match(/this\.zclResponseWaiters\.clear\(error\);/g)).toHaveLength(1);
      expect(source).toContain("private cancelStopDelay(): void");
      expect(source).toContain("this.cancelStopDelay();");
      expect(source.match(/this\.stopDelay\.cancel\(/g)).toHaveLength(1);
      expect(source.match(/this\.cancelRunningOperations\(/g)).toHaveLength(1);
      expect(source).toContain("private isRunningGeneration(generation: number): boolean");
      expect(source.match(/this\.isRunningGeneration\(generation\)/g)).toHaveLength(3);
      expect(source.match(/!this\.closing && generation === this\.stopGeneration/g)).toHaveLength(1);
      expect(source).toContain("private getRunningCancellationError(): Error");
      expect(source.match(/this\.getRunningCancellationError\(\)/g)).toHaveLength(3);
      expect(source.match(/new Error\("Adapter stopped"\)/g)).toHaveLength(1);
      expect(source).not.toContain("} catch (error) {\n      throw error;\n    } finally {");
    });

    it("keeps ZDO response waiter ownership inside the driver API", () => {
      const source = fs.readFileSync("src/adapter/blz/adapter/blzAdapter.ts", "utf8");

      expect(source).not.toContain("this.driver.waitFor(");
      expect(source).not.toContain("type ZdoSendWaiter");
      expect(source).not.toContain("private async sendZdoFrame(");
      expect(source).toContain("this.driver.sendZdo(");
    });

    it("centralizes queued adapter command guards", () => {
      const source = fs.readFileSync("src/adapter/blz/adapter/blzAdapter.ts", "utf8");

      expect(source).toContain("private async runQueuedWhileRunning<T>(");
      expect(source.match(/this\.queue\.execute/g)).toHaveLength(1);
      expect(source.match(/this\.checkInterpanLock\(\);/g)).toHaveLength(1);
    });

    it("keeps group and broadcast ZCL APS sends inside the driver API", () => {
      const source = fs.readFileSync("src/adapter/blz/adapter/blzAdapter.ts", "utf8");

      expect(source).not.toContain("this.driver.mrequest(");
      expect(source).not.toContain("this.driver.brequest(");
      expect(source).toContain("this.driver.sendZclMulticast(");
      expect(source).toContain("this.driver.sendZclBroadcast(");
    });

    it("keeps endpoint ZCL APS frame ownership inside the driver API", () => {
      const source = fs.readFileSync("src/adapter/blz/adapter/blzAdapter.ts", "utf8");

      expect(source).not.toContain("this.driver.request(");
      expect(source).not.toContain("this.driver.makeApsFrame(");
      expect(source).not.toContain("private makeZclApsFrame(");
      expect(source).toContain("this.driver.sendZclEndpoint(");
    });

    it("keeps channel-change reform ownership inside the driver API", () => {
      const source = fs.readFileSync("src/adapter/blz/adapter/blzAdapter.ts", "utf8");

      expect(source).not.toContain("this.driver.getNetworkKeyInfo(");
      expect(source).not.toContain("this.driver.getGlobalTcLinkKey(");
      expect(source).not.toContain("this.driver.leaveNetwork(");
      expect(source).not.toContain("this.driver.setNetworkKeyInfo(");
      expect(source).not.toContain("this.driver.setGlobalTcLinkKey(");
      expect(source).not.toContain("this.driver.formNetworkWithParameters(");
      expect(source).not.toContain("this.driver.updateNetworkParametersSnapshot(");
      expect(source).toContain("this.driver.changeChannel(");
    });

    it("should stop successfully", async () => {
      driverMock.stop.mockResolvedValue(undefined);
      await adapter.stop();
      expect(driverMock.stop).toHaveBeenCalled();
    });

    it("should stop the driver silently during expected adapter stop", async () => {
      const disconnected = vi.fn();
      adapter.on("disconnected", disconnected);
      driverMock.stop.mockImplementation(async (emitClose = true) => {
        if (emitClose) {
          driverMock.on.mock.calls.find((call) => call[0] === "close")?.[1]();
        }
      });

      await adapter.stop();

      expect(driverMock.stop).toHaveBeenCalledWith(false);
      expect(disconnected).not.toHaveBeenCalled();
    });

    it("should detach owned driver listeners after a successful stop", async () => {
      driverMock.stop.mockResolvedValue(undefined);

      await adapter.stop();

      expect(driverMock.off).toHaveBeenCalledWith("close", expect.any(Function));
      expect(driverMock.off).toHaveBeenCalledWith("deviceJoined", expect.any(Function));
      expect(driverMock.off).toHaveBeenCalledWith("deviceLeft", expect.any(Function));
      expect(driverMock.off).toHaveBeenCalledWith("incomingMessage", expect.any(Function));
    });

    it("should detach owned driver listeners after a failed stop", async () => {
      driverMock.stop.mockRejectedValue(new Error("stop failed"));

      await expect(adapter.stop()).rejects.toThrow("stop failed");

      expect(driverMock.off).toHaveBeenCalledWith("close", expect.any(Function));
      expect(driverMock.off).toHaveBeenCalledWith("deviceJoined", expect.any(Function));
      expect(driverMock.off).toHaveBeenCalledWith("deviceLeft", expect.any(Function));
      expect(driverMock.off).toHaveBeenCalledWith("incomingMessage", expect.any(Function));
    });

    it("should detach owned driver listeners when startup fails", async () => {
      driverMock.startup.mockRejectedValue(new Error("startup failed"));

      await expect(adapter.start()).rejects.toThrow("startup failed");

      expect(driverMock.off).toHaveBeenCalledWith("close", expect.any(Function));
      expect(driverMock.off).toHaveBeenCalledWith("deviceJoined", expect.any(Function));
      expect(driverMock.off).toHaveBeenCalledWith("deviceLeft", expect.any(Function));
      expect(driverMock.off).toHaveBeenCalledWith("incomingMessage", expect.any(Function));
    });

    it("should detach partially attached driver listeners when start listener attach fails", async () => {
      driverMock.stop.mockResolvedValue(undefined);
      await adapter.stop();
      driverMock.on.mockClear();
      driverMock.off.mockClear();
      driverMock.on.mockImplementation((event: string) => {
        if (event === "incomingMessage") {
          throw new Error("incoming listener failed");
        }
      });

      await expect(adapter.start()).rejects.toThrow("incoming listener failed");

      expect(driverMock.off).toHaveBeenCalledWith("close", expect.any(Function));
      expect(driverMock.off).toHaveBeenCalledWith("deviceJoined", expect.any(Function));
      expect(driverMock.off).toHaveBeenCalledWith("deviceLeft", expect.any(Function));
      expect(driverMock.off.mock.calls.filter((call) => call[0] === "incomingMessage")).toHaveLength(0);
      expect(driverMock.startup).not.toHaveBeenCalled();
    });

    it("should reject adapter waiters with the startup failure when startup fails", async () => {
      const waiter = adapter.waitFor(
        0x1234,
        1,
        Zcl.FrameType.GLOBAL,
        Zcl.Direction.SERVER_TO_CLIENT,
        7,
        Zcl.Clusters.genOnOff.ID,
        Zcl.Foundation.defaultRsp.ID,
        1000,
      );
      const waiterResult = waiter.promise.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      driverMock.startup.mockRejectedValue(new Error("startup failed"));

      await expect(adapter.start()).rejects.toThrow("startup failed");
      const observed = await Promise.race([
        waiterResult,
        Promise.resolve("pending"),
      ]);

      expect(observed).toBe("rejected:startup failed");
    });

    it("should cancel the startup settle delay when stopping", async () => {
      driverMock.startup.mockResolvedValue("resumed");
      driverMock.stop.mockResolvedValue(undefined);

      const start = adapter.start();
      const startResult = start.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      await vi.advanceTimersByTimeAsync(0);

      await adapter.stop();
      await vi.advanceTimersByTimeAsync(0);
      const observed = await Promise.race([
        startResult,
        Promise.resolve("pending"),
      ]);
      await vi.advanceTimersByTimeAsync(1000);
      await start.catch(() => {});

      expect(observed).toBe("rejected:Adapter stopped");
    });

    it("should cancel the startup settle delay as disconnected when the driver closes", async () => {
      driverMock.startup.mockResolvedValue("resumed");
      const disconnected = vi.fn();
      adapter.on("disconnected", disconnected);

      const start = adapter.start();
      const startResult = start.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      await vi.advanceTimersByTimeAsync(0);

      driverMock.on.mock.calls.find((call) => call[0] === "close")?.[1]();
      await vi.advanceTimersByTimeAsync(0);
      const observed = await Promise.race([
        startResult,
        Promise.resolve("pending"),
      ]);

      void start.catch(() => {});

      expect(observed).toBe("rejected:Adapter disconnected");
      expect(disconnected).toHaveBeenCalledTimes(1);
    });

    it("should cancel adapter start while driver startup is pending", async () => {
      driverMock.startup.mockReturnValue(new Promise<StartResult>(() => {}));
      driverMock.stop.mockResolvedValue(undefined);

      const start = adapter.start();
      const startResult = start.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      await vi.advanceTimersByTimeAsync(0);

      await adapter.stop();
      await vi.advanceTimersByTimeAsync(0);
      const observed = await Promise.race([
        startResult,
        Promise.resolve("pending"),
      ]);

      void start.catch(() => {});

      expect(observed).toBe("rejected:Adapter stopped");
      expect(driverMock.stop).toHaveBeenCalled();
    });

    it("should coalesce concurrent adapter starts and cancel them together", async () => {
      driverMock.startup.mockReturnValue(new Promise<StartResult>(() => {}));
      driverMock.stop.mockResolvedValue(undefined);

      const firstStart = adapter.start();
      const firstResult = firstStart.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      await vi.advanceTimersByTimeAsync(0);

      const secondStart = adapter.start();
      const secondResult = secondStart.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(driverMock.startup).toHaveBeenCalledTimes(1);

      await adapter.stop();
      await vi.advanceTimersByTimeAsync(0);
      const observedPromise = Promise.race([
        Promise.all([firstResult, secondResult]),
        new Promise((resolve) => setTimeout(() => resolve("pending"), 1)),
      ]);
      await vi.advanceTimersByTimeAsync(1);
      const observed = await observedPromise;

      void firstStart.catch(() => {});
      void secondStart.catch(() => {});

      expect(observed).toEqual([
        "rejected:Adapter stopped",
        "rejected:Adapter stopped",
      ]);
      expect(driverMock.stop).toHaveBeenCalled();
    });

    it("should wait for an in-flight stop before starting again", async () => {
      let resolveStop: (() => void) | undefined;
      driverMock.stop.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveStop = resolve;
        }),
      );
      driverMock.startup.mockResolvedValue("resumed");

      const stop = adapter.stop();
      await vi.advanceTimersByTimeAsync(0);

      const start = adapter.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(driverMock.startup).not.toHaveBeenCalled();

      resolveStop?.();
      await stop;
      await vi.advanceTimersByTimeAsync(1000);

      await expect(start).resolves.toBe("resumed");
      expect(driverMock.startup).toHaveBeenCalledTimes(1);
    });

    it("should reject queued adapter jobs when stopping", async () => {
      vi.useRealTimers();
      driverMock.stop.mockResolvedValue(undefined);
      let releaseRequest: (() => void) | undefined;
      const firstRequest = new Promise<boolean>((resolve) => {
        releaseRequest = () => resolve(true);
      });
      driverMock.sendZclEndpoint.mockReturnValueOnce(firstRequest).mockResolvedValue(true);
      const zclFrame = Zcl.Frame.create(
        Zcl.FrameType.GLOBAL,
        Zcl.Direction.CLIENT_TO_SERVER,
        true,
        undefined,
        7,
        "read",
        Zcl.Clusters.genOnOff.ID,
        [{attrId: 0x0000}],
        {},
      );

      const firstSend = adapter.sendZclFrameToEndpoint(
        "0x0102030405060708",
        0x1234,
        1,
        zclFrame,
        1000,
        true,
        true,
      );
      const secondSend = adapter.sendZclFrameToEndpoint(
        "0x0102030405060709",
        0x1235,
        1,
        zclFrame,
        1000,
        true,
        true,
      );
      const secondResult = secondSend.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );

      expect(driverMock.sendZclEndpoint).toHaveBeenCalledTimes(1);
      await adapter.stop();
      const observed = await Promise.race([
        secondResult,
        new Promise((resolve) => setImmediate(() => resolve("pending"))),
      ]);

      releaseRequest?.();
      await expect(firstSend).rejects.toThrow("Adapter stopped");
      await secondSend.catch(() => {});

      expect(observed).toBe("rejected:Adapter stopped");
    });

    it("should emit disconnected after restart when the driver closes", async () => {
      driverMock.stop.mockResolvedValue(undefined);
      driverMock.startup.mockResolvedValue("resumed");

      await adapter.stop();

      const start = adapter.start();
      await vi.advanceTimersByTimeAsync(1000);
      await start;

      const callback = vi.fn();
      adapter.on("disconnected", callback);

      driverMock.on.mock.calls.find((call) => call[0] === "close")?.[1]();

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("should emit disconnected after a failed stop when the driver closes", async () => {
      driverMock.stop.mockRejectedValue(new Error("stop failed"));

      await expect(adapter.stop()).rejects.toThrow("stop failed");

      const callback = vi.fn();
      adapter.on("disconnected", callback);

      driverMock.on.mock.calls.find((call) => call[0] === "close")?.[1]();

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("should keep rejecting new adapter requests after a failed stop", async () => {
      driverMock.stop.mockRejectedValue(new Error("stop failed"));
      driverMock.sendZclMulticast.mockResolvedValue(true);
      const zclFrame = Zcl.Frame.create(
        Zcl.FrameType.GLOBAL,
        Zcl.Direction.CLIENT_TO_SERVER,
        true,
        undefined,
        7,
        "read",
        Zcl.Clusters.genOnOff.ID,
        [{attrId: 0x0000}],
        {},
      );

      await expect(adapter.stop()).rejects.toThrow("stop failed");

      const send = adapter.sendZclFrameToGroup(1, zclFrame);
      const result = send.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      const observed = await Promise.race([
        result,
        new Promise((resolve) => setImmediate(() => resolve("pending"))),
      ]);

      void send.catch(() => {});

      expect(observed).toBe("rejected:Adapter stopped");
      expect(driverMock.sendZclMulticast).not.toHaveBeenCalled();
    });

    it("should clear adapter state when the driver closes unexpectedly", async () => {
      const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
      const waiter = adapter.waitFor(
        0x1234,
        1,
        Zcl.FrameType.GLOBAL,
        Zcl.Direction.SERVER_TO_CLIENT,
        7,
        Zcl.Clusters.genOnOff.ID,
        Zcl.Foundation.defaultRsp.ID,
        1000,
      );
      const waiterResult = waiter.promise.catch((error: Error) => error);
      const callback = vi.fn();
      adapter.on("disconnected", callback);

      driverMock.on.mock.calls.find((call) => call[0] === "close")?.[1]();
      await vi.advanceTimersByTimeAsync(0);
      const observed = await Promise.race([
        waiterResult,
        Promise.resolve("pending"),
      ]);

      expect(clearTimeoutSpy).toHaveBeenCalled();
      expect(observed).toEqual(new Error("Adapter disconnected"));
      expect(driverMock.off).toHaveBeenCalledWith("close", expect.any(Function));
      expect(driverMock.off).toHaveBeenCalledWith("deviceJoined", expect.any(Function));
      expect(driverMock.off).toHaveBeenCalledWith("deviceLeft", expect.any(Function));
      expect(driverMock.off).toHaveBeenCalledWith("incomingMessage", expect.any(Function));
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("should get coordinator version through the driver API", async () => {
      const versionMeta = { product: 7 };
      driverMock.getBlz.mockImplementation(() => {
        throw new Error("transport leaked");
      });
      driverMock.getCoordinatorVersion.mockReturnValue({
        type: "BLZ v7",
        meta: versionMeta,
      });

      const version = await adapter.getCoordinatorVersion();

      expect(version).toEqual({
        type: "BLZ v7",
        meta: versionMeta,
      });
      expect(driverMock.getCoordinatorVersion).toHaveBeenCalledTimes(1);
    });

    it("should get coordinator IEEE", async () => {
      const ieee = await adapter.getCoordinatorIEEE();
      expect(ieee).toBe("0x0102030405060708");
    });

    it("should normalize uppercase coordinator IEEE prefixes", async () => {
      driverMock.ieee = { toString: () => "0X0102030405060708" };

      const ieee = await adapter.getCoordinatorIEEE();

      expect(ieee).toBe("0x0102030405060708");
    });
  });

  describe("Network operations", () => {
    it("should permit joining on coordinator", async () => {
      driverMock.blz.isInitialized.mockReturnValue(true);
      driverMock.permitJoining.mockResolvedValue(undefined);
      driverMock.brequest.mockResolvedValue(true);
      driverMock.makeApsFrame.mockImplementation(() => {
        const frame = new BlzApsFrame();
        frame.profileId = Zdo.ZDO_PROFILE_ID;
        frame.clusterId = Zdo.ClusterId.PERMIT_JOINING_REQUEST;
        frame.sourceEndpoint = 0;
        frame.destinationEndpoint = 0;
        frame.sequence = 1;
        frame.options = 0;
        frame.groupId = 0;
        return frame;
      });

      await adapter.permitJoin(60);
      expect(driverMock.permitJoining).toHaveBeenCalledWith(60);
    }, 60000);

    it("should leave coordinator permit join status handling to the driver", async () => {
      driverMock.blz.isInitialized.mockReturnValue(true);
      driverMock.permitJoining.mockResolvedValue(undefined);

      await expect(adapter.permitJoin(60)).resolves.toBeUndefined();
      expect(driverMock.permitJoining).toHaveBeenCalledWith(60);
      expect(driverMock.sendZdo).toHaveBeenCalledTimes(1);
    });

    it("should check permit join initialization through the driver API", async () => {
      (driverMock as unknown as {blz?: unknown}).blz = undefined;
      driverMock.isInitialized.mockReturnValue(true);
      driverMock.permitJoining.mockResolvedValue(undefined);

      await adapter.permitJoin(60, 0x0000);

      expect(driverMock.permitJoining).toHaveBeenCalledWith(60);
    });

    it("should cancel coordinator permit join when stopping", async () => {
      driverMock.blz.isInitialized.mockReturnValue(true);
      driverMock.permitJoining.mockReturnValue(new Promise(() => {}));
      driverMock.stop.mockResolvedValue(undefined);

      const permitJoin = adapter.permitJoin(60);
      const permitJoinResult = permitJoin.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      await vi.advanceTimersByTimeAsync(0);

      await adapter.stop();
      await vi.advanceTimersByTimeAsync(0);
      const observed = await Promise.race([
        permitJoinResult,
        Promise.resolve("pending"),
      ]);

      void permitJoin.catch(() => {});

      expect(observed).toBe("rejected:Adapter stopped");
      expect(driverMock.permitJoining).toHaveBeenCalledWith(60);
      expect(driverMock.brequest).not.toHaveBeenCalled();
    });

    it("should get network parameters", async () => {
      const params = await adapter.getNetworkParameters();
      expect(params).toEqual({
        panID: 0x1234,
        extendedPanID: "0x0102030405060708",
        channel: 11,
        nwkUpdateID: 0,
      });
    });

    it("should send ZCL frame to all through the broadcast driver API", async () => {
      driverMock.sendZclBroadcast.mockResolvedValue(true);
      const zclFrame = Zcl.Frame.create(
        Zcl.FrameType.GLOBAL,
        Zcl.Direction.CLIENT_TO_SERVER,
        true,
        undefined,
        7,
        "read",
        Zcl.Clusters.genOnOff.ID,
        [{attrId: 0x0000}],
        {},
      );

      const send = adapter.sendZclFrameToAll(
        3,
        zclFrame,
        1,
        ZSpec.BroadcastAddress.DEFAULT,
      );

      await vi.advanceTimersByTimeAsync(200);
      await send;

      expect(driverMock.sendZclBroadcast).toHaveBeenCalledWith(
        ZSpec.BroadcastAddress.DEFAULT,
        Zcl.Clusters.genOnOff.ID,
        ZSpec.HA_PROFILE_ID,
        1,
        3,
        zclFrame.toBuffer(),
      );
      expect(driverMock.sendZclMulticast).not.toHaveBeenCalled();
    });

    it("should reject when group ZCL send fails", async () => {
      driverMock.sendZclMulticast.mockResolvedValue(false);
      const zclFrame = Zcl.Frame.create(
        Zcl.FrameType.GLOBAL,
        Zcl.Direction.CLIENT_TO_SERVER,
        true,
        undefined,
        7,
        "read",
        Zcl.Clusters.genOnOff.ID,
        [{attrId: 0x0000}],
        {},
      );

      const send = adapter.sendZclFrameToGroup(0x1234, zclFrame);
      const rejection = expect(send).rejects.toThrow("Failed to send group request");

      await vi.advanceTimersByTimeAsync(200);
      await rejection;
    });

    it("should cancel group send settle delay when stopping", async () => {
      driverMock.sendZclMulticast.mockResolvedValue(true);
      driverMock.stop.mockResolvedValue(undefined);
      const zclFrame = Zcl.Frame.create(
        Zcl.FrameType.GLOBAL,
        Zcl.Direction.CLIENT_TO_SERVER,
        true,
        undefined,
        7,
        "read",
        Zcl.Clusters.genOnOff.ID,
        [{attrId: 0x0000}],
        {},
      );

      const send = adapter.sendZclFrameToGroup(0x1234, zclFrame);
      const sendResult = send.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      await vi.advanceTimersByTimeAsync(0);

      await adapter.stop();
      await vi.advanceTimersByTimeAsync(0);
      const observed = await Promise.race([
        sendResult,
        Promise.resolve("pending"),
      ]);
      await vi.advanceTimersByTimeAsync(200);
      await send.catch(() => {});

      expect(observed).toBe("rejected:Adapter stopped");
    });

    it("should register active group lower sends as cancellable adapter operations", async () => {
      driverMock.sendZclMulticast.mockReturnValue(new Promise<boolean>(() => {}));
      driverMock.stop.mockResolvedValue(undefined);
      const zclFrame = Zcl.Frame.create(
        Zcl.FrameType.GLOBAL,
        Zcl.Direction.CLIENT_TO_SERVER,
        true,
        undefined,
        7,
        "read",
        Zcl.Clusters.genOnOff.ID,
        [{attrId: 0x0000}],
        {},
      );

      const send = adapter.sendZclFrameToGroup(0x1234, zclFrame);
      const sendResult = send.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      await vi.advanceTimersByTimeAsync(0);

      const runningOperations = (
        adapter as unknown as {runningOperations: {count: () => number}}
      ).runningOperations;
      expect(runningOperations.count()).toBe(1);

      await adapter.stop();
      await vi.advanceTimersByTimeAsync(0);

      await expect(sendResult).resolves.toBe("rejected:Adapter stopped");
      expect(runningOperations.count()).toBe(0);
      void send.catch(() => {});
    });

    it("should reject when broadcast ZCL send fails", async () => {
      driverMock.sendZclBroadcast.mockResolvedValue(false);
      const zclFrame = Zcl.Frame.create(
        Zcl.FrameType.GLOBAL,
        Zcl.Direction.CLIENT_TO_SERVER,
        true,
        undefined,
        7,
        "read",
        Zcl.Clusters.genOnOff.ID,
        [{attrId: 0x0000}],
        {},
      );

      const send = adapter.sendZclFrameToAll(
        3,
        zclFrame,
        1,
        ZSpec.BroadcastAddress.DEFAULT,
      );
      const rejection = expect(send).rejects.toThrow("Failed to send broadcast request");

      await vi.advanceTimersByTimeAsync(200);
      await rejection;
    });

    it("should register active broadcast lower sends as cancellable adapter operations", async () => {
      driverMock.sendZclBroadcast.mockReturnValue(new Promise<boolean>(() => {}));
      driverMock.stop.mockResolvedValue(undefined);
      const zclFrame = Zcl.Frame.create(
        Zcl.FrameType.GLOBAL,
        Zcl.Direction.CLIENT_TO_SERVER,
        true,
        undefined,
        7,
        "read",
        Zcl.Clusters.genOnOff.ID,
        [{attrId: 0x0000}],
        {},
      );

      const send = adapter.sendZclFrameToAll(
        3,
        zclFrame,
        1,
        ZSpec.BroadcastAddress.DEFAULT,
      );
      const sendResult = send.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      await vi.advanceTimersByTimeAsync(0);

      const runningOperations = (
        adapter as unknown as {runningOperations: {count: () => number}}
      ).runningOperations;
      expect(runningOperations.count()).toBe(1);

      await adapter.stop();
      await vi.advanceTimersByTimeAsync(0);

      await expect(sendResult).resolves.toBe("rejected:Adapter stopped");
      expect(runningOperations.count()).toBe(0);
      void send.catch(() => {});
    });

    it("should use explicit profile ID for endpoint ZCL sends", async () => {
      driverMock.sendZclEndpoint.mockResolvedValue(true);
      const zclFrame = Zcl.Frame.create(
        Zcl.FrameType.GLOBAL,
        Zcl.Direction.CLIENT_TO_SERVER,
        true,
        undefined,
        7,
        "read",
        Zcl.Clusters.genOnOff.ID,
        [{attrId: 0x0000}],
        {},
      );

      await (
        adapter.sendZclFrameToEndpoint as unknown as (
          ieeeAddr: string,
          networkAddress: number,
          endpoint: number,
          zclFrame: Zcl.Frame,
          timeout: number,
          disableResponse: boolean,
          disableRecovery: boolean,
          sourceEndpoint?: number,
          profileId?: number,
        ) => Promise<unknown>
      )("0x0102030405060708", 0x1234, 3, zclFrame, 1000, true, true, 2, 0x0105);

      expect(driverMock.sendZclEndpoint).toHaveBeenCalledWith(
        "0x0102030405060708",
        0x1234,
        Zcl.Clusters.genOnOff.ID,
        0x0105,
        2,
        3,
        zclFrame.toBuffer(),
      );
    });

    it("should preserve explicit source endpoint zero for endpoint ZCL sends", async () => {
      driverMock.sendZclEndpoint.mockResolvedValue(true);
      const zclFrame = Zcl.Frame.create(
        Zcl.FrameType.GLOBAL,
        Zcl.Direction.CLIENT_TO_SERVER,
        true,
        undefined,
        7,
        "read",
        Zcl.Clusters.genOnOff.ID,
        [{attrId: 0x0000}],
        {},
      );

      await (
        adapter.sendZclFrameToEndpoint as unknown as (
          ieeeAddr: string,
          networkAddress: number,
          endpoint: number,
          zclFrame: Zcl.Frame,
          timeout: number,
          disableResponse: boolean,
          disableRecovery: boolean,
          sourceEndpoint?: number,
          profileId?: number,
        ) => Promise<unknown>
      )("0x0102030405060708", 0x1234, 3, zclFrame, 1000, true, true, 0);

      expect(driverMock.sendZclEndpoint).toHaveBeenCalledWith(
        "0x0102030405060708",
        0x1234,
        Zcl.Clusters.genOnOff.ID,
        ZSpec.HA_PROFILE_ID,
        0,
        3,
        zclFrame.toBuffer(),
      );
    });

    it("should normalize uppercase coordinator IEEE prefixes for endpoint ZCL fallbacks", async () => {
      driverMock.ieee = { toString: () => "0X0102030405060708" };
      driverMock.sendZclEndpoint.mockResolvedValue(true);
      const zclFrame = Zcl.Frame.create(
        Zcl.FrameType.GLOBAL,
        Zcl.Direction.CLIENT_TO_SERVER,
        true,
        undefined,
        7,
        "read",
        Zcl.Clusters.genOnOff.ID,
        [{attrId: 0x0000}],
        {},
      );

      await (
        adapter.sendZclFrameToEndpoint as unknown as (
          ieeeAddr: string | undefined,
          networkAddress: number,
          endpoint: number,
          zclFrame: Zcl.Frame,
          timeout: number,
          disableResponse: boolean,
          disableRecovery: boolean,
        ) => Promise<unknown>
      )(undefined, 0x1234, 3, zclFrame, 1000, true, true);

      expect(driverMock.sendZclEndpoint).toHaveBeenCalledWith(
        "0x0102030405060708",
        0x1234,
        Zcl.Clusters.genOnOff.ID,
        ZSpec.HA_PROFILE_ID,
        1,
        3,
        zclFrame.toBuffer(),
      );
    });

    it("should not retry endpoint ZCL response waits after stop clears waiters", async () => {
      driverMock.sendZclEndpoint.mockResolvedValue(true);
      driverMock.stop.mockResolvedValue(undefined);
      const zclFrame = Zcl.Frame.create(
        Zcl.FrameType.GLOBAL,
        Zcl.Direction.CLIENT_TO_SERVER,
        false,
        undefined,
        7,
        "read",
        Zcl.Clusters.genOnOff.ID,
        [{attrId: 0x0000}],
        {},
      );

      const send = adapter.sendZclFrameToEndpoint(
        "0x0102030405060708",
        0x1234,
        1,
        zclFrame,
        1000,
        false,
        false,
      );
      const sendResult = send.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      await vi.advanceTimersByTimeAsync(0);

      await adapter.stop();
      await vi.advanceTimersByTimeAsync(0);
      const observed = await Promise.race([
        sendResult,
        Promise.resolve("pending"),
      ]);
      await vi.advanceTimersByTimeAsync(1000);
      await send.catch(() => {});

      expect(observed).toBe("rejected:Adapter stopped");
      expect(driverMock.sendZclEndpoint).toHaveBeenCalledTimes(1);
    });

    it("should cancel endpoint ZCL response waiters when the driver endpoint send throws", async () => {
      driverMock.sendZclEndpoint.mockRejectedValue(new Error("driver endpoint send failed"));
      const zclFrame = Zcl.Frame.create(
        Zcl.FrameType.GLOBAL,
        Zcl.Direction.CLIENT_TO_SERVER,
        false,
        undefined,
        7,
        "read",
        Zcl.Clusters.genOnOff.ID,
        [{attrId: 0x0000}],
        {},
      );

      await expect(
        adapter.sendZclFrameToEndpoint(
          "0x0102030405060708",
          0x1234,
          1,
          zclFrame,
          1000,
          false,
          true,
        ),
      ).rejects.toThrow("driver endpoint send failed");

      expect(
        (
          adapter as unknown as {zclResponseWaiters: {count: () => number}}
        ).zclResponseWaiters.count(),
      ).toBe(0);
    });

    it("should register active endpoint lower sends as cancellable adapter operations", async () => {
      driverMock.sendZclEndpoint.mockReturnValue(new Promise<boolean>(() => {}));
      driverMock.stop.mockResolvedValue(undefined);
      const zclFrame = Zcl.Frame.create(
        Zcl.FrameType.GLOBAL,
        Zcl.Direction.CLIENT_TO_SERVER,
        true,
        undefined,
        7,
        "read",
        Zcl.Clusters.genOnOff.ID,
        [{attrId: 0x0000}],
        {},
      );

      const send = adapter.sendZclFrameToEndpoint(
        "0x0102030405060708",
        0x1234,
        1,
        zclFrame,
        1000,
        true,
        true,
      );
      const sendResult = send.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      await vi.advanceTimersByTimeAsync(0);

      const runningOperations = (
        adapter as unknown as {runningOperations: {count: () => number}}
      ).runningOperations;
      expect(runningOperations.count()).toBe(1);

      await adapter.stop();
      await vi.advanceTimersByTimeAsync(0);

      await expect(sendResult).resolves.toBe("rejected:Adapter stopped");
      expect(runningOperations.count()).toBe(0);
      void send.catch(() => {});
    });

    it("should log endpoint ZCL retry state without stale data-request attempts", async () => {
      const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
      try {
        driverMock.sendZclEndpoint.mockResolvedValue(true);
        const zclFrame = Zcl.Frame.create(
          Zcl.FrameType.GLOBAL,
          Zcl.Direction.CLIENT_TO_SERVER,
          true,
          undefined,
          7,
          "read",
          Zcl.Clusters.genOnOff.ID,
          [{attrId: 0x0000}],
          {},
        );

        await adapter.sendZclFrameToEndpoint(
          "0x0102030405060708",
          0x1234,
          1,
          zclFrame,
          1000,
          true,
          true,
        );

        const endpointLog = debug.mock.calls
          .map(([message]) =>
            typeof message === "function" ? message() : message,
          )
          .find((message) =>
            String(message).startsWith("sendZclFrameToEndpointInternal"),
          );

        expect(endpointLog).toContain("responseAttempt=0");
        expect(endpointLog).toContain("queue=");
        expect(endpointLog).not.toContain("dataRequestAttempt");
      } finally {
        debug.mockRestore();
      }
    });

    it("should not stringify endpoint ZCL send details unless debug logging evaluates the message", async () => {
      const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
      try {
        driverMock.sendZclEndpoint.mockResolvedValue(true);
        const zclFrame = Zcl.Frame.create(
          Zcl.FrameType.GLOBAL,
          Zcl.Direction.CLIENT_TO_SERVER,
          true,
          undefined,
          7,
          "read",
          Zcl.Clusters.genOnOff.ID,
          [{attrId: 0x0000}],
          {},
        );
        const ieeeAddr = {
          toString: () => {
            throw new Error("eager endpoint ZCL send detail string");
          },
        } as unknown as string;

        await adapter.sendZclFrameToEndpoint(
          ieeeAddr,
          0x1234,
          1,
          zclFrame,
          1000,
          true,
          true,
        );

        expect(debug).toHaveBeenCalledWith(expect.any(Function), expect.any(String));
      } finally {
        debug.mockRestore();
      }
    });

    it("should not stringify endpoint ZCL timeout details unless debug logging evaluates the message", async () => {
      const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
      try {
        driverMock.sendZclEndpoint.mockResolvedValue(true);
        const zclFrame = Zcl.Frame.create(
          Zcl.FrameType.GLOBAL,
          Zcl.Direction.CLIENT_TO_SERVER,
          false,
          undefined,
          7,
          "read",
          Zcl.Clusters.genOnOff.ID,
          [{attrId: 0x0000}],
          {},
        );
        const ieeeAddr = {
          toString: () => {
            throw new Error("eager endpoint ZCL timeout detail string");
          },
        } as unknown as string;

        const send = adapter.sendZclFrameToEndpoint(
          ieeeAddr,
          0x1234,
          1,
          zclFrame,
          1000,
          false,
          true,
        );
        const sendResult = send.then(
          () => "resolved",
          (error: Error) => `rejected:${error.message}`,
        );
        await vi.advanceTimersByTimeAsync(1000);

        await expect(sendResult).resolves.not.toBe(
          "rejected:eager endpoint ZCL timeout detail string",
        );
        expect(debug).toHaveBeenCalledWith(expect.any(Function), expect.any(String));
        void send.catch(() => {});
      } finally {
        debug.mockRestore();
      }
    });

    it("should use source endpoint and profile ID for group ZCL sends", async () => {
      driverMock.sendZclMulticast.mockResolvedValue(true);
      const zclFrame = Zcl.Frame.create(
        Zcl.FrameType.GLOBAL,
        Zcl.Direction.CLIENT_TO_SERVER,
        true,
        undefined,
        7,
        "read",
        Zcl.Clusters.genOnOff.ID,
        [{attrId: 0x0000}],
        {},
      );

      const send = (
        adapter.sendZclFrameToGroup as unknown as (
          groupID: number,
          zclFrame: Zcl.Frame,
          sourceEndpoint?: number,
          profileId?: number,
        ) => Promise<void>
      )(0x1234, zclFrame, 5, 0x0105);

      await vi.advanceTimersByTimeAsync(200);
      await send;

      expect(driverMock.sendZclMulticast).toHaveBeenCalledWith(
        0x1234,
        Zcl.Clusters.genOnOff.ID,
        0x0105,
        5,
        zclFrame.toBuffer(),
      );
    });

    it("should use explicit profile ID for broadcast ZCL sends", async () => {
      driverMock.sendZclBroadcast.mockResolvedValue(true);
      const zclFrame = Zcl.Frame.create(
        Zcl.FrameType.GLOBAL,
        Zcl.Direction.CLIENT_TO_SERVER,
        true,
        undefined,
        7,
        "read",
        Zcl.Clusters.genOnOff.ID,
        [{attrId: 0x0000}],
        {},
      );

      const send = (
        adapter.sendZclFrameToAll as unknown as (
          endpoint: number,
          zclFrame: Zcl.Frame,
          sourceEndpoint: number,
          destination: ZSpec.BroadcastAddress,
          profileId?: number,
        ) => Promise<void>
      )(3, zclFrame, 2, ZSpec.BroadcastAddress.DEFAULT, 0x0105);

      await vi.advanceTimersByTimeAsync(200);
      await send;

      expect(driverMock.sendZclBroadcast).toHaveBeenCalledWith(
        ZSpec.BroadcastAddress.DEFAULT,
        Zcl.Clusters.genOnOff.ID,
        0x0105,
        2,
        3,
        zclFrame.toBuffer(),
      );
    });

    it("should hand parsed channel changes to the driver API", async () => {
      driverMock.sendZdo.mockResolvedValue(undefined);

      const payload = Zdo.Buffalo.buildRequest(
        true,
        Zdo.ClusterId.NWK_UPDATE_REQUEST,
        [15],
        0xfe,
        undefined,
        1,
        undefined,
      );

      const change = adapter.sendZdo(
        ZSpec.BLANK_EUI64,
        ZSpec.BroadcastAddress.SLEEPY,
        Zdo.ClusterId.NWK_UPDATE_REQUEST,
        payload,
        true,
      );

      await vi.advanceTimersByTimeAsync(24000);
      await change;

      expect(driverMock.sendZdo).toHaveBeenCalledWith(
        ZSpec.BLANK_EUI64,
        ZSpec.BroadcastAddress.SLEEPY,
        Zdo.ClusterId.NWK_UPDATE_REQUEST,
        Buffer.from("0000800000fe01ffff", "hex"),
        true,
      );
      expect(driverMock.changeChannel).toHaveBeenCalledWith(15, 1);
    });

    it("should not copy the raw NWK update payload just for logging", async () => {
      driverMock.sendZdo.mockReturnValue(new Promise<void>(() => {}));
      const payload = Zdo.Buffalo.buildRequest(
        true,
        Zdo.ClusterId.NWK_UPDATE_REQUEST,
        [15],
        0xfe,
        undefined,
        1,
        undefined,
      );
      const originalFrom = Buffer.from;
      const fromSpy = vi.spyOn(Buffer, "from").mockImplementation(((value: unknown, ...args: unknown[]) => {
        if (value === payload) {
          throw new Error("raw payload copied");
        }

        return (originalFrom as (...parameters: unknown[]) => Buffer)(value, ...args);
      }) as typeof Buffer.from);

      const change = (
        adapter as unknown as {
          handleNwkUpdateRequest: (
            networkAddress: number,
            clusterId: Zdo.ClusterId,
            rawPayload: Buffer,
            disableResponse: boolean,
          ) => Promise<void>;
        }
      ).handleNwkUpdateRequest(
        ZSpec.BroadcastAddress.SLEEPY,
        Zdo.ClusterId.NWK_UPDATE_REQUEST,
        payload,
        true,
      );
      const changeResult = change.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      const observed = await Promise.race([
        changeResult,
        Promise.resolve("pending"),
      ]);
      fromSpy.mockRestore();

      expect(observed).toBe("pending");
      expect(driverMock.sendZdo).toHaveBeenCalledWith(
        ZSpec.BLANK_EUI64,
        ZSpec.BroadcastAddress.SLEEPY,
        Zdo.ClusterId.NWK_UPDATE_REQUEST,
        Buffer.from("0000800000fe01ffff", "hex"),
        true,
      );

      await adapter.stop();
      await change.catch(() => {});
    });

    it("should not stringify NWK update payloads unless debug logging evaluates the message", async () => {
      const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
      driverMock.sendZdo.mockReturnValue(new Promise<void>(() => {}));
      const payload = Zdo.Buffalo.buildRequest(
        true,
        Zdo.ClusterId.NWK_UPDATE_REQUEST,
        [15],
        0xfe,
        undefined,
        1,
        undefined,
      );
      const rawToStringSpy = vi.spyOn(payload, "toString").mockImplementation(() => {
        throw new Error("eager raw NWK update payload hex string");
      });
      const canonicalToStringSpies: Array<ReturnType<typeof vi.spyOn>> = [];
      const originalAllocUnsafe = Buffer.allocUnsafe;
      const allocUnsafeSpy = vi.spyOn(Buffer, "allocUnsafe").mockImplementation(((size: number, ...args: unknown[]) => {
        const buffer = (originalAllocUnsafe as (...parameters: unknown[]) => Buffer)(size, ...args);

        if (size === payload.length + 2) {
          canonicalToStringSpies.push(
            vi.spyOn(buffer, "toString").mockImplementation(() => {
              throw new Error("eager canonical NWK update payload hex string");
            }),
          );
        }

        return buffer;
      }) as typeof Buffer.allocUnsafe);

      try {
        const change = (
          adapter as unknown as {
            handleNwkUpdateRequest: (
              networkAddress: number,
              clusterId: Zdo.ClusterId,
              rawPayload: Buffer,
              disableResponse: boolean,
            ) => Promise<void>;
          }
        ).handleNwkUpdateRequest(
          ZSpec.BroadcastAddress.SLEEPY,
          Zdo.ClusterId.NWK_UPDATE_REQUEST,
          payload,
          true,
        );
        const changeResult = change.then(
          () => "resolved",
          (error: Error) => `rejected:${error.message}`,
        );

        await vi.advanceTimersByTimeAsync(0);
        const observed = await Promise.race([
          changeResult,
          Promise.resolve("pending"),
        ]);

        expect(observed).toBe("pending");
        expect(debug).toHaveBeenCalledWith(expect.any(Function), expect.any(String));

        await adapter.stop();
        await change.catch(() => {});
      } finally {
        rawToStringSpy.mockRestore();
        for (const spy of canonicalToStringSpies) {
          spy.mockRestore();
        }
        allocUnsafeSpy.mockRestore();
        debug.mockRestore();
      }
    });

    it("should cancel an in-flight channel change when stopping", async () => {
      driverMock.sendZdo.mockResolvedValue(undefined);
      driverMock.changeChannel.mockReturnValue(new Promise<void>(() => {}));
      driverMock.stop.mockResolvedValue(undefined);
      const payload = Zdo.Buffalo.buildRequest(
        true,
        Zdo.ClusterId.NWK_UPDATE_REQUEST,
        [15],
        0xfe,
        undefined,
        1,
        undefined,
      );

      const change = adapter.sendZdo(
        ZSpec.BLANK_EUI64,
        ZSpec.BroadcastAddress.SLEEPY,
        Zdo.ClusterId.NWK_UPDATE_REQUEST,
        payload,
        true,
      );
      const changeResult = change.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      await adapter.stop();
      await vi.advanceTimersByTimeAsync(0);
      const observed = await Promise.race([
        changeResult,
        Promise.resolve("pending"),
      ]);

      expect(observed).toBe("rejected:Adapter stopped");
      expect(driverMock.changeChannel).toHaveBeenCalledWith(15, 1);
      expect(driverMock.getNetworkKeyInfo).not.toHaveBeenCalled();
      expect(driverMock.formNetworkWithParameters).not.toHaveBeenCalled();
      await change.catch(() => {});
    });

    it("should cancel channel change while the driver change is pending", async () => {
      driverMock.sendZdo.mockResolvedValue(undefined);
      driverMock.changeChannel.mockReturnValue(new Promise<void>(() => {}));
      driverMock.stop.mockResolvedValue(undefined);
      const payload = Zdo.Buffalo.buildRequest(
        true,
        Zdo.ClusterId.NWK_UPDATE_REQUEST,
        [15],
        0xfe,
        undefined,
        1,
        undefined,
      );

      const change = adapter.sendZdo(
        ZSpec.BLANK_EUI64,
        ZSpec.BroadcastAddress.SLEEPY,
        Zdo.ClusterId.NWK_UPDATE_REQUEST,
        payload,
        true,
      );
      const changeResult = change.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      await adapter.stop();
      await vi.advanceTimersByTimeAsync(0);
      const observed = await Promise.race([
        changeResult,
        Promise.resolve("pending"),
      ]);

      expect(observed).toBe("rejected:Adapter stopped");
      expect(driverMock.changeChannel).toHaveBeenCalledWith(15, 1);
      expect(driverMock.getNetworkKeyInfo).not.toHaveBeenCalled();
      expect(driverMock.getGlobalTcLinkKey).not.toHaveBeenCalled();
      expect(driverMock.leaveNetwork).not.toHaveBeenCalled();
      await change.catch(() => {});
    });

    it("should serialize concurrent channel changes through the adapter queue", async () => {
      driverMock.sendZdo.mockResolvedValue(undefined);
      driverMock.changeChannel.mockReturnValue(new Promise<void>(() => {}));

      const firstPayload = Zdo.Buffalo.buildRequest(
        true,
        Zdo.ClusterId.NWK_UPDATE_REQUEST,
        [15],
        0xfe,
        undefined,
        1,
        undefined,
      );
      const secondPayload = Zdo.Buffalo.buildRequest(
        true,
        Zdo.ClusterId.NWK_UPDATE_REQUEST,
        [20],
        0xfe,
        undefined,
        2,
        undefined,
      );

      const firstChange = adapter.sendZdo(
        ZSpec.BLANK_EUI64,
        ZSpec.BroadcastAddress.SLEEPY,
        Zdo.ClusterId.NWK_UPDATE_REQUEST,
        firstPayload,
        true,
      );
      const secondChange = adapter.sendZdo(
        ZSpec.BLANK_EUI64,
        ZSpec.BroadcastAddress.SLEEPY,
        Zdo.ClusterId.NWK_UPDATE_REQUEST,
        secondPayload,
        true,
      );

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(driverMock.sendZdo).toHaveBeenCalledTimes(1);
      expect(driverMock.changeChannel).toHaveBeenCalledTimes(1);

      await adapter.stop();
      await Promise.all([firstChange.catch(() => {}), secondChange.catch(() => {})]);
    });

    it("should route leave ZDO requests through the driver API", async () => {
      const callback = vi.fn();
      adapter.on("deviceLeave", callback);
      driverMock.sendZdo.mockImplementation(async (
        ieee: string,
        nwk: number,
      ) => {
        driverMock.on.mock.calls.find((call) => call[0] === "deviceLeft")?.[1](
          nwk,
          { toString: () => ieee.replace(/^0x/, "") },
        );
      });

      await adapter.sendZdo(
        "0x0102030405060708",
        0x1234,
        Zdo.ClusterId.LEAVE_REQUEST,
        Buffer.from([0, 1, 2, 3]),
        true,
      );

      expect(driverMock.sendZdo).toHaveBeenCalledWith(
        "0x0102030405060708",
        0x1234,
        Zdo.ClusterId.LEAVE_REQUEST,
        Buffer.from([0, 1, 2, 3]),
        true,
      );
      expect(callback).toHaveBeenCalledWith({
        networkAddress: 0x1234,
        ieeeAddr: "0x0102030405060708",
      });
    });
  });

  describe("Message handling", () => {
    it("should handle device join", () => {
      const callback = vi.fn();
      adapter.on("deviceJoined", callback);

      driverMock.on.mock.calls.find((call) => call[0] === "deviceJoined")?.[1](
        0x1234,
        { toString: () => "0x0102030405060708" },
      );

      expect(callback).toHaveBeenCalledWith({
        networkAddress: 0x1234,
        ieeeAddr: "0x0102030405060708",
      });
    });

    it("should normalize uppercase IEEE prefixes from device joins", () => {
      const callback = vi.fn();
      adapter.on("deviceJoined", callback);

      driverMock.on.mock.calls.find((call) => call[0] === "deviceJoined")?.[1](
        0x1234,
        { toString: () => "0X0102030405060708" },
      );

      expect(callback).toHaveBeenCalledWith({
        networkAddress: 0x1234,
        ieeeAddr: "0x0102030405060708",
      });
    });

    it("should handle device leave", () => {
      const callback = vi.fn();
      adapter.on("deviceLeave", callback);

      driverMock.on.mock.calls.find((call) => call[0] === "deviceLeft")?.[1](
        0x1234,
        { toString: () => "0102030405060708" },
      );

      expect(callback).toHaveBeenCalledWith({
        networkAddress: 0x1234,
        ieeeAddr: "0x0102030405060708",
      });
    });

    it("should process ZDO messages", () => {
      const callback = vi.fn();
      adapter.on("zdoResponse", callback);

      const apsFrame = new BlzApsFrame();
      apsFrame.profileId = Zdo.ZDO_PROFILE_ID;
      apsFrame.clusterId = 0x8000;

      driverMock.on.mock.calls.find(
        (call) => call[0] === "incomingMessage",
      )?.[1]({
        apsFrame,
        zdoResponse: { status: BlzStatus.SUCCESS },
        sender: 0x1234,
        lqi: 255,
      });

      expect(callback).toHaveBeenCalledWith(0x8000, {
        status: BlzStatus.SUCCESS,
      });
    });

    it("should process ZCL messages", () => {
      const callback = vi.fn();
      adapter.on("zclPayload", callback);

      const apsFrame = new BlzApsFrame();
      apsFrame.profileId = ZSpec.HA_PROFILE_ID;
      apsFrame.clusterId = 0x0000;
      apsFrame.sourceEndpoint = 1;
      apsFrame.destinationEndpoint = 1;

      const message = Buffer.from([0x00, 0x00, 0x00]);

      driverMock.on.mock.calls.find(
        (call) => call[0] === "incomingMessage",
      )?.[1]({
        apsFrame,
        message,
        sender: 0x1234,
        lqi: 255,
      });

      expect(callback).toHaveBeenCalled();
    });

    it("should not resolve ZCL waiters from frames with reserved frame types", async () => {
      const waiter = adapter.waitFor(
        0x1234,
        1,
        Zcl.FrameType.SPECIFIC,
        Zcl.Direction.CLIENT_TO_SERVER,
        7,
        Zcl.Clusters.genOnOff.ID,
        Zcl.Clusters.genOnOff.commands.toggle.ID,
        100,
      );
      const result = waiter.promise.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );

      const apsFrame = new BlzApsFrame();
      apsFrame.profileId = ZSpec.HA_PROFILE_ID;
      apsFrame.clusterId = Zcl.Clusters.genOnOff.ID;
      apsFrame.sourceEndpoint = 1;
      apsFrame.destinationEndpoint = 1;

      driverMock.on.mock.calls.find(
        (call) => call[0] === "incomingMessage",
      )?.[1]({
        apsFrame,
        message: Buffer.from([
          0x02,
          7,
          Zcl.Clusters.genOnOff.commands.toggle.ID,
        ]),
        sender: 0x1234,
        lqi: 255,
      });

      await vi.advanceTimersByTimeAsync(100);

      await expect(result).resolves.toContain("rejected:Timeout after 100ms");
    });

    it("should mark broadcast ZCL messages", () => {
      const callback = vi.fn();
      adapter.on("zclPayload", callback);

      const apsFrame = new BlzApsFrame();
      apsFrame.profileId = ZSpec.HA_PROFILE_ID;
      apsFrame.clusterId = 0x0000;
      apsFrame.sourceEndpoint = 1;
      apsFrame.destinationEndpoint = 1;

      driverMock.on.mock.calls.find(
        (call) => call[0] === "incomingMessage",
      )?.[1]({
        messageType: BlzOutgoingMessageType.BLZ_MSG_TYPE_BROADCAST,
        apsFrame,
        message: Buffer.from([0x00, 0x00, 0x00]),
        sender: 0x1234,
        lqi: 255,
      });

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ wasBroadcast: true }),
      );
    });

    it("should resolve ZCL waiters with default responses like the shared adapter matcher", async () => {
      const waiter = adapter.waitFor(
        0x1234,
        1,
        Zcl.FrameType.SPECIFIC,
        Zcl.Direction.CLIENT_TO_SERVER,
        7,
        Zcl.Clusters.genOnOff.ID,
        Zcl.Clusters.genOnOff.commands.toggle.ID,
        100,
      );

      const defaultResponse = Zcl.Frame.create(
        Zcl.FrameType.GLOBAL,
        Zcl.Direction.SERVER_TO_CLIENT,
        true,
        undefined,
        7,
        "defaultRsp",
        Zcl.Clusters.genOnOff.ID,
        {
          cmdId: Zcl.Clusters.genOnOff.commands.toggle.ID,
          statusCode: Zcl.Status.SUCCESS,
        },
        {},
      );

      const apsFrame = new BlzApsFrame();
      apsFrame.profileId = ZSpec.HA_PROFILE_ID;
      apsFrame.clusterId = Zcl.Clusters.genOnOff.ID;
      apsFrame.sourceEndpoint = 1;
      apsFrame.destinationEndpoint = 1;

      await driverMock.on.mock.calls.find(
        (call) => call[0] === "incomingMessage",
      )?.[1]({
        apsFrame,
        message: defaultResponse.toBuffer(),
        sender: 0x1234,
        lqi: 255,
      });

      await vi.advanceTimersByTimeAsync(100);
      await expect(waiter.promise).resolves.toMatchObject({
        address: 0x1234,
        clusterID: Zcl.Clusters.genOnOff.ID,
      });
    });

    it("should process ZCL messages on custom profiles", async () => {
      const waiter = adapter.waitFor(
        0x1234,
        1,
        Zcl.FrameType.SPECIFIC,
        Zcl.Direction.CLIENT_TO_SERVER,
        7,
        Zcl.Clusters.genOnOff.ID,
        Zcl.Clusters.genOnOff.commands.toggle.ID,
        100,
      );

      const defaultResponse = Zcl.Frame.create(
        Zcl.FrameType.GLOBAL,
        Zcl.Direction.SERVER_TO_CLIENT,
        true,
        undefined,
        7,
        "defaultRsp",
        Zcl.Clusters.genOnOff.ID,
        {
          cmdId: Zcl.Clusters.genOnOff.commands.toggle.ID,
          statusCode: Zcl.Status.SUCCESS,
        },
        {},
      );
      const apsFrame = new BlzApsFrame();
      apsFrame.profileId = 0x0105;
      apsFrame.clusterId = Zcl.Clusters.genOnOff.ID;
      apsFrame.sourceEndpoint = 1;
      apsFrame.destinationEndpoint = 1;
      const result = waiter.promise.catch((error: Error) => error);

      await driverMock.on.mock.calls.find(
        (call) => call[0] === "incomingMessage",
      )?.[1]({
        apsFrame,
        message: defaultResponse.toBuffer(),
        sender: 0x1234,
        lqi: 255,
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(await result).toMatchObject({
        address: 0x1234,
        clusterID: Zcl.Clusters.genOnOff.ID,
      });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Backup operations", () => {
    it("should support backup", async () => {
      const supported = await adapter.supportsBackup();
      expect(supported).toBe(true);
    });

    it("should create backup", async () => {
      driverMock.isInitialized.mockReturnValue(true);
      driverMock.getBlz.mockImplementation(() => {
        throw new Error("transport leaked");
      });
      driverMock.createBackup.mockResolvedValue({});

      await adapter.backup();
      expect(driverMock.createBackup).toHaveBeenCalled();
    });

    it("should cancel backup when stopping", async () => {
      driverMock.blz.isInitialized.mockReturnValue(true);
      driverMock.createBackup.mockReturnValue(new Promise(() => {}));
      driverMock.stop.mockResolvedValue(undefined);

      const backup = adapter.backup();
      const backupResult = backup.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      await vi.advanceTimersByTimeAsync(0);

      await adapter.stop();
      await vi.advanceTimersByTimeAsync(0);
      const observed = await Promise.race([
        backupResult,
        Promise.resolve("pending"),
      ]);

      void backup.catch(() => {});

      expect(observed).toBe("rejected:Adapter stopped");
      expect(driverMock.createBackup).toHaveBeenCalled();
    });

    it("should pass a stop guard that prevents backup continuation after stop", async () => {
      driverMock.blz.isInitialized.mockReturnValue(true);
      driverMock.stop.mockResolvedValue(undefined);
      let finishBackupStep: (() => void) | undefined;
      const continuedAfterStop = vi.fn();
      driverMock.createBackup.mockImplementation(
        async (assertActive?: () => void) => {
          await new Promise<void>((resolve) => {
            finishBackupStep = resolve;
          });
          assertActive?.();
          continuedAfterStop();
          return {};
        },
      );

      const backup = adapter.backup();
      const backupResult = backup.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      await vi.advanceTimersByTimeAsync(0);

      await adapter.stop();
      finishBackupStep?.();
      await vi.advanceTimersByTimeAsync(0);
      const observed = await Promise.race([
        backupResult,
        Promise.resolve("pending"),
      ]);

      void backup.catch(() => {});

      expect(observed).toBe("rejected:Adapter stopped");
      expect(continuedAfterStop).not.toHaveBeenCalled();
    });
  });

  describe("Error handling", () => {
    it("should propagate driver-owned ZDO send failures", async () => {
      driverMock.sendZdo.mockRejectedValue(new Error("driver send failed"));

      await expect(
        adapter.sendZdo(
          "0x0102030405060708",
          0x1234,
          Zdo.ClusterId.NODE_DESCRIPTOR_REQUEST,
          Buffer.from([0x00, 0x34, 0x12]),
          false,
        ),
      ).rejects.toThrow("driver send failed");

      expect(driverMock.sendZdo).toHaveBeenCalledWith(
        "0x0102030405060708",
        0x1234,
        Zdo.ClusterId.NODE_DESCRIPTOR_REQUEST,
        Buffer.from([0x00, 0x34, 0x12]),
        false,
      );
    });

    it("should pass caller-owned ZDO payload buffers to the driver without cloning", async () => {
      const payload = Buffer.from([0xaa, 0xbb, 0xcc]);

      const originalFrom = Buffer.from;
      const fromSpy = vi.spyOn(Buffer, "from").mockImplementation(((value: unknown, ...args: unknown[]) => {
        if (value === payload) {
          throw new Error("caller payload cloned");
        }

        return (originalFrom as (...parameters: unknown[]) => Buffer)(value, ...args);
      }) as typeof Buffer.from);

      try {
        await adapter.sendZdo(
          "0x0102030405060708",
          0x1234,
          Zdo.ClusterId.NODE_DESCRIPTOR_REQUEST,
          payload,
          true,
        );

        expect(payload).toEqual(Buffer.of(0xaa, 0xbb, 0xcc));
        expect(driverMock.sendZdo).toHaveBeenCalledWith(
          "0x0102030405060708",
          0x1234,
          Zdo.ClusterId.NODE_DESCRIPTOR_REQUEST,
          payload,
          true,
        );
        expect(fromSpy).not.toHaveBeenCalledWith(payload);
      } finally {
        fromSpy.mockRestore();
      }
    });

    it("should not finish active ZDO sends after stop interrupts the driver request", async () => {
      let releaseRequest: (() => void) | undefined;
      const zdoRequest = new Promise<void>((resolve) => {
        releaseRequest = resolve;
      });

      driverMock.sendZdo.mockReturnValue(zdoRequest);
      driverMock.stop.mockResolvedValue(undefined);

      const send = adapter.sendZdo(
        "0x0102030405060708",
        0x1234,
        Zdo.ClusterId.LEAVE_REQUEST,
        Buffer.from([0x00]),
        true,
      );
      const sendResult = send.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      await vi.advanceTimersByTimeAsync(0);

      await adapter.stop();
      releaseRequest?.();
      await vi.advanceTimersByTimeAsync(0);

      await expect(sendResult).resolves.toBe("rejected:Adapter stopped");
      expect(driverMock.handleNodeLeft).not.toHaveBeenCalled();
    });

    it("should register active ZDO driver sends as cancellable adapter operations", async () => {
      const zdoRequest = new Promise<void>(() => {});

      driverMock.sendZdo.mockReturnValue(zdoRequest);
      driverMock.stop.mockResolvedValue(undefined);

      const send = adapter.sendZdo(
        "0x0102030405060708",
        0x1234,
        Zdo.ClusterId.LEAVE_REQUEST,
        Buffer.from([0x00]),
        true,
      );
      const sendResult = send.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      await vi.advanceTimersByTimeAsync(0);

      const runningOperations = (
        adapter as unknown as {runningOperations: {count: () => number}}
      ).runningOperations;
      expect(runningOperations.count()).toBe(1);

      await adapter.stop();
      await vi.advanceTimersByTimeAsync(0);

      await expect(sendResult).resolves.toBe("rejected:Adapter stopped");
      expect(runningOperations.count()).toBe(0);
      expect(driverMock.handleNodeLeft).not.toHaveBeenCalled();
      void send.catch(() => {});
    });

    it("should handle ZCL send failures before response waiters start", async () => {
      driverMock.sendZclEndpoint.mockResolvedValue(false);
      const zclFrame = Zcl.Frame.create(
        Zcl.FrameType.GLOBAL,
        Zcl.Direction.CLIENT_TO_SERVER,
        false,
        undefined,
        7,
        "read",
        Zcl.Clusters.genOnOff.ID,
        [{attrId: 0x0000}],
        {},
      );

      await expect(
        adapter.sendZclFrameToEndpoint(
          "0x0102030405060708",
          0x1234,
          1,
          zclFrame,
          1000,
          false,
          true,
        ),
      ).rejects.toThrow("sendZclFrameToEndpointInternal error");
    });

    it("should cancel ZCL response waiters when endpoint request rejects", async () => {
      driverMock.sendZclEndpoint.mockRejectedValue(new Error("driver request failed"));
      const zclFrame = Zcl.Frame.create(
        Zcl.FrameType.GLOBAL,
        Zcl.Direction.CLIENT_TO_SERVER,
        false,
        undefined,
        7,
        "read",
        Zcl.Clusters.genOnOff.ID,
        [{attrId: 0x0000}],
        {},
      );

      await expect(
        adapter.sendZclFrameToEndpoint(
          "0x0102030405060708",
          0x1234,
          1,
          zclFrame,
          1000,
          false,
          true,
        ),
      ).rejects.toThrow("driver request failed");
      expect(
        (
          adapter as unknown as {zclResponseWaiters: {count: () => number}}
        ).zclResponseWaiters.count(),
      ).toBe(0);
    });

    it("should handle unsupported operations", async () => {
      await expect(adapter.reset("soft")).rejects.toThrow("Not supported");
      await expect(
        adapter.addInstallCode("0x0102030405060708", Buffer.from([])),
      ).rejects.toThrow("Not supported");
      await expect(adapter.restoreChannelInterPAN()).rejects.toThrow(
        "Not supported",
      );
      await expect(adapter.setTransmitPower(0)).rejects.toThrow(
        "Not supported",
      );
      await expect(adapter.setChannelInterPAN(11)).rejects.toThrow(
        "Not supported",
      );
    });

    it("should handle driver close", () => {
      const callback = vi.fn();
      adapter.on("disconnected", callback);

      driverMock.on.mock.calls.find((call) => call[0] === "close")?.[1]();
      expect(callback).toHaveBeenCalled();
    });
  });
});
