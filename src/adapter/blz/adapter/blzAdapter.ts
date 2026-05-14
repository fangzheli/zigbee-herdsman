/* istanbul ignore file */

import assert from "node:assert";

import * as Models from "../../../models";
import { Queue, wait, Waitress } from "../../../utils";
import { logger } from "../../../utils/logger";
import * as ZSpec from "../../../zspec";
import * as Zcl from "../../../zspec/zcl";
import * as Zdo from "../../../zspec/zdo";
import * as ZdoTypes from "../../../zspec/zdo/definition/tstypes";
import Adapter, {
  type ClusterWaitressMatcher,
  type ZclWaitressPayload,
} from "../../adapter";
import type { ZclPayload } from "../../events";
import {
  AdapterOptions,
  CoordinatorVersion,
  NetworkOptions,
  NetworkParameters,
  SerialPortOptions,
  StartResult,
} from "../../tstype";
import { Driver, BlzIncomingMessage } from "../driver";
import { BlzEUI64, BlzStatus } from "../driver/types";
import type { BlzApsFrame } from "../driver/types/struct";
import { parseNwkUpdateChannelChange } from "./nwkUpdate";

const NS = "zh:blz";

const autoDetectDefinitions = [
  { manufacturer: "wch.cn", vendorId: "1A86", productId: "7523" }, // ThirdReality Zigbee USB Dongle
];

type ZdoSendWaiter = {
  cancel: () => void;
};

export class BLZAdapter extends Adapter {
  private driver: Driver;
  private waitress: Waitress<ZclWaitressPayload, ClusterWaitressMatcher>;
  private interpanLock: boolean;
  private queue: Queue;
  private closing: boolean;

  public constructor(
    networkOptions: NetworkOptions,
    serialPortOptions: SerialPortOptions,
    backupPath: string,
    adapterOptions: AdapterOptions,
  ) {
    super(networkOptions, serialPortOptions, backupPath, adapterOptions);
    this.hasZdoMessageOverhead = true;
    this.manufacturerID = Zcl.ManufacturerCode.BOUFFALO_LAB_NANJING_CO_LTD;

    this.waitress = new Waitress<ZclWaitressPayload, ClusterWaitressMatcher>(
      Adapter.zclWaitressValidator,
      Adapter.clusterWaitressTimeoutFormatter,
    );
    this.interpanLock = false;
    this.closing = false;

    const concurrent = adapterOptions?.concurrent ?? 8;
    logger.debug(`Adapter concurrent: ${concurrent}`, NS);
    this.queue = new Queue(concurrent);

    this.driver = new Driver(
      this.serialPortOptions,
      this.networkOptions,
      backupPath,
    );
    this.driver.on("close", this.onDriverClose.bind(this));
    this.driver.on("deviceJoined", this.handleDeviceJoin.bind(this));
    this.driver.on("deviceLeft", this.handleDeviceLeft.bind(this));
    this.driver.on("incomingMessage", this.processMessage.bind(this));
  }

  private processMessage(frame: BlzIncomingMessage): void {
    logger.debug(() => `processMessage: ${JSON.stringify(frame)}`, NS);

    if (frame.apsFrame.profileId === Zdo.ZDO_PROFILE_ID) {
      if (frame.apsFrame.clusterId >= 0x8000 /* response only */) {
        if (frame.zdoResponse) {
          this.emit("zdoResponse", frame.apsFrame.clusterId, frame.zdoResponse);
        }
      }
    } else if (
      frame.apsFrame.profileId === ZSpec.HA_PROFILE_ID ||
      frame.apsFrame.profileId === 0xffff
    ) {
      const payload: ZclPayload = {
        clusterID: frame.apsFrame.clusterId,
        header: Zcl.Header.fromBuffer(frame.message),
        data: frame.message,
        address: frame.sender,
        endpoint: frame.apsFrame.sourceEndpoint,
        linkquality: frame.lqi,
        groupID: frame.apsFrame.groupId ?? 0,
        wasBroadcast: false, // TODO
        destinationEndpoint: frame.apsFrame.destinationEndpoint,
      };

      if (payload.header !== undefined) {
        this.waitress.resolve(payload as ZclWaitressPayload);
      }
      this.emit("zclPayload", payload);
    } else if (
      frame.apsFrame.profileId === ZSpec.TOUCHLINK_PROFILE_ID &&
      frame.senderEui64
    ) {
      // Touchlink is not supported by BLZ
    } else if (frame.apsFrame.profileId === ZSpec.GP_PROFILE_ID) {
      // Green Power is not supported by BLZ
    }
  }

