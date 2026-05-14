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
    });

    it("should stop successfully", async () => {
      driverMock.stop.mockResolvedValue(undefined);
      await adapter.stop();
      expect(driverMock.stop).toHaveBeenCalled();
    });

    it("should detach owned driver listeners after a successful stop", async () => {
      driverMock.stop.mockResolvedValue(undefined);

      await adapter.stop();

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
      driverMock.request.mockReturnValueOnce(firstRequest).mockResolvedValue(true);
      driverMock.makeApsFrame.mockImplementation((clusterId: number) => {
        const apsFrame = new BlzApsFrame();
        apsFrame.clusterId = clusterId;
        return apsFrame;
      });
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

      expect(driverMock.request).toHaveBeenCalledTimes(1);
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
  });

  describe("Network operations", () => {
    it("should permit joining on coordinator", async () => {
      driverMock.blz.isInitialized.mockReturnValue(true);
      driverMock.permitJoining.mockResolvedValue({ status: BlzStatus.SUCCESS });
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

    it("should check permit join initialization through the driver API", async () => {
      (driverMock as unknown as {blz?: unknown}).blz = undefined;
      driverMock.isInitialized.mockReturnValue(true);
      driverMock.permitJoining.mockResolvedValue({ status: BlzStatus.SUCCESS });

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

    it("should send ZCL frame to all through broadcast request", async () => {
      const apsFrame = new BlzApsFrame();
      apsFrame.clusterId = Zcl.Clusters.genOnOff.ID;
      apsFrame.sequence = 0x33;
      driverMock.makeApsFrame.mockReturnValue(apsFrame);
      driverMock.brequest.mockResolvedValue(true);
      driverMock.mrequest.mockResolvedValue(true);
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

      expect(driverMock.brequest).toHaveBeenCalledWith(
        ZSpec.BroadcastAddress.DEFAULT,
        expect.objectContaining({
          profileId: ZSpec.HA_PROFILE_ID,
          clusterId: Zcl.Clusters.genOnOff.ID,
          sourceEndpoint: 1,
          destinationEndpoint: 3,
          groupId: ZSpec.BroadcastAddress.DEFAULT,
        }),
        zclFrame.toBuffer(),
      );
      expect(driverMock.mrequest).not.toHaveBeenCalled();
    });

    it("should reject when group ZCL send fails", async () => {
      const apsFrame = new BlzApsFrame();
      apsFrame.clusterId = Zcl.Clusters.genOnOff.ID;
      driverMock.makeApsFrame.mockReturnValue(apsFrame);
      driverMock.mrequest.mockResolvedValue(false);
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
      const apsFrame = new BlzApsFrame();
      apsFrame.clusterId = Zcl.Clusters.genOnOff.ID;
      driverMock.makeApsFrame.mockReturnValue(apsFrame);
      driverMock.mrequest.mockResolvedValue(true);
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
      const apsFrame = new BlzApsFrame();
      apsFrame.clusterId = Zcl.Clusters.genOnOff.ID;
      driverMock.makeApsFrame.mockReturnValue(apsFrame);
      driverMock.mrequest.mockReturnValue(new Promise<boolean>(() => {}));
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
      const apsFrame = new BlzApsFrame();
      apsFrame.clusterId = Zcl.Clusters.genOnOff.ID;
      driverMock.makeApsFrame.mockReturnValue(apsFrame);
      driverMock.brequest.mockResolvedValue(false);
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
      const apsFrame = new BlzApsFrame();
      apsFrame.clusterId = Zcl.Clusters.genOnOff.ID;
      driverMock.makeApsFrame.mockReturnValue(apsFrame);
      driverMock.brequest.mockReturnValue(new Promise<boolean>(() => {}));
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
      const apsFrame = new BlzApsFrame();
      apsFrame.clusterId = Zcl.Clusters.genOnOff.ID;
      driverMock.makeApsFrame.mockReturnValue(apsFrame);
      driverMock.request.mockResolvedValue(true);
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

      expect(driverMock.request).toHaveBeenCalledWith(
        0x1234,
        expect.objectContaining({
          profileId: 0x0105,
          sourceEndpoint: 2,
          destinationEndpoint: 3,
        }),
        zclFrame.toBuffer(),
      );
    });

    it("should not retry endpoint ZCL response waits after stop clears waiters", async () => {
      const apsFrame = new BlzApsFrame();
      apsFrame.clusterId = Zcl.Clusters.genOnOff.ID;
      driverMock.makeApsFrame.mockReturnValue(apsFrame);
      driverMock.request.mockResolvedValue(true);
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
      expect(driverMock.request).toHaveBeenCalledTimes(1);
    });

    it("should cancel endpoint ZCL response waiters when node caching throws", async () => {
      const apsFrame = new BlzApsFrame();
      apsFrame.clusterId = Zcl.Clusters.genOnOff.ID;
      driverMock.makeApsFrame.mockReturnValue(apsFrame);
      driverMock.setNode.mockImplementation(() => {
        throw new Error("set node failed");
      });
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
      ).rejects.toThrow("set node failed");

      expect(
        (adapter as unknown as {waitress: {waiters: Map<number, unknown>}}).waitress.waiters.size,
      ).toBe(0);
    });

    it("should register active endpoint lower sends as cancellable adapter operations", async () => {
      const apsFrame = new BlzApsFrame();
      apsFrame.clusterId = Zcl.Clusters.genOnOff.ID;
      driverMock.makeApsFrame.mockReturnValue(apsFrame);
      driverMock.request.mockReturnValue(new Promise<boolean>(() => {}));
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
        const apsFrame = new BlzApsFrame();
        apsFrame.clusterId = Zcl.Clusters.genOnOff.ID;
        driverMock.makeApsFrame.mockReturnValue(apsFrame);
        driverMock.request.mockResolvedValue(true);
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

    it("should use source endpoint and profile ID for group ZCL sends", async () => {
      const apsFrame = new BlzApsFrame();
      apsFrame.clusterId = Zcl.Clusters.genOnOff.ID;
      driverMock.makeApsFrame.mockReturnValue(apsFrame);
      driverMock.mrequest.mockResolvedValue(true);
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

      expect(driverMock.mrequest).toHaveBeenCalledWith(
        expect.objectContaining({
          profileId: 0x0105,
          sourceEndpoint: 5,
          destinationEndpoint: 0xff,
          groupId: 0x1234,
        }),
        zclFrame.toBuffer(),
      );
    });

    it("should use explicit profile ID for broadcast ZCL sends", async () => {
      const apsFrame = new BlzApsFrame();
      apsFrame.clusterId = Zcl.Clusters.genOnOff.ID;
      driverMock.makeApsFrame.mockReturnValue(apsFrame);
      driverMock.brequest.mockResolvedValue(true);
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

      expect(driverMock.brequest).toHaveBeenCalledWith(
        ZSpec.BroadcastAddress.DEFAULT,
        expect.objectContaining({
          profileId: 0x0105,
          sourceEndpoint: 2,
          destinationEndpoint: 3,
        }),
        zclFrame.toBuffer(),
      );
    });

    it("should preserve the extended PAN ID when changing channel", async () => {
      driverMock.networkParams.panId = 0x2ea0;
      driverMock.networkParams.extendedPanId = Buffer.from(
        "b3c6675b7437d674",
        "hex",
      );
      driverMock.networkParams.Channel = 11;
      driverMock.networkParams.nwkUpdateId = 0;
      driverMock.makeApsFrame.mockReturnValue({
        sequence: 9,
        profileId: Zdo.ZDO_PROFILE_ID,
        clusterId: Zdo.ClusterId.NWK_UPDATE_REQUEST,
        sourceEndpoint: 0,
        destinationEndpoint: 0,
      });
      driverMock.brequest.mockResolvedValue(true);
      driverMock.getNetworkKeyInfo.mockResolvedValue({
        nwkKey: Buffer.from("05b02757f70f2384c89cf08592bdfb4f", "hex"),
        outgoingFrameCounter: 40968,
        nwkKeySeqNum: 0,
      });
      driverMock.getGlobalTcLinkKey.mockResolvedValue({
        linkKey: Buffer.alloc(16),
        outgoingFrameCounter: 0,
      });
      driverMock.leaveNetwork.mockResolvedValue(BlzStatus.SUCCESS);
      driverMock.formNetworkWithParameters.mockResolvedValue(BlzStatus.SUCCESS);
      driverMock.setNetworkKeyInfo.mockResolvedValue(BlzStatus.SUCCESS);
      driverMock.setGlobalTcLinkKey.mockResolvedValue(BlzStatus.SUCCESS);
      driverMock.getBlz.mockImplementation(() => {
        throw new Error("transport leaked");
      });

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

      expect(driverMock.brequest).toHaveBeenCalledWith(
        ZSpec.BroadcastAddress.SLEEPY,
        expect.objectContaining({
          clusterId: Zdo.ClusterId.NWK_UPDATE_REQUEST,
        }),
        Buffer.from("0900800000fe01ffff", "hex"),
      );
      expect(driverMock.formNetworkWithParameters).toHaveBeenCalledWith(
        BigInt("0xb3c6675b7437d674"),
        0x2ea0,
        15,
      );
    });

    it("should cancel an in-flight channel change when stopping", async () => {
      driverMock.networkParams.panId = 0x2ea0;
      driverMock.networkParams.extendedPanId = Buffer.from(
        "b3c6675b7437d674",
        "hex",
      );
      driverMock.networkParams.Channel = 11;
      driverMock.networkParams.nwkUpdateId = 0;
      driverMock.makeApsFrame.mockReturnValue({
        sequence: 9,
        profileId: Zdo.ZDO_PROFILE_ID,
        clusterId: Zdo.ClusterId.NWK_UPDATE_REQUEST,
        sourceEndpoint: 0,
        destinationEndpoint: 0,
      });
      driverMock.brequest.mockResolvedValue(true);
      driverMock.stop.mockResolvedValue(undefined);
      driverMock.getNetworkKeyInfo.mockResolvedValue({
        nwkKey: Buffer.from("05b02757f70f2384c89cf08592bdfb4f", "hex"),
        outgoingFrameCounter: 40968,
        nwkKeySeqNum: 0,
      });
      driverMock.getGlobalTcLinkKey.mockResolvedValue({
        linkKey: Buffer.alloc(16),
        outgoingFrameCounter: 0,
      });
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
      expect(driverMock.leaveNetwork).not.toHaveBeenCalled();
      expect(driverMock.formNetworkWithParameters).not.toHaveBeenCalled();
      await change.catch(() => {});
    });

    it("should cancel channel change while reading network key info", async () => {
      driverMock.networkParams.panId = 0x2ea0;
      driverMock.networkParams.extendedPanId = Buffer.from(
        "b3c6675b7437d674",
        "hex",
      );
      driverMock.networkParams.Channel = 11;
      driverMock.networkParams.nwkUpdateId = 0;
      driverMock.makeApsFrame.mockReturnValue({
        sequence: 9,
        profileId: Zdo.ZDO_PROFILE_ID,
        clusterId: Zdo.ClusterId.NWK_UPDATE_REQUEST,
        sourceEndpoint: 0,
        destinationEndpoint: 0,
      });
      driverMock.brequest.mockResolvedValue(true);
      driverMock.stop.mockResolvedValue(undefined);
      driverMock.getNetworkKeyInfo.mockReturnValue(new Promise(() => {}));
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
      expect(driverMock.getNetworkKeyInfo).toHaveBeenCalled();
      expect(driverMock.getGlobalTcLinkKey).not.toHaveBeenCalled();
      expect(driverMock.leaveNetwork).not.toHaveBeenCalled();
      await change.catch(() => {});
    });

    it("should serialize concurrent channel changes through the adapter queue", async () => {
      driverMock.networkParams.panId = 0x2ea0;
      driverMock.networkParams.extendedPanId = Buffer.from(
        "b3c6675b7437d674",
        "hex",
      );
      driverMock.networkParams.Channel = 11;
      driverMock.networkParams.nwkUpdateId = 0;
      driverMock.makeApsFrame.mockImplementation(() => ({
        sequence: 9,
        profileId: Zdo.ZDO_PROFILE_ID,
        clusterId: Zdo.ClusterId.NWK_UPDATE_REQUEST,
        sourceEndpoint: 0,
        destinationEndpoint: 0,
      }));
      driverMock.brequest.mockResolvedValue(true);
      driverMock.getNetworkKeyInfo.mockReturnValue(new Promise(() => {}));

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

      expect(driverMock.brequest).toHaveBeenCalledTimes(1);
      expect(driverMock.getNetworkKeyInfo).toHaveBeenCalledTimes(1);

      await adapter.stop();
      await Promise.all([firstChange.catch(() => {}), secondChange.catch(() => {})]);
    });

    it("should clear the driver address cache when sending a leave request", async () => {
      const callback = vi.fn();
      adapter.on("deviceLeave", callback);
      driverMock.makeApsFrame.mockReturnValue({
        sequence: 9,
        profileId: Zdo.ZDO_PROFILE_ID,
        clusterId: Zdo.ClusterId.LEAVE_REQUEST,
        sourceEndpoint: 0,
        destinationEndpoint: 0,
      });
      driverMock.request.mockResolvedValue(true);
      driverMock.handleNodeLeft.mockImplementation((nwk: number, ieee: string) => {
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

      expect(driverMock.handleNodeLeft).toHaveBeenCalledWith(
        0x1234,
        "0x0102030405060708",
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
    it("should cancel ZDO waiters when the driver send rejects", async () => {
      const cancel = vi.fn();
      const start = vi.fn();
      const apsFrame = new BlzApsFrame();
      apsFrame.profileId = Zdo.ZDO_PROFILE_ID;
      apsFrame.clusterId = Zdo.ClusterId.NODE_DESCRIPTOR_REQUEST;
      apsFrame.sourceEndpoint = 0;
      apsFrame.destinationEndpoint = 0;
      apsFrame.sequence = 4;

      driverMock.makeApsFrame.mockReturnValue(apsFrame);
      driverMock.waitFor.mockReturnValue({ cancel, start });
      driverMock.request.mockRejectedValue(new Error("driver send failed"));

      await expect(
        adapter.sendZdo(
          "0x0102030405060708",
          0x1234,
          Zdo.ClusterId.NODE_DESCRIPTOR_REQUEST,
          Buffer.from([0x00, 0x34, 0x12]),
          false,
        ),
      ).rejects.toThrow("driver send failed");

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(start).not.toHaveBeenCalled();
    });

    it("should not finish active ZDO sends after stop interrupts the lower request", async () => {
      let releaseRequest: (() => void) | undefined;
      const lowerRequest = new Promise<boolean>((resolve) => {
        releaseRequest = () => resolve(true);
      });
      const apsFrame = new BlzApsFrame();
      apsFrame.profileId = Zdo.ZDO_PROFILE_ID;
      apsFrame.clusterId = Zdo.ClusterId.LEAVE_REQUEST;
      apsFrame.sourceEndpoint = 0;
      apsFrame.destinationEndpoint = 0;
      apsFrame.sequence = 4;

      driverMock.makeApsFrame.mockReturnValue(apsFrame);
      driverMock.request.mockReturnValue(lowerRequest);
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

    it("should register active ZDO lower sends as cancellable adapter operations", async () => {
      const lowerRequest = new Promise<boolean>(() => {});
      const apsFrame = new BlzApsFrame();
      apsFrame.profileId = Zdo.ZDO_PROFILE_ID;
      apsFrame.clusterId = Zdo.ClusterId.LEAVE_REQUEST;
      apsFrame.sourceEndpoint = 0;
      apsFrame.destinationEndpoint = 0;
      apsFrame.sequence = 4;

      driverMock.makeApsFrame.mockReturnValue(apsFrame);
      driverMock.request.mockReturnValue(lowerRequest);
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
      driverMock.makeApsFrame.mockImplementation((clusterId: number) => {
        const apsFrame = new BlzApsFrame();
        apsFrame.clusterId = clusterId;
        return apsFrame;
      });
      driverMock.request.mockResolvedValue(false);
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
      driverMock.makeApsFrame.mockImplementation((clusterId: number) => {
        const apsFrame = new BlzApsFrame();
        apsFrame.clusterId = clusterId;
        return apsFrame;
      });
      driverMock.request.mockRejectedValue(new Error("driver request failed"));
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
        (adapter as unknown as {waitress: {waiters: Map<number, unknown>}}).waitress.waiters.size,
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
