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
import {
  attachListenersOrRollback,
  detachListeners,
  type OwnedEventListener,
} from "../eventListeners";
import { Driver, BlzIncomingMessage } from "../driver";
import { BlzEUI64, BlzOutgoingMessageType } from "../driver/types";
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

function errorFromUnknown(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  try {
    return new Error(String(error), { cause: error });
  } catch {
    return new Error("<unprintable error>", { cause: error });
  }
}

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
  private driverStopCloseExpected = false;
  private readonly onDriverCloseHandler = this.onDriverClose.bind(this);
  private readonly onDeviceJoinedHandler = this.handleDeviceJoin.bind(this);
  private readonly onDeviceLeftHandler = this.handleDeviceLeft.bind(this);
  private readonly onIncomingMessageHandler = this.processMessage.bind(this);
  private readonly driverListenerRegistrations: readonly OwnedEventListener[] = [
    { event: "close", listener: this.onDriverCloseHandler },
    { event: "deviceJoined", listener: this.onDeviceJoinedHandler },
    { event: "deviceLeft", listener: this.onDeviceLeftHandler },
    { event: "incomingMessage", listener: this.onIncomingMessageHandler },
  ];

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

    attachListenersOrRollback(this.driver, this.driverListenerRegistrations);
    this.driverListenersAttached = true;
  }

  private detachDriverListeners(): void {
    if (!this.driverListenersAttached) {
      return;
    }

    detachListeners(this.driver, this.driverListenerRegistrations);
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
    const generation = this.stopGeneration;
    try {
      this.attachDriverListeners();
      const result = await this.runOperationWhileRunning(
        () => this.driver.startup(),
        generation,
      );
      await this.waitWhileRunning(1000, generation);
      return result;
    } catch (error) {
      const startError = errorFromUnknown(error);
      if (!this.closing) {
        this.enterStoppedState(startError);
      }
      this.detachDriverListeners();
      throw startError;
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
    const stopError = this.createAdapterStoppedError();
    this.enterStoppedState(stopError);
    this.driverStopCloseExpected = true;

    try {
      await this.driver.stop(false);
      this.detachDriverListeners();
    } catch (error) {
      throw error;
    } finally {
      this.driverStopCloseExpected = false;
    }
  }

  private onDriverClose(): void {
    logger.debug("onDriverClose()", NS);

    const emitDisconnected = !this.driverStopCloseExpected;
    const closeError = new Error("Adapter disconnected");
    this.enterStoppedState(closeError);
    this.detachDriverListeners();

    if (emitDisconnected) {
      this.emit("disconnected");
    }
  }

  private enterStoppedState(error: Error): void {
    this.closing = true;
    this.stopGeneration += 1;
    this.queue.clear(error);
    this.clearZclResponseWaiters(error);
    this.cancelRunningOperations(error);
    this.cancelStopDelay();
  }

  private throwIfStopped(generation: number): void {
    if (!this.isRunningGeneration(generation)) {
      throw this.getRunningCancellationError();
    }
  }

  private isRunningGeneration(generation: number): boolean {
    return !this.closing && generation === this.stopGeneration;
  }

  private getRunningCancellationError(): Error {
    return this.runningCancellationError ?? this.createAdapterStoppedError();
  }

  private createAdapterStoppedError(): Error {
    return new Error("Adapter stopped");
  }

  private cancelRunningOperations(error: Error): void {
    this.runningCancellationError = error;
    this.runningOperations.cancel(error);
  }

  private cancelStopDelay(): void {
    this.stopDelay.cancel();
  }

  private async runOperationWhileRunning<T>(
    operation: () => Promise<T>,
    generation: number,
  ): Promise<T> {
    return await this.runningOperations.run(
      operation,
      () => this.isRunningGeneration(generation),
      () => this.getRunningCancellationError(),
    );
  }

  private async waitWhileRunning(
    milliseconds: number,
    generation: number,
  ): Promise<void> {
    this.throwIfStopped(generation);

    const completed = await this.stopDelay.wait(
      milliseconds,
      () => this.isRunningGeneration(generation),
    );

    if (!completed) {
      throw this.getRunningCancellationError();
    }

    this.throwIfStopped(generation);
  }

  private async runQueuedWhileRunning<T>(
    operation: (generation: number) => Promise<T>,
    key?: string | number,
  ): Promise<T> {
    return await this.queue.execute<T>(async () => {
      this.checkInterpanLock();
      const generation = this.stopGeneration;
      this.throwIfStopped(generation);

      return await operation(generation);
    }, key);
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
      await this.runOperationWhileRunning(
        () => this.driver.permitJoining(seconds),
        generation,
      );

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
      await this.handleNwkUpdateRequest(networkAddress, clusterId, payload);
      return;
    }

    return await this.runQueuedWhileRunning(async (generation) => {
      const response = await this.runOperationWhileRunning(
        () =>
          this.driver.sendZdo(
            ieeeAddress,
            networkAddress,
            clusterId,
            payload,
            disableResponse,
          ),
        generation,
      );
      this.throwIfStopped(generation);

      return response as ZdoTypes.RequestToResponseMap[K] | undefined;
    }, networkAddress);
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

    await this.runQueuedWhileRunning(async (generation) => {
      await this.runOperationWhileRunning(
        () =>
          this.driver.sendZdo(
            ZSpec.BLANK_EUI64,
            networkAddress,
            clusterId,
            payload,
            true,
          ),
        generation,
      );
      this.throwIfStopped(generation);

      await this.runOperationWhileRunning(
        () =>
          this.driver.changeChannel(
            channelChange.channel,
            channelChange.nwkUpdateId,
          ),
        generation,
      );
      this.throwIfStopped(generation);
    }, networkAddress);
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
    return await this.runQueuedWhileRunning<ZclPayload | undefined>(
      async (generation) =>
        await this.sendZclFrameToEndpointInternal(
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
        ),
      networkAddress,
    );
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
      () =>
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

    let dataConfirmResult: boolean;
    try {
      dataConfirmResult = await this.runOperationWhileRunning(
        () =>
          this.driver.sendZclEndpoint(
            ieeeAddr,
            networkAddress,
            zclFrame.cluster.ID,
            profileId,
            sourceEndpoint,
            endpoint,
            zclFrame.toBuffer(),
          ),
        generation,
      );
    } catch (error) {
      this.cancelZclResponseWaiter(response);
      throw error;
    }
    this.throwIfStopped(generation);

    if (!dataConfirmResult) {
      this.cancelZclResponseWaiter(response);
      throw Error("sendZclFrameToEndpointInternal error");
    }
    if (response !== null) {
      try {
        const result = await response.start().promise;
        return result;
      } catch (error) {
        logger.debug(
          () =>
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
    return await this.runQueuedWhileRunning<void>(async (generation) => {
      const sent = await this.runOperationWhileRunning(
        () =>
          this.driver.sendZclMulticast(
            groupID,
            zclFrame.cluster.ID,
            profileId ?? ZSpec.HA_PROFILE_ID,
            sourceEndpoint ?? 0x01,
            zclFrame.toBuffer(),
          ),
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
    return await this.runQueuedWhileRunning<void>(async (generation) => {
      // Green Power is not supported by BLZ
      if (endpoint === ZSpec.GP_ENDPOINT) {
        return;
      }
      const resolvedProfileId =
        profileId ??
        (sourceEndpoint === ZSpec.GP_ENDPOINT && endpoint === ZSpec.GP_ENDPOINT
          ? ZSpec.GP_PROFILE_ID
          : ZSpec.HA_PROFILE_ID);
      const sent = await this.runOperationWhileRunning(
        () =>
          this.driver.sendZclBroadcast(
            destination,
            zclFrame.cluster.ID,
            resolvedProfileId,
            sourceEndpoint,
            endpoint,
            zclFrame.toBuffer(),
          ),
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

  private cancelZclResponseWaiter(
    waiter: ReturnType<typeof this.waitForInternal> | null,
  ): void {
    waiter?.cancel();
  }

  private clearZclResponseWaiters(error: Error): void {
    this.waitress.clear(error);
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
