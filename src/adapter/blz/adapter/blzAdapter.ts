/* istanbul ignore file */

import assert from "node:assert";

import * as Models from "../../../models";
import { Queue, Waitress } from "../../../utils";
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
import { CancellableDelay } from "../driver/cancellableDelay";
import { CancellableOperation } from "../driver/cancellableOperation";
import { Driver, BlzIncomingMessage } from "../driver";
import { BlzEUI64, BlzOutgoingMessageType, BlzStatus } from "../driver/types";
import type { BlzApsFrame } from "../driver/types/struct";
import { formatIeeeAddress } from "../ieee";
import { parseNwkUpdateChannelChange } from "./nwkUpdate";

const NS = "zh:blz";

const autoDetectDefinitions = [
  { manufacturer: "wch.cn", vendorId: "1A86", productId: "7523" }, // ThirdReality Zigbee USB Dongle
];

function parseZclHeader(message: Buffer): Zcl.Header | undefined {
  const header = Zcl.Header.fromBuffer(message);

  if (
    header !== undefined &&
    header.frameControl.frameType !== Zcl.FrameType.GLOBAL &&
    header.frameControl.frameType !== Zcl.FrameType.SPECIFIC
  ) {
    logger.debug(
      `Ignoring ZCL header with reserved frame type ${header.frameControl.frameType}`,
      NS,
    );
    return undefined;
  }

  return header;
}

function clonePayloadWithSequence(payload: Buffer, sequence: number): Buffer {
  const requestPayload = Buffer.allocUnsafe(payload.length);
  payload.copy(requestPayload);
  requestPayload[0] = sequence;
  return requestPayload;
}

type ZdoSendWaiter = {
  cancel: () => void;
};

export class BLZAdapter extends Adapter {
  private driver: Driver;
  private waitress: Waitress<ZclWaitressPayload, ClusterWaitressMatcher>;
  private interpanLock: boolean;
  private queue: Queue;
  private closing: boolean;
  private stopGeneration: number;
  private readonly stopDelay = new CancellableDelay();
  private driverListenersAttached = false;
  private readonly runningOperations = new CancellableOperation();
  private startPromise?: Promise<StartResult>;
  private stopPromise?: Promise<void>;
  private runningCancellationError?: Error;
  private readonly onDriverCloseHandler = this.onDriverClose.bind(this);
  private readonly onDeviceJoinedHandler = this.handleDeviceJoin.bind(this);
  private readonly onDeviceLeftHandler = this.handleDeviceLeft.bind(this);
  private readonly onIncomingMessageHandler = this.processMessage.bind(this);

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
    this.stopGeneration = 0;

    const concurrent = adapterOptions?.concurrent ?? 8;
    logger.debug(`Adapter concurrent: ${concurrent}`, NS);
    this.queue = new Queue(concurrent);

