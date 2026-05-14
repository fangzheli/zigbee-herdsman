import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { BLZAdapter } from "../../../../src/adapter/blz/adapter/blzAdapter";
import { Driver } from "../../../../src/adapter/blz/driver/driver";
import { BlzStatus } from "../../../../src/adapter/blz/driver/types/named";
import { BlzApsFrame } from "../../../../src/adapter/blz/driver/types/struct";
import {
  AdapterOptions,
  NetworkOptions,
  SerialPortOptions,
} from "../../../../src/adapter/tstype";
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
    backupMan: {
      createBackup: ReturnType<typeof vi.fn>;
    };
    setNode: ReturnType<typeof vi.fn>;
    getNetworkKeyInfo: ReturnType<typeof vi.fn>;
    getGlobalTcLinkKey: ReturnType<typeof vi.fn>;
    setNetworkKeyInfo: ReturnType<typeof vi.fn>;
    setGlobalTcLinkKey: ReturnType<typeof vi.fn>;
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
      backupMan: {
        createBackup: vi.fn(),
      },
      setNode: vi.fn(),
      getNetworkKeyInfo: vi.fn(),
      getGlobalTcLinkKey: vi.fn(),
      setNetworkKeyInfo: vi.fn(),
      setGlobalTcLinkKey: vi.fn(),
    };

    vi.mocked(Driver).mockImplementation(() => driverMock as any);
    adapter = new BLZAdapter(
      networkOptions,
      serialPortOptions,
      "/path/to/backup",
      adapterOptions,
    );
  });

  describe("Startup and initialization", () => {
    it("should stop successfully", async () => {
      driverMock.stop.mockResolvedValue(undefined);
      await adapter.stop();
      expect(driverMock.stop).toHaveBeenCalled();
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

    it("should get coordinator version", async () => {
      const version = await adapter.getCoordinatorVersion();
      expect(version.type).toBe("BLZ v1");
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

    it("should get network parameters", async () => {
      const params = await adapter.getNetworkParameters();
      expect(params).toEqual({
        panID: 0x1234,
        extendedPanID: "0x0102030405060708",
        channel: 11,
        nwkUpdateID: 0,
      });
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
      driverMock.blz.leaveNetwork.mockResolvedValue(BlzStatus.SUCCESS);
      driverMock.blz.formNetwork.mockResolvedValue(BlzStatus.SUCCESS);
      driverMock.setNetworkKeyInfo.mockResolvedValue(BlzStatus.SUCCESS);
      driverMock.setGlobalTcLinkKey.mockResolvedValue(BlzStatus.SUCCESS);

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
      expect(driverMock.blz.formNetwork).toHaveBeenCalledWith(
        BigInt("0xb3c6675b7437d674"),
        0x2ea0,
        15,
      );
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
      driverMock.blz.isInitialized.mockReturnValue(true);
      driverMock.backupMan.createBackup.mockResolvedValue({});

      await adapter.backup();
      expect(driverMock.backupMan.createBackup).toHaveBeenCalled();
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