  private async handleDeviceJoin(nwk: number, ieee: BlzEUI64): Promise<void> {
    // Driver emits ieee as "0x" prefixed string, use as-is
    const ieeeAddr = ieee.toString().startsWith("0x")
      ? ieee.toString()
      : `0x${ieee.toString()}`;
    logger.debug(() => `Device join request received: ${nwk} ${ieeeAddr}`, NS);

    this.emit("deviceJoined", {
      networkAddress: nwk,
      ieeeAddr,
    });
  }

  private handleDeviceLeft(nwk: number, ieee: BlzEUI64): void {
    const ieeeAddr = ieee.toString().startsWith("0x")
      ? ieee.toString()
      : `0x${ieee.toString()}`;
    logger.debug(
      () => `Device left network request received: ${nwk} ${ieeeAddr}`,
      NS,
    );

    this.emit("deviceLeave", {
      networkAddress: nwk,
      ieeeAddr,
    });
  }

  /**
   * Adapter methods
   */
  public async start(): Promise<StartResult> {
    this.closing = false;
    const result = await this.driver.startup();
    await wait(1000);
    return result;
  }

  public async stop(): Promise<void> {
    this.closing = true;
    this.queue.clear();
    this.waitress.clear();

    try {
      await this.driver.stop();
    } catch (error) {
      this.closing = false;
      throw error;
    }
  }

  public onDriverClose(): void {
    logger.debug("onDriverClose()", NS);

    if (!this.closing) {
      this.emit("disconnected");
    }
  }

  public async getCoordinatorIEEE(): Promise<string> {
    return `0x${this.driver.ieee.toString()}`;
  }

  public async permitJoin(
    seconds: number,
    networkAddress?: number,
  ): Promise<void> {
    if (!this.driver.blz?.isInitialized()) {
      return;
    }

    const clusterId = Zdo.ClusterId.PERMIT_JOINING_REQUEST;

    if (networkAddress) {
      // Permit joining for specific devices is handled differently in BLZ
      // `authentication`: TC significance always 1 (zb specs)
      const zdoPayload = Zdo.Buffalo.buildRequest(
        this.hasZdoMessageOverhead,
        clusterId,
        seconds,
        1,
        [],
      );

      const result = await this.sendZdo(
        ZSpec.BLANK_EUI64,
        networkAddress,
        clusterId,
        zdoPayload,
        false,
      );

      /* istanbul ignore next */
      if (!Zdo.Buffalo.checkStatus(result)) {
        // TODO: will disappear once moved upstream
        throw new Zdo.StatusError(result[0]);
      }
    } else {
      const result = await this.driver.permitJoining(seconds);
      if (result.status !== BlzStatus.SUCCESS) {
        throw new Error(
          `[ZDO] Failed coordinator permit joining request with status=${result.status}.`,
        );
      }

      logger.debug(`Permit joining on coordinator for ${seconds} sec.`, NS);

      // broadcast permit joining ZDO
      if (networkAddress === undefined) {
        // `authentication`: TC significance always 1 (zb specs)
        const zdoPayload = Zdo.Buffalo.buildRequest(
          this.hasZdoMessageOverhead,
          clusterId,
          seconds,
          1,
          [],
        );

        await this.sendZdo(
          ZSpec.BLANK_EUI64,
          ZSpec.BroadcastAddress.DEFAULT,
          clusterId,
          zdoPayload,
          true,
        );
      }
    }
  }