    this.driver = new Driver(
      this.serialPortOptions,
      this.networkOptions,
      backupPath,
    );
    this.attachDriverListeners();
  }

  private attachDriverListeners(): void {
    if (this.driverListenersAttached) {
      return;
    }

    this.driver.on("close", this.onDriverCloseHandler);
    this.driver.on("deviceJoined", this.onDeviceJoinedHandler);
    this.driver.on("deviceLeft", this.onDeviceLeftHandler);
    this.driver.on("incomingMessage", this.onIncomingMessageHandler);
    this.driverListenersAttached = true;
  }

  private detachDriverListeners(): void {
    if (!this.driverListenersAttached) {
      return;
    }

    this.driver.off("close", this.onDriverCloseHandler);
    this.driver.off("deviceJoined", this.onDeviceJoinedHandler);
    this.driver.off("deviceLeft", this.onDeviceLeftHandler);
    this.driver.off("incomingMessage", this.onIncomingMessageHandler);
    this.driverListenersAttached = false;
  }

  private processMessage(frame: BlzIncomingMessage): void {
    logger.debug(() => `processMessage: ${JSON.stringify(frame)}`, NS);

    if (frame.apsFrame.profileId === Zdo.ZDO_PROFILE_ID) {
      if (frame.apsFrame.clusterId >= 0x8000 /* response only */) {
        if (frame.zdoResponse) {
          this.emit("zdoResponse", frame.apsFrame.clusterId, frame.zdoResponse);
        }
      }
    } else if (frame.apsFrame.profileId === ZSpec.TOUCHLINK_PROFILE_ID) {
      // Touchlink is not supported by BLZ
    } else if (frame.apsFrame.profileId === ZSpec.GP_PROFILE_ID) {
      // Green Power is not supported by BLZ
    } else {
      const payload: ZclPayload = {
        clusterID: frame.apsFrame.clusterId,
        header: parseZclHeader(frame.message),
        data: frame.message,
        address: frame.sender,
        endpoint: frame.apsFrame.sourceEndpoint,
        linkquality: frame.lqi,
        groupID: frame.apsFrame.groupId ?? 0,
        wasBroadcast:
          frame.messageType === BlzOutgoingMessageType.BLZ_MSG_TYPE_BROADCAST,
        destinationEndpoint: frame.apsFrame.destinationEndpoint,
      };

      if (payload.header !== undefined) {
        this.waitress.resolve(payload as ZclWaitressPayload);
      }
      this.emit("zclPayload", payload);
    }
  }

  private handleDeviceJoin(nwk: number, ieee: BlzEUI64): void {
    const ieeeAddr = formatIeeeAddress(ieee);
    logger.debug(() => `Device join request received: ${nwk} ${ieeeAddr}`, NS);

    this.emit("deviceJoined", {
      networkAddress: nwk,
      ieeeAddr,
    });
  }

  private handleDeviceLeft(nwk: number, ieee: BlzEUI64): void {
    const ieeeAddr = formatIeeeAddress(ieee);
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
    if (this.stopPromise) {
      await this.stopPromise;
    }

    if (this.startPromise) {
      logger.debug("Adapter start already in progress.", NS);
      return await this.startPromise;
    }

    const startPromise = this.performStart().finally(() => {
      if (this.startPromise === startPromise) {
        this.startPromise = undefined;
      }
    });
    this.startPromise = startPromise;

    return await startPromise;
  }

  private async performStart(): Promise<StartResult> {
    this.closing = false;
    this.runningCancellationError = undefined;
    this.attachDriverListeners();
    const generation = this.stopGeneration;
    try {
      const result = await this.runOperationWhileRunning(
        () => this.driver.startup(),
        generation,
      );
      await this.waitWhileRunning(1000, generation);
      return result;
    } catch (error) {
      this.detachDriverListeners();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.stopPromise) {
      logger.debug("Adapter stop already in progress.", NS);
      return await this.stopPromise;
    }

    const stopPromise = this.performStop().finally(() => {
      if (this.stopPromise === stopPromise) {
        this.stopPromise = undefined;
      }
    });
    this.stopPromise = stopPromise;

    return await stopPromise;
  }

  private async performStop(): Promise<void> {
    this.closing = true;
    this.stopGeneration += 1;
    const stopError = new Error("Adapter stopped");
    this.queue.clear(stopError);
    this.waitress.clear(stopError);
    this.cancelRunningOperations(stopError);
    this.stopDelay.cancel();

    try {
      await this.driver.stop(false);
      this.detachDriverListeners();
    } catch (error) {
      this.closing = false;
      throw error;
    }
  }

  private onDriverClose(): void {
    logger.debug("onDriverClose()", NS);

    const wasClosing = this.closing;
    const closeError = new Error("Adapter disconnected");
    this.closing = true;
    this.stopGeneration += 1;
    this.queue.clear(closeError);
    this.waitress.clear(closeError);
    this.cancelRunningOperations(closeError);
    this.stopDelay.cancel();
    this.detachDriverListeners();

    if (!wasClosing) {
      this.emit("disconnected");
    }
  }

  private throwIfStopped(generation: number): void {
    if (this.closing || generation !== this.stopGeneration) {
      throw this.runningCancellationError ?? new Error("Adapter stopped");
    }
  }

  private cancelRunningOperations(error: Error): void {
    this.runningCancellationError = error;
    this.runningOperations.cancel(error);
  }

  private async runOperationWhileRunning<T>(
    operation: () => Promise<T>,
    generation: number,
  ): Promise<T> {
    return await this.runningOperations.run(
      operation,
      () => !this.closing && generation === this.stopGeneration,
      () => this.runningCancellationError ?? new Error("Adapter stopped"),
    );
  }

  private async waitWhileRunning(
    milliseconds: number,
    generation: number,
  ): Promise<void> {
    this.throwIfStopped(generation);

    const completed = await this.stopDelay.wait(
      milliseconds,
      () => !this.closing && generation === this.stopGeneration,
    );

    if (!completed) {
      throw this.runningCancellationError ?? new Error("Adapter stopped");
    }

    this.throwIfStopped(generation);
  }

  public async getCoordinatorIEEE(): Promise<string> {
    return formatIeeeAddress(this.driver.getCoordinatorIeee());
  }

  public async permitJoin(
    seconds: number,
    networkAddress?: number,
  ): Promise<void> {
    if (!this.driver.isInitialized()) {
      return;
    }

    const generation = this.stopGeneration;
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
      const result = await this.runOperationWhileRunning(
        () => this.driver.permitJoining(seconds),
        generation,
      );
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
    return this.driver.getCoordinatorVersion();
  }

  public async addInstallCode(ieeeAddress: string, key: Buffer): Promise<void> {
    throw new Error("Not supported");
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async reset(type: "soft" | "hard"): Promise<void> {
    throw new Error("Not supported");
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
      const generation = this.stopGeneration;
      this.throwIfStopped(generation);

      const clusterName = Zdo.ClusterId[clusterId];
      const frame = this.driver.makeApsFrame(clusterId);
      // Sequence number is required for BLZ APS frame.
      const requestPayload = clonePayloadWithSequence(payload, frame.sequence);
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
        requestPayload,
        waiter,
        generation,
      );
      this.throwIfStopped(generation);

      // BLZ hardware does not provide a device leave callback/indication.
      // Route the synthetic leave through the driver so its address cache is
      // cleared before the controller removes the device from the database.
      if (clusterId === Zdo.ClusterId.LEAVE_REQUEST) {
        logger.info(
          `[BLZ] LEAVE_REQUEST sent to ${ieeeAddress}:${networkAddress}, emitting deviceLeave`,
          NS,
        );

        this.driver.handleNodeLeft(networkAddress, ieeeAddress);
      }

      if (waiter && responseClusterId !== undefined) {
        const response = await waiter.start().promise;
        this.throwIfStopped(generation);

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
    generation: number,
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
      const req = await this.runOperationWhileRunning(
        () =>
          isBroadcast
            ? this.driver.brequest(networkAddress, frame, payload)
            : this.driver.request(networkAddress, frame, payload),
        generation,
      );

      this.throwIfStopped(generation);
      logger.debug(`~~~> [SENT ZDO ${isBroadcast ? "BROADCAST" : "UNICAST"}]`, NS);

      if (!req) {
        throw new Error(`~x~> [ZDO ${clusterName} ${route}] Failed to send request.`);
      }
    } catch (error) {
      waiter?.cancel();
      this.throwIfStopped(generation);
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
    logger.debug(
      () => `[BLZ] NWK_UPDATE_REQUEST raw  len=${rawPayload.length}  ${rawPayload.toString("hex")}`,
      NS,
    );

    const channelChange = parseNwkUpdateChannelChange(
      rawPayload,
      this.hasZdoMessageOverhead,
    );
    const payload = channelChange.payload;

    logger.debug(
      () => `[BLZ] Canonical payload len=${payload.length} ${payload.toString("hex")}`,
      NS,
    );
    logger.debug(
      () => `[BLZ] Parsed -> mask=0x${channelChange.scanChannelsMask.toString(16)}, ` +
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
      const generation = this.stopGeneration;
      this.throwIfStopped(generation);
      const frame = this.driver.makeApsFrame(clusterId);

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
        generation,
      );

      await this.handleChannelChange(
        channelChange.channel,
        channelChange.nwkUpdateId,
      );
    }, networkAddress);
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
    const generation = this.stopGeneration;
    logger.info(
      `[BLZ] Starting channel change to channel ${newChannel} with NWKUpdateID ${nwkUpdateId}`,
      NS,
    );

    this.throwIfStopped(generation);

    // 1. Validate NWKUpdateID
    const currentParams = await this.runOperationWhileRunning(
      () => this.getNetworkParameters(),
      generation,
    );
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
    const networkKeyInfo = await this.runOperationWhileRunning(
      () => this.driver.getNetworkKeyInfo(),
      generation,
    );
    const tcLinkKeyInfo = await this.runOperationWhileRunning(
      () => this.driver.getGlobalTcLinkKey(),
      generation,
    );

    // 3. Wait for broadcast to propagate (minimum 15 seconds per Zigbee spec)
    logger.info(`[BLZ] Waiting for broadcast to propagate (15s)...`, NS);
    await this.waitWhileRunning(15000, generation);

    // 4. Leave current network
    logger.info(`[BLZ] Leaving current network...`, NS);
    const leaveStatus = await this.runOperationWhileRunning(
      () => this.driver.leaveNetwork(),
      generation,
    );
    if (leaveStatus !== BlzStatus.SUCCESS) {
      throw new Error(
        `[BLZ] Failed to leave network with status=${leaveStatus}`,
      );
    }
    await this.waitWhileRunning(4000, generation);

    // 5. Update network security info with new NWKUpdateID
    logger.info(`[BLZ] Updating network security info...`, NS);
    await this.runOperationWhileRunning(
      () =>
        this.driver.setNetworkKeyInfo(
          networkKeyInfo.nwkKey,
          networkKeyInfo.outgoingFrameCounter,
          networkKeyInfo.nwkKeySeqNum,
        ),
      generation,
    );
    await this.runOperationWhileRunning(
      () =>
        this.driver.setGlobalTcLinkKey(
          tcLinkKeyInfo.linkKey,
          tcLinkKeyInfo.outgoingFrameCounter,
        ),
      generation,
    );

    // 6. Reform network on new channel
    logger.info(`[BLZ] Reforming network on channel ${newChannel}...`, NS);
    const extPanId = BigInt(currentParams.extendedPanID);
    const formStatus = await this.runOperationWhileRunning(
      () =>
        this.driver.formNetworkWithParameters(
          extPanId,
          currentParams.panID,
          newChannel,
        ),
      generation,
    );

    if (formStatus !== BlzStatus.SUCCESS) {
      throw new Error(`[BLZ] Failed to form network on channel ${newChannel}`);
    }

    // 7. Update driver's network parameters
    this.driver.updateNetworkParametersSnapshot(newChannel, nwkUpdateId);

    // 8. Wait for network stabilization
    logger.info(`[BLZ] Waiting for network to stabilize (5s)...`, NS);
    await this.waitWhileRunning(5000, generation);

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
    profileId?: number,
  ): Promise<ZclPayload | undefined> {
    return await this.queue.execute<ZclPayload | undefined>(async () => {
      this.checkInterpanLock();
      const generation = this.stopGeneration;
      return await this.sendZclFrameToEndpointInternal(
        ieeeAddr,
        networkAddress,
        endpoint,
        sourceEndpoint ?? 1,
        zclFrame,
        timeout,
        disableResponse,
        disableRecovery,
        0,
        profileId ?? ZSpec.HA_PROFILE_ID,
        generation,
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
    profileId: number,
    generation: number,
  ): Promise<ZclPayload | undefined> {
    this.throwIfStopped(generation);
    if (ieeeAddr == null) {
      ieeeAddr = formatIeeeAddress(this.driver.getCoordinatorIeee());
    }
    logger.debug(
      `sendZclFrameToEndpointInternal ${ieeeAddr}:${networkAddress}/${endpoint} ` +
        `(responseAttempt=${responseAttempt}, queue=${this.queue.count()}), timeout=${timeout}`,
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

    const frame = this.makeZclApsFrame(
      zclFrame.cluster.ID,
      profileId,
      sourceEndpoint,
      endpoint,
      0,
    );

    let dataConfirmResult: boolean;
    try {
      this.driver.setNode(networkAddress, new BlzEUI64(ieeeAddr));
      dataConfirmResult = await this.runOperationWhileRunning(
        () => this.driver.request(networkAddress, frame, zclFrame.toBuffer()),
        generation,
      );
    } catch (error) {
      response?.cancel();
      throw error;
    }
    this.throwIfStopped(generation);

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
        this.throwIfStopped(generation);
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
            profileId,
            generation,
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
    sourceEndpoint?: number,
    profileId?: number,
  ): Promise<void> {
    return await this.queue.execute<void>(async () => {
      const generation = this.stopGeneration;
      this.checkInterpanLock();
      const frame = this.makeZclApsFrame(
        zclFrame.cluster.ID,
        profileId ?? ZSpec.HA_PROFILE_ID,
        sourceEndpoint ?? 0x01,
        0xff,
        groupID,
      );

      const sent = await this.runOperationWhileRunning(
        () => this.driver.mrequest(frame, zclFrame.toBuffer()),
        generation,
      );
      if (!sent) {
        throw new Error(`Failed to send group request`);
      }
      /**
       * As a group command is not confirmed and thus immidiately returns
       * (contrary to network address requests) we will give the
       * command some time to 'settle' in the network.
       */
      await this.waitWhileRunning(200, generation);
    });
  }

  public async sendZclFrameToAll(
    endpoint: number,
    zclFrame: Zcl.Frame,
    sourceEndpoint: number,
    destination: ZSpec.BroadcastAddress,
    profileId?: number,
  ): Promise<void> {
    return await this.queue.execute<void>(async () => {
      const generation = this.stopGeneration;
      this.checkInterpanLock();
      // Green Power is not supported by BLZ
      if (endpoint === ZSpec.GP_ENDPOINT) {
        return;
      }
      const resolvedProfileId =
        profileId ??
        (sourceEndpoint === ZSpec.GP_ENDPOINT && endpoint === ZSpec.GP_ENDPOINT
          ? ZSpec.GP_PROFILE_ID
          : ZSpec.HA_PROFILE_ID);
      const frame = this.makeZclApsFrame(
        zclFrame.cluster.ID,
        resolvedProfileId,
        sourceEndpoint,
        endpoint,
        destination,
      );

      const sent = await this.runOperationWhileRunning(
        () => this.driver.brequest(destination, frame, zclFrame.toBuffer()),
        generation,
      );
      if (!sent) {
        throw new Error(`Failed to send broadcast request`);
      }

      /**
       * As a broadcast command is not confirmed and thus immidiately returns
       * (contrary to network address requests) we will give the
       * command some time to 'settle' in the network.
       */
      await this.waitWhileRunning(200, generation);
    });
  }

  private makeZclApsFrame(
    clusterId: number,
    profileId: number,
    sourceEndpoint: number,
    destinationEndpoint: number,
    groupId: number,
  ): BlzApsFrame {
    const frame = this.driver.makeApsFrame(clusterId);
    frame.profileId = profileId;
    frame.sourceEndpoint = sourceEndpoint;
    frame.destinationEndpoint = destinationEndpoint;
    frame.groupId = groupId;

    return frame;
  }

  public async getNetworkParameters(): Promise<NetworkParameters> {
    const networkParams = this.driver.getNetworkParametersSnapshot();
    const extPanId = networkParams.extendedPanId;
    const extendedPanID =
      extPanId instanceof Buffer
        ? "0x" + extPanId.toString("hex")
        : "0x0000000000000000";

    return {
      panID: networkParams.panId,
      extendedPanID,
      channel: networkParams.Channel,
      nwkUpdateID: networkParams.nwkUpdateId,
    };
  }

  public async supportsBackup(): Promise<boolean> {
    return true;
  }

  public async backup(): Promise<Models.Backup> {
    const generation = this.stopGeneration;
    this.throwIfStopped(generation);

    assert(
      this.driver.isInitialized(),
      "Cannot make backup when blz is not initialized",
    );
    return await this.runOperationWhileRunning(
      () =>
        this.driver.createBackup(() =>
          this.throwIfStopped(generation),
        ),
      generation,
    );
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