  public async getCoordinatorVersion(): Promise<CoordinatorVersion> {
    const blz = this.driver.getBlz();

    return {
      type: `BLZ v${blz.version.product}`,
      meta: blz.version,
    };
  }

  public async addInstallCode(ieeeAddress: string, key: Buffer): Promise<void> {
    throw new Error("Not supported");
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async reset(type: "soft" | "hard"): Promise<void> {
    return await Promise.reject(new Error("Not supported"));
  }

  /**
   * Send a ZDO request / command frame.
   *
   * NWK_UPDATE_REQUEST (cluster 0x0038) needs special handling on BLZ because we
   * sometimes receive it without the optional `nwkManagerAddr` _and/or_ without
   * the Transaction Sequence Number (TSN) that is required when
   * `hasZdoMessageOverhead === true`.
   */
  public async sendZdo(
    ieeeAddress: string,
    networkAddress: number,
    clusterId: Zdo.ClusterId,
    payload: Buffer,
    disableResponse: true,
  ): Promise<void>;
  public async sendZdo<K extends keyof ZdoTypes.RequestToResponseMap>(
    ieeeAddress: string,
    networkAddress: number,
    clusterId: K,
    payload: Buffer,
    disableResponse: false,
  ): Promise<ZdoTypes.RequestToResponseMap[K]>;
  public async sendZdo<K extends keyof ZdoTypes.RequestToResponseMap>(
    ieeeAddress: string,
    networkAddress: number,
    clusterId: K,
    payload: Buffer,
    disableResponse: boolean,
  ): Promise<ZdoTypes.RequestToResponseMap[K] | undefined> {
    if (
      clusterId === Zdo.ClusterId.NWK_UPDATE_REQUEST &&
      ZSpec.Utils.isBroadcastAddress(networkAddress)
    ) {
      await this.handleNwkUpdateRequest(networkAddress, clusterId, payload, disableResponse);
      return;
    }

    return await this.queue.execute(async () => {
      this.checkInterpanLock();

      const clusterName = Zdo.ClusterId[clusterId];
      const frame = this.driver.makeApsFrame(clusterId, disableResponse);
      payload[0] = frame.sequence; // Sequence number is required for BLZ APS frame
      let waiter: ReturnType<typeof this.driver.waitFor> | undefined;
      let responseClusterId: number | undefined;

      if (!disableResponse) {
        responseClusterId = Zdo.Utils.getResponseClusterId(clusterId);

        if (responseClusterId) {
          waiter = this.driver.waitFor(
            responseClusterId === Zdo.ClusterId.NETWORK_ADDRESS_RESPONSE
              ? ieeeAddress
              : networkAddress,
            responseClusterId,
          );
        }
      }

      await this.sendZdoFrame(
        ieeeAddress,
        networkAddress,
        clusterName,
        frame,
        payload,
        waiter,
      );

      // BLZ hardware does not provide a device leave callback/indication.
      // After successfully sending LEAVE_REQUEST, emit deviceLeave immediately
      // so the controller removes the device from the database.
      if (clusterId === Zdo.ClusterId.LEAVE_REQUEST) {
        logger.info(
          `[BLZ] LEAVE_REQUEST sent to ${ieeeAddress}:${networkAddress}, emitting deviceLeave`,
          NS,
        );

        this.emit("deviceLeave", {
          networkAddress,
          ieeeAddr: ieeeAddress,
        });
      }

      if (waiter && responseClusterId !== undefined) {
        const response = await waiter.start().promise;

        logger.debug(
          () =>
            `<~~ [ZDO ${Zdo.ClusterId[responseClusterId]} ${JSON.stringify(response.zdoResponse!)}]`,
          NS,
        );

        return response.zdoResponse! as ZdoTypes.RequestToResponseMap[K];
      }
    }, networkAddress);
  }

  private async sendZdoFrame(
    ieeeAddress: string,
    networkAddress: number,
    clusterName: string,
    frame: BlzApsFrame,
    payload: Buffer,
    waiter: ZdoSendWaiter | undefined,
  ): Promise<void> {
    const isBroadcast = ZSpec.Utils.isBroadcastAddress(networkAddress);
    const route = isBroadcast
      ? `BROADCAST to=${networkAddress}`
      : `UNICAST to=${ieeeAddress}:${networkAddress}`;

    logger.debug(
      () => `~~~> [ZDO ${clusterName} ${route} payload=${payload.toString("hex")}]`,
      NS,
    );

    try {
      const req = isBroadcast
        ? await this.driver.brequest(networkAddress, frame, payload)
        : await this.driver.request(networkAddress, frame, payload);

      logger.debug(`~~~> [SENT ZDO ${isBroadcast ? "BROADCAST" : "UNICAST"}]`, NS);

      if (!req) {
        throw new Error(`~x~> [ZDO ${clusterName} ${route}] Failed to send request.`);
      }
    } catch (error) {
      waiter?.cancel();
      throw error;
    }
  }

  /**
   * Handle NWK_UPDATE_REQUEST broadcast for channel change.
   * Normalizes the payload (adding TSN/nwkManagerAddr if missing),
   * parses fields, broadcasts the request, and performs local channel change.
   */
  private async handleNwkUpdateRequest(
    networkAddress: number,
    clusterId: Zdo.ClusterId,
    rawPayload: Buffer,
    disableResponse: boolean,
  ): Promise<void> {
    const raw = Buffer.from(rawPayload);
    logger.debug(
      `[BLZ] NWK_UPDATE_REQUEST raw  len=${raw.length}  ${raw.toString("hex")}`,
      NS,
    );

    const channelChange = parseNwkUpdateChannelChange(
      rawPayload,
      this.hasZdoMessageOverhead,
    );
    const payload = channelChange.payload;

    logger.debug(
      `[BLZ] Canonical payload len=${payload.length} ${payload.toString("hex")}`,
      NS,
    );
    logger.debug(
      `[BLZ] Parsed -> mask=0x${channelChange.scanChannelsMask.toString(16)}, ` +
        `duration=0x${channelChange.scanDuration.toString(16)}, ` +
        `updateId=${channelChange.nwkUpdateId}, ` +
        `manager=0x${channelChange.nwkManagerAddr.toString(16)}`,
      NS,
    );

    if (channelChange.nwkUpdateId === 0) {
      logger.warning(`[BLZ] nwkUpdateId == 0 (unusual but allowed)`, NS);
    }

    logger.info(
      `[BLZ] Channel-change request -> channel ${channelChange.channel}, ` +
        `nwkUpdateId=${channelChange.nwkUpdateId}`,
      NS,
    );

    await this.queue.execute(async () => {
      this.checkInterpanLock();
      const frame = this.driver.makeApsFrame(clusterId, disableResponse);

      if (this.hasZdoMessageOverhead) {
        payload[0] = frame.sequence;
      }

      await this.sendZdoFrame(
        ZSpec.BLANK_EUI64,
        networkAddress,
        Zdo.ClusterId[clusterId],
        frame,
        payload,
        undefined,
      );
    }, networkAddress);

    await this.handleChannelChange(
      channelChange.channel,
      channelChange.nwkUpdateId,
    );
  }

  /**
   * Handle channel change for BLZ adapter
   * Since BLZ doesn't support runtime channel change, we:
   * 1. Wait for broadcast to propagate
   * 2. Leave the network
   * 3. Reform on the new channel
   */
  private async handleChannelChange(
    newChannel: number,
    nwkUpdateId: number,
  ): Promise<void> {
    logger.info(
      `[BLZ] Starting channel change to channel ${newChannel} with NWKUpdateID ${nwkUpdateId}`,
      NS,
    );

    // 1. Validate NWKUpdateID
    const currentParams = await this.getNetworkParameters();
    if (nwkUpdateId <= currentParams.nwkUpdateID) {
      throw new Error(
        `Invalid NWKUpdateID ${nwkUpdateId} - must be greater than current ${currentParams.nwkUpdateID}`,
      );
    }

    logger.debug(`[BLZ] Current network parameters:`, NS);
    logger.debug(`[BLZ]   - PanID: 0x${currentParams.panID.toString(16)}`, NS);
    logger.debug(`[BLZ]   - ExtendedPanID: ${currentParams.extendedPanID}`, NS);
    logger.debug(
      `[BLZ]   - ExtendedPanID type: ${typeof currentParams.extendedPanID}`,
      NS,
    );
    logger.debug(`[BLZ]   - Channel: ${currentParams.channel}`, NS);
    logger.debug(
      `[BLZ]   - Current NWKUpdateID: ${currentParams.nwkUpdateID}`,
      NS,
    );
    logger.debug(`[BLZ]   - New NWKUpdateID: ${nwkUpdateId}`, NS);

    // 2. Get current network state
    const networkKeyInfo = await this.driver.getNetworkKeyInfo();
    const tcLinkKeyInfo = await this.driver.getGlobalTcLinkKey();

    // 3. Wait for broadcast to propagate (minimum 15 seconds per Zigbee spec)
    logger.info(`[BLZ] Waiting for broadcast to propagate (15s)...`, NS);
    await wait(15000);

    // 4. Leave current network
    logger.info(`[BLZ] Leaving current network...`, NS);
    const blz = this.driver.getBlz();
    const leaveStatus = await blz.leaveNetwork();
    if (leaveStatus !== BlzStatus.SUCCESS) {
      throw new Error(
        `[BLZ] Failed to leave network with status=${leaveStatus}`,
      );
    }
    await wait(4000);

    // 5. Update network security info with new NWKUpdateID
    logger.info(`[BLZ] Updating network security info...`, NS);
    await this.driver.setNetworkKeyInfo(
      networkKeyInfo.nwkKey,
      networkKeyInfo.outgoingFrameCounter,
      networkKeyInfo.nwkKeySeqNum,
    );
    await this.driver.setGlobalTcLinkKey(
      tcLinkKeyInfo.linkKey,
      tcLinkKeyInfo.outgoingFrameCounter,
    );

    // 6. Reform network on new channel
    logger.info(`[BLZ] Reforming network on channel ${newChannel}...`, NS);
    const extPanId = BigInt(currentParams.extendedPanID);
    const formStatus = await blz.formNetwork(
      extPanId,
      currentParams.panID,
      newChannel,
    );

    if (formStatus !== BlzStatus.SUCCESS) {
      throw new Error(`[BLZ] Failed to form network on channel ${newChannel}`);
    }

    // 7. Update driver's network parameters
    this.driver.networkParams.Channel = newChannel;
    this.driver.networkParams.nwkUpdateId = nwkUpdateId;

    // 8. Wait for network stabilization
    logger.info(`[BLZ] Waiting for network to stabilize (5s)...`, NS);
    await wait(5000);

    logger.info(`[BLZ] Channel change completed successfully`, NS);
  }

  public async sendZclFrameToEndpoint(
    ieeeAddr: string,
    networkAddress: number,
    endpoint: number,
    zclFrame: Zcl.Frame,
    timeout: number,
    disableResponse: boolean,
    disableRecovery: boolean,
    sourceEndpoint?: number,
  ): Promise<ZclPayload | undefined> {
    return await this.queue.execute<ZclPayload | undefined>(async () => {
      this.checkInterpanLock();
      return await this.sendZclFrameToEndpointInternal(
        ieeeAddr,
        networkAddress,
        endpoint,
        sourceEndpoint || 1,
        zclFrame,
        timeout,
        disableResponse,
        disableRecovery,
        0,
        0,
      );
    }, networkAddress);
  }

  private async sendZclFrameToEndpointInternal(
    ieeeAddr: string | undefined,
    networkAddress: number,
    endpoint: number,
    sourceEndpoint: number,
    zclFrame: Zcl.Frame,
    timeout: number,
    disableResponse: boolean,
    disableRecovery: boolean,
    responseAttempt: number,
    dataRequestAttempt: number,
  ): Promise<ZclPayload | undefined> {
    if (ieeeAddr == null) {
      ieeeAddr = `0x${this.driver.ieee.toString()}`;
    }
    logger.debug(
      `sendZclFrameToEndpointInternal ${ieeeAddr}:${networkAddress}/${endpoint} ` +
        `(${responseAttempt},${dataRequestAttempt},${this.queue.count()}), timeout=${timeout}`,
      NS,
    );
    let response = null;
    const command = zclFrame.command;
    if (command.response != undefined && disableResponse === false) {
      response = this.waitForInternal(
        networkAddress,
        endpoint,
        zclFrame.header.transactionSequenceNumber,
        zclFrame.cluster.ID,
        command.response,
        timeout,
      );
    } else if (!zclFrame.header.frameControl.disableDefaultResponse) {
      response = this.waitForInternal(
        networkAddress,
        endpoint,
        zclFrame.header.transactionSequenceNumber,
        zclFrame.cluster.ID,
        Zcl.Foundation.defaultRsp.ID,
        timeout,
      );
    }

    const frame = this.driver.makeApsFrame(
      zclFrame.cluster.ID,
      disableResponse || zclFrame.header.frameControl.disableDefaultResponse,
    );
    frame.profileId = ZSpec.HA_PROFILE_ID;
    frame.sourceEndpoint = sourceEndpoint || 0x01;
    frame.destinationEndpoint = endpoint;
    frame.groupId = 0;

    this.driver.setNode(networkAddress, new BlzEUI64(ieeeAddr));
    const dataConfirmResult = await this.driver.request(
      networkAddress,
      frame,
      zclFrame.toBuffer(),
    );
    if (!dataConfirmResult) {
      if (response != null) {
        response.cancel();
      }
      throw Error("sendZclFrameToEndpointInternal error");
    }
    if (response !== null) {
      try {
        const result = await response.start().promise;
        return result;
      } catch (error) {
        logger.debug(
          `Response timeout (${ieeeAddr}:${networkAddress},${responseAttempt})`,
          NS,
        );
        if (responseAttempt < 1 && !disableRecovery) {
          return await this.sendZclFrameToEndpointInternal(
            ieeeAddr,
            networkAddress,
            endpoint,
            sourceEndpoint,
            zclFrame,
            timeout,
            disableResponse,
            disableRecovery,
            responseAttempt + 1,
            dataRequestAttempt,
          );
        } else {
          throw error;
        }
      }
    }
  }

  public async sendZclFrameToGroup(
    groupID: number,
    zclFrame: Zcl.Frame,
  ): Promise<void> {
    return await this.queue.execute<void>(async () => {
      this.checkInterpanLock();
      const frame = this.driver.makeApsFrame(zclFrame.cluster.ID, false);
      frame.profileId = ZSpec.HA_PROFILE_ID;
      frame.sourceEndpoint = 0x01;
      frame.destinationEndpoint = 0x01;
      frame.groupId = groupID;

      const sent = await this.driver.mrequest(frame, zclFrame.toBuffer());
      if (!sent) {
        throw new Error(`Failed to send group request`);
      }
      /**
       * As a group command is not confirmed and thus immidiately returns
       * (contrary to network address requests) we will give the
       * command some time to 'settle' in the network.
       */
      await wait(200);
    });
  }

  public async sendZclFrameToAll(
    endpoint: number,
    zclFrame: Zcl.Frame,
    sourceEndpoint: number,
    destination: ZSpec.BroadcastAddress,
  ): Promise<void> {
    return await this.queue.execute<void>(async () => {
      this.checkInterpanLock();
      const frame = this.driver.makeApsFrame(zclFrame.cluster.ID, false);
      // Green Power is not supported by BLZ
      if (endpoint === ZSpec.GP_ENDPOINT) {
        return;
      }
      frame.profileId =
        sourceEndpoint === ZSpec.GP_ENDPOINT && endpoint === ZSpec.GP_ENDPOINT
          ? ZSpec.GP_PROFILE_ID
          : ZSpec.HA_PROFILE_ID;
      frame.sourceEndpoint = sourceEndpoint;
      frame.destinationEndpoint = endpoint;
      frame.groupId = destination;

      const sent = await this.driver.brequest(destination, frame, zclFrame.toBuffer());
      if (!sent) {
        throw new Error(`Failed to send broadcast request`);
      }

      /**
       * As a broadcast command is not confirmed and thus immidiately returns
       * (contrary to network address requests) we will give the
       * command some time to 'settle' in the network.
       */
      await wait(200);
    });
  }

  public async getNetworkParameters(): Promise<NetworkParameters> {
    const extPanId = this.driver.networkParams.extendedPanId;
    const extendedPanID =
      extPanId instanceof Buffer
        ? "0x" + extPanId.toString("hex")
        : "0x0000000000000000";

    return {
      panID: this.driver.networkParams.panId,
      extendedPanID,
      channel: this.driver.networkParams.Channel,
      nwkUpdateID: this.driver.networkParams.nwkUpdateId,
    };
  }

  public async supportsBackup(): Promise<boolean> {
    return true;
  }

  public async backup(): Promise<Models.Backup> {
    const blz = this.driver.getBlz();

    assert(
      blz.isInitialized(),
      "Cannot make backup when blz is not initialized",
    );
    return await this.driver.backupMan.createBackup();
  }

  public async restoreChannelInterPAN(): Promise<void> {
    throw new Error("Not supported");
  }

  private checkInterpanLock(): void {
    if (this.interpanLock) {
      throw new Error(`Cannot execute command, in Inter-PAN mode`);
    }
  }

  public async sendZclFrameInterPANToIeeeAddr(
    zclFrame: Zcl.Frame,
    ieeeAddr: string,
  ): Promise<void> {
    throw new Error("Not supported");
  }

  public async sendZclFrameInterPANBroadcast(
    zclFrame: Zcl.Frame,
    timeout: number,
    disableResponse: false,
  ): Promise<ZclPayload>;
  public async sendZclFrameInterPANBroadcast(
    zclFrame: Zcl.Frame,
    timeout: number,
    disableResponse: true,
  ): Promise<undefined>;
  public async sendZclFrameInterPANBroadcast(
    zclFrame: Zcl.Frame,
    timeout: number,
    disableResponse: boolean,
  ): Promise<ZclPayload | undefined> {
    throw new Error("Not supported");
  }

  public async setTransmitPower(value: number): Promise<void> {
    throw new Error("Not supported");
  }

  public async setChannelInterPAN(channel: number): Promise<void> {
    throw new Error("Not supported");
  }

  private waitForInternal(
    networkAddress: number | undefined,
    endpoint: number,
    transactionSequenceNumber: number | undefined,
    clusterID: number,
    commandIdentifier: number,
    timeout: number,
  ): { start: () => { promise: Promise<ZclPayload> }; cancel: () => void } {
    const waiter = this.waitress.waitFor({
      address: networkAddress,
      endpoint,
      clusterId: clusterID,
      commandId: commandIdentifier,
      transactionSequenceNumber,
    }, timeout);
    const cancel = (): void => this.waitress.remove(waiter.ID);
    return { start: waiter.start, cancel };
  }

  public waitFor(
    networkAddress: number | undefined,
    endpoint: number,
    frameType: Zcl.FrameType,
    direction: Zcl.Direction,
    transactionSequenceNumber: number | undefined,
    clusterID: number,
    commandIdentifier: number,
    timeout: number,
  ): { promise: Promise<ZclPayload>; cancel: () => void } {
    const waiter = this.waitForInternal(
      networkAddress,
      endpoint,
      transactionSequenceNumber,
      clusterID,
      commandIdentifier,
      timeout,
    );

    return { cancel: waiter.cancel, promise: waiter.start().promise };
  }
}
