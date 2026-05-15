/* istanbul ignore file */

import { EventEmitter } from "events";
import type * as Models from "../../../models";
import { Waitress } from "../../../utils";
import { logger } from "../../../utils/logger";
import * as ZSpec from "../../../zspec";
import { Clusters } from "../../../zspec/zcl/definition/cluster";
import * as Zdo from "../../../zspec/zdo";
import type {
  GenericZdoResponse,
  RequestToResponseMap,
} from "../../../zspec/zdo/definition/tstypes";
import { BLZAdapterBackup } from "../adapter/backup";
import {
  bytesEqual,
  bytesToHex,
  fixedBufferFromBytes,
  fixedBufferFromHex,
  uint64FromBigEndianBytes,
  uint64FromLittleEndianBytes,
  uint64ToBigEndianBuffer,
  uint64ToLittleEndianBuffer,
} from "../byteUtils";
import { normalizeIeeeAddress } from "../ieee";
import * as TsType from "./../../tstype";
import { ParamsDesc } from "./commands";
import { Blz, BLZFrameData } from "./blz";
import { CancellableDelay } from "./cancellableDelay";
import { CancellableOperation } from "./cancellableOperation";
import {
  BlzApsOption,
  BlzNodeType,
  BlzStatus,
  uint8_t,
  uint16_t,
  uint32_t,
  Bytes,
} from "./types";
import { BlzEUI64, BlzOutgoingMessageType, BlzValueId } from "./types/named";
import { BlzApsFrame, BlzNetworkParameters } from "./types/struct";

const NS = "zh:blz:driv";

interface AddEndpointParameters {
  endpoint?: number;
  profileId?: number;
  deviceId?: number;
  appFlags?: number;
  inputClusters?: number[];
  outputClusters?: number[];
}

type BlzFrame = {
  address: number | string;
  payload: Buffer;
  frame: BlzApsFrame;
  zdoResponse?: GenericZdoResponse;
};

type BlzWaitressMatcher = {
  address: number | string;
  clusterId: number;
};

type IeeeMfg = {
  mfgId: number;
  prefix: number[];
};

type ApsFrameOverrides = Partial<Pick<
  BlzApsFrame,
  "profileId" | "sourceEndpoint" | "destinationEndpoint" | "groupId"
>>;

function formatUnknownError(error: unknown): string {
  try {
    return String(error);
  } catch {
    return "<unprintable error>";
  }
}

function channelToMask(channel: number): number {
  return 2 ** channel;
}

function addressesMatch(
  left: number | string,
  right: number | string,
): boolean {
  if (typeof left === "string" && typeof right === "string") {
    return normalizeIeeeAddress(left) === normalizeIeeeAddress(right);
  }

  return left === right;
}

function clonePayloadWithSequence(payload: Buffer, sequence: number): Buffer {
  const requestPayload = Buffer.allocUnsafe(payload.length);
  payload.copy(requestPayload);
  requestPayload[0] = sequence;
  return requestPayload;
}

export interface BlzIncomingMessage {
  messageType: number;
  apsFrame: BlzApsFrame;
  lqi: number;
  rssi: number;
  sender: number;
  bindingIndex: number | null;
  addressIndex: number | null;
  message: Buffer;
  senderEui64?: BlzEUI64;
  zdoResponse?: GenericZdoResponse;
}

const IEEE_PREFIX_MFG_ID: IeeeMfg[] = [
  { mfgId: 0x115f, prefix: [0x04, 0xcf, 0xfc] },
  { mfgId: 0x115f, prefix: [0x54, 0xef, 0x44] },
];
const DEFAULT_MFG_ID = 0x1049;
const REQUEST_ATTEMPT_DELAYS = [500, 1000, 1500];

export class Driver extends EventEmitter {
  private blz?: Blz;
  private nwkOpt: TsType.NetworkOptions;
  private networkParams?: BlzNetworkParameters;
  //// @ts-expect-error XXX: init in startup
  private eui64ToNodeId = new Map<string, number>();
  private nodeIdToEui64 = new Map<number, BlzEUI64>();
  private ieee?: BlzEUI64;
  private waitress: Waitress<BlzFrame, BlzWaitressMatcher>;
  private resetPromise?: Promise<void>;
  private startupPromise?: Promise<TsType.StartResult>;
  private stopPromise?: Promise<void>;
  private emitCloseWhenStopCompletes = false;
  private startupCancellationError?: Error;
  private stopGeneration = 0;
  private requestGeneration = 0;
  private readonly requestOperations = new CancellableOperation();
  private readonly startupOperations = new CancellableOperation();
  private readonly resetForceOperations = new CancellableOperation();
  private readonly requestRetryDelay = new CancellableDelay();
  private readonly resetDelay = new CancellableDelay();
  private readonly startupDelay = new CancellableDelay();
  private readonly channelChangeDelay = new CancellableDelay();
  private blzCloseListener?: Blz;
  private blzRuntimeListeners?: Blz;
  private transactionID = 1;
  private readonly onBlzCloseHandler = this.onBlzClose.bind(this);
  private readonly onBlzResetHandler = this.onBlzReset.bind(this);
  private readonly handleFrameHandler = this.handleFrame.bind(this);
  private serialOpt: TsType.SerialPortOptions;
  private readonly backupMan: BLZAdapterBackup;

  constructor(
    serialOpt: TsType.SerialPortOptions,
    nwkOpt: TsType.NetworkOptions,
    backupPath: string,
  ) {
    super();
    this.nwkOpt = nwkOpt;
    this.serialOpt = serialOpt;
    this.waitress = new Waitress<BlzFrame, BlzWaitressMatcher>(
      this.waitressValidator,
      this.waitressTimeoutFormatter,
    );
    this.backupMan = new BLZAdapterBackup(
      {
        getCoordinatorVersion: () => this.getCoordinatorVersion(),
        getGlobalTcLinkKey: async () => {
          const key = await this.getGlobalTcLinkKey();

          return {
            linkKey: key.linkKey,
            outgoingFrameCounter: key.outgoingFrameCounter,
          };
        },
        getCurrentNetworkParameters: async () => {
          const params = await this.getCurrentNetworkParameters();

          return {
            panId: params.panId,
            extPanId: params.extPanId,
            channel: params.channel,
            channelMask: params.channelMask,
            nwkUpdateId: params.nwkUpdateId,
          };
        },
        getNetworkKeyInfo: async () => {
          const key = await this.getNetworkKeyInfo();

          return {
            nwkKey: key.nwkKey,
            nwkKeySeqNum: key.nwkKeySeqNum,
            outgoingFrameCounter: key.outgoingFrameCounter,
          };
        },
        getMacAddress: () => this.getMacAddress(),
      },
      backupPath,
    );
  }

  private getBlz(): Blz {
    if (!this.blz) {
      throw new Error("BLZ driver is not started");
    }

    return this.blz;
  }

  public isInitialized(): boolean {
    return this.blz?.isInitialized() ?? false;
  }

  public async createBackup(
    assertActive: () => void = () => {},
  ): Promise<Models.Backup> {
    return await this.backupMan.createBackup(assertActive);
  }

  public getCoordinatorVersion(): TsType.CoordinatorVersion {
    const version = this.getBlz().getVersionSnapshot();

    return {
      type: `BLZ v${version.product}`,
      meta: { ...version },
    };
  }

  public getNetworkParametersSnapshot(): BlzNetworkParameters {
    if (!this.networkParams) {
      throw new Error("BLZ network parameters are not available");
    }

    const snapshot = Object.assign(new BlzNetworkParameters(), this.networkParams);
    if (Buffer.isBuffer(this.networkParams.extendedPanId)) {
      snapshot.extendedPanId = fixedBufferFromBytes(
        this.networkParams.extendedPanId,
        8,
        "Network extended PAN ID must be 8 bytes.",
      );
    }

    return snapshot;
  }

  public getCoordinatorIeee(): BlzEUI64 {
    if (!this.ieee) {
      throw new Error("BLZ coordinator IEEE is not available");
    }

    return new BlzEUI64(this.ieee);
  }

  private updateNetworkParametersSnapshot(
    channel: number,
    nwkUpdateId: number,
  ): void {
    if (!this.networkParams) {
      throw new Error("BLZ network parameters are not available");
    }

    const networkParams = this.networkParams;
    networkParams.Channel = channel;
    networkParams.nwkUpdateId = nwkUpdateId;
    networkParams.channels = channelToMask(channel);
  }

  private setNetworkParametersSnapshot(netParams: BLZFrameData): BlzNetworkParameters {
    const networkParams = new BlzNetworkParameters();
    networkParams.extendedPanId = uint64ToBigEndianBuffer(netParams.extPanId);
    networkParams.panId = netParams.panId;
    networkParams.Channel = netParams.channel;
    networkParams.nwkUpdateId = netParams.nwkUpdateId;
    networkParams.channels = netParams.channelMask;
    this.networkParams = networkParams;

    return networkParams;
  }

  public async changeChannel(
    newChannel: number,
    nwkUpdateId: number,
  ): Promise<void> {
    logger.info(
      `[BLZ] Starting channel change to channel ${newChannel} with NWKUpdateID ${nwkUpdateId}`,
      NS,
    );

    const currentParams = this.getNetworkParametersSnapshot();
    if (nwkUpdateId <= currentParams.nwkUpdateId) {
      throw new Error(
        `Invalid NWKUpdateID ${nwkUpdateId} - must be greater than current ${currentParams.nwkUpdateId}`,
      );
    }

    logger.debug(`[BLZ] Current network parameters:`, NS);
    logger.debug(`[BLZ]   - PanID: 0x${currentParams.panId.toString(16)}`, NS);
    logger.debug(
      () =>
        `[BLZ]   - ExtendedPanID: 0x${bytesToHex(currentParams.extendedPanId)}`,
      NS,
    );
    logger.debug(`[BLZ]   - Channel: ${currentParams.Channel}`, NS);
    logger.debug(
      `[BLZ]   - Current NWKUpdateID: ${currentParams.nwkUpdateId}`,
      NS,
    );
    logger.debug(`[BLZ]   - New NWKUpdateID: ${nwkUpdateId}`, NS);

    const networkKeyInfo = await this.getNetworkKeyInfo();
    const tcLinkKeyInfo = await this.getGlobalTcLinkKey();

    logger.info(`[BLZ] Waiting for broadcast to propagate (15s)...`, NS);
    await this.waitForChannelChangeDelay(15000);

    logger.info(`[BLZ] Leaving current network...`, NS);
    const leaveStatus = await this.leaveNetwork();
    if (leaveStatus !== BlzStatus.SUCCESS) {
      throw new Error(
        `[BLZ] Failed to leave network with status=${leaveStatus}`,
      );
    }
    await this.waitForChannelChangeDelay(4000);

    logger.info(`[BLZ] Updating network security info...`, NS);
    await this.setNetworkKeyInfo(
      networkKeyInfo.nwkKey,
      networkKeyInfo.outgoingFrameCounter,
      networkKeyInfo.nwkKeySeqNum,
    );
    await this.setGlobalTcLinkKey(
      tcLinkKeyInfo.linkKey,
      tcLinkKeyInfo.outgoingFrameCounter,
    );

    logger.info(`[BLZ] Reforming network on channel ${newChannel}...`, NS);
    const formStatus = await this.formNetworkWithParameters(
      uint64FromBigEndianBytes(currentParams.extendedPanId),
      currentParams.panId,
      newChannel,
    );
    if (formStatus !== BlzStatus.SUCCESS) {
      throw new Error(`[BLZ] Failed to form network on channel ${newChannel}`);
    }

    this.updateNetworkParametersSnapshot(newChannel, nwkUpdateId);

    logger.info(`[BLZ] Waiting for network to stabilize (5s)...`, NS);
    await this.waitForChannelChangeDelay(5000);

    logger.info(`[BLZ] Channel change completed successfully`, NS);
  }

  /**
   * Converts BLZ hardware MAC address to IEEE EUI-64 format
   * BLZ hardware returns 8 bytes in little-endian format
   * This function converts it to proper byte order by reversing
   * @param rawMacBuffer - Raw MAC buffer from BLZ hardware
   * @returns IEEE EUI-64 formatted buffer
   */
  private convertBlzMacToIeeeEui64(rawMacBuffer: Buffer): Buffer {
    // BLZ hardware returns MAC address in little-endian format, need to reverse it
    const reversedBuffer = Buffer.allocUnsafe(rawMacBuffer.length);
    for (let i = 0; i < rawMacBuffer.length; i++) {
      reversedBuffer[i] = rawMacBuffer[rawMacBuffer.length - 1 - i];
    }
    return reversedBuffer;
  }

  /**
   * Requested by the BLZ watchdog after too many failures, or by UART layer after port closed unexpectedly.
   * Tries to stop the layers below and startup again.
   * @returns
   */
  public async reset(): Promise<void> {
    if (this.resetPromise) {
      logger.debug("Reset already in progress.", NS);
      return await this.resetPromise;
    }

    if (this.stopPromise) {
      logger.debug("Reset ignored because driver stop is in progress.", NS);
      return await this.stopPromise;
    }

    const resetPromise = this.performReset().finally(() => {
      if (this.resetPromise === resetPromise) {
        this.resetPromise = undefined;
      }
    });
    this.resetPromise = resetPromise;

    return await resetPromise;
  }

  private async performReset(): Promise<void> {
    const resetStopGeneration = this.stopGeneration;
    const resettingBlz = this.blz;
    logger.debug(`Reset connection.`, NS);
    const resetError = new Error("Driver reset");
    this.cancelDriverRequests(resetError);
    this.clearZdoResponseWaiters(resetError);
    this.cancelStartupOperations(resetError);

    try {
      // logger.debug(`Ready to reset in 10 seconds`, NS);
      // await wait(10000);
      if (resettingBlz) {
        await this.resetForceOperations.run(
          () => resettingBlz.forceReset({ holdResetState: true }),
          () => this.isResetGenerationActive(resetStopGeneration),
          () => this.createDriverStoppedError(),
        );
      }

      if (await this.waitForResetDelay(2000, resetStopGeneration)) {
        // don't emit 'close' on stop since we don't want this to bubble back up as 'disconnected' to the controller.
        await this.stop(false, true);
      }
    } catch (err) {
      logger.debug(() => `Stop error ${err}`, NS);
    }
    try {
      if (!this.isResetGenerationActive(resetStopGeneration)) {
        logger.debug("Reset cancelled by stop.", NS);
        return;
      }

      if (!(await this.waitForResetDelay(1000, resetStopGeneration))) {
        return;
      }

      logger.debug(`Startup again.`, NS);
      await this.startup();
    } catch (err) {
      logger.debug(() => `Reset error ${err}`, NS);
      // Clear reset state on error

      try {
        // here we let emit
        await this.stop();
      } catch (stopErr) {
        logger.debug(
          () => `Failed to stop after failed reset ${stopErr}`,
          NS,
        );
      }
    }
  }

  private onBlzReset(): void {
    logger.debug("onBlzReset()", NS);
    void this.reset().catch((error) => {
      logger.error(() => `BLZ reset recovery failed: ${error}`, NS);
    });
  }

  private onBlzClose(): void {
    logger.debug("onBlzClose()", NS);
    const closeError = new Error("Driver closed");
    this.cancelDriverRequests(closeError);
    this.cancelDriverLifecycle(closeError);
    if (this.blz) {
      this.detachBlzListeners(this.blz);
      this.blz = undefined;
    }
    this.enterStoppedState(closeError, true);
  }

  public async stop(
    emitClose: boolean = true,
    internalReset: boolean = false,
  ): Promise<void> {
    if (emitClose) {
      this.emitCloseWhenStopCompletes = true;
    }

    this.prepareStop(internalReset);

    if (this.stopPromise) {
      logger.debug("Driver stop already in progress.", NS);
      return await this.stopPromise;
    }

    const stopPromise = this.performStop(emitClose).finally(() => {
      if (this.stopPromise === stopPromise) {
        this.stopPromise = undefined;
        this.emitCloseWhenStopCompletes = false;
      }
    });
    this.stopPromise = stopPromise;

    return await stopPromise;
  }

  private prepareStop(internalReset: boolean): void {
    logger.debug("Stopping driver", NS);
    const stopError = this.createDriverStoppedError();
    this.cancelDriverRequests(stopError);
    if (!internalReset) {
      this.cancelDriverLifecycle(stopError);
    }
  }

  private async performStop(emitClose: boolean): Promise<void> {
    const stopError = this.createDriverStoppedError();

    try {
      if (this.blz) {
        const blz = this.blz;
        try {
          this.detachBlzListeners(blz);
          await blz.close(emitClose);
        } finally {
          if (this.blz === blz) {
            this.blz = undefined;
          }
        }
      }
    } finally {
      // Clear pending waiters to avoid dangling promises/timers even if close fails.
      this.enterStoppedState(stopError, this.emitCloseWhenStopCompletes);
    }
  }

  private enterStoppedState(error: Error, emitClose: boolean): void {
    this.clearZdoResponseWaiters(error);
    this.clearCoordinatorAndNetworkState();
    if (emitClose) {
      this.emit("close");
    }
  }

  private attachBlzCloseListener(blz: Blz): void {
    if (this.blzCloseListener === blz) {
      return;
    }

    if (this.blzCloseListener) {
      this.detachBlzCloseListener(this.blzCloseListener);
    }

    blz.on("close", this.onBlzCloseHandler);
    this.blzCloseListener = blz;
  }

  private attachBlzRuntimeListeners(blz: Blz): void {
    if (this.blzRuntimeListeners === blz) {
      return;
    }

    if (this.blzRuntimeListeners) {
      this.detachBlzRuntimeListeners(this.blzRuntimeListeners);
    }

    try {
      blz.on("reset", this.onBlzResetHandler);
      blz.on("frame", this.handleFrameHandler);
      this.blzRuntimeListeners = blz;
    } catch (error) {
      blz.off("reset", this.onBlzResetHandler);
      blz.off("frame", this.handleFrameHandler);
      throw error;
    }
  }

  private detachBlzCloseListener(blz: Blz): void {
    if (this.blzCloseListener !== blz) {
      return;
    }

    blz.off("close", this.onBlzCloseHandler);
    this.blzCloseListener = undefined;
  }

  private detachBlzRuntimeListeners(blz: Blz): void {
    if (this.blzRuntimeListeners !== blz) {
      return;
    }

    blz.off("reset", this.onBlzResetHandler);
    blz.off("frame", this.handleFrameHandler);
    this.blzRuntimeListeners = undefined;
  }

  private detachBlzListeners(blz: Blz): void {
    this.detachBlzCloseListener(blz);
    this.detachBlzRuntimeListeners(blz);
  }

  public async startup(): Promise<TsType.StartResult> {
    if (this.startupPromise) {
      logger.debug("Startup already in progress.", NS);
      return await this.startupPromise;
    }

    const startupPromise = this.performStartup().finally(() => {
      if (this.startupPromise === startupPromise) {
        this.startupPromise = undefined;
        this.startupCancellationError = undefined;
      }
    });
    this.startupPromise = startupPromise;

    return await startupPromise;
  }

  private async performStartup(): Promise<TsType.StartResult> {
    let result: TsType.StartResult = "resumed";
    this.transactionID = 1;
    this.startupCancellationError = undefined;

    if (this.blz) {
      await this.stop(false);
    }
    const startupStopGeneration = this.stopGeneration;

    const blz = new Blz();
    this.blz = blz;

    try {
      this.attachBlzCloseListener(blz);

      try {
        await this.runStartupOperation(
          () => blz.connect(this.serialOpt),
          startupStopGeneration,
        );
      } catch (error) {
        logger.debug(() => `BLZ could not connect: ${error}`, NS);
        throw error;
      }
      this.throwIfStartupCancelled(startupStopGeneration);

      await this.runStartupOperation(
        () => blz.forceReset(),
        startupStopGeneration,
      );
      await this.waitForStartupDelay(2000, startupStopGeneration);

      await this.runStartupOperation(
        () =>
          this.addEndpoint({
            inputClusters: [0x0000, 0x0003, 0x0006, 0x000a, 0x0019, 0x001a],
            outputClusters: [
              0x0000, 0x0003, 0x0004, 0x0005, 0x0006, 0x0008, 0x0020, 0x0300,
              0x0400,
            ],
          }),
        startupStopGeneration,
      );

      await this.runStartupOperation(
        () => blz.getVersion(),
        startupStopGeneration,
      );

      if (await this.needsToBeInitialised(this.nwkOpt, startupStopGeneration)) {
        logger.info("The network setup need to be initialized", NS);
        await this.waitForStartupDelay(1000, startupStopGeneration);
        const restore = await this.runStartupOperation(
          () => this.needsToBeRestore(this.nwkOpt),
          startupStopGeneration,
        );

        logger.info(`Leaving the current network`, NS);

        const st = await this.runStartupOperation(
          () => blz.leaveNetwork(),
          startupStopGeneration,
        );

        if (st != BlzStatus.SUCCESS) {
          logger.error(`leaveNetwork returned unexpected status: ${st}`, NS);
        }

        await this.waitForStartupDelay(1000, startupStopGeneration);
        logger.info(`Left the current network`, NS);

        if (restore) {
          logger.info("Restore network from backup", NS);
          await this.formNetwork(true, startupStopGeneration);
          result = "restored";
        } else {
          logger.info("Form a new network", NS);
          await this.formNetwork(false, startupStopGeneration);
          result = "reset";
        }
      }
      await this.waitForStartupDelay(1000, startupStopGeneration);
      logger.info("The Zigbee network is formed", NS);

      const netParams = await this.runCheckedStartupCommand(
        "getNetworkParameters",
        undefined,
        startupStopGeneration,
        "Command (getNetworkParameters) returned unexpected state",
        "getNetworkParameters failed",
      );
      logger.info(`PanId: ${netParams.panId.toString(16)}`, NS);
      logger.info(`extendedPanId: ${netParams.extPanId.toString(16)}`, NS);
      const networkParams = this.setNetworkParametersSnapshot(netParams);
      logger.debug(
        () =>
          `Node type: ${netParams.nodeType}, Network parameters: ${networkParams}`,
        NS,
      );

      const ieee = (
        await this.runCheckedStartupCommand(
          "getValue",
          {
            valueId: BlzValueId.BLZ_VALUE_ID_MAC_ADDRESS,
          },
          startupStopGeneration,
          "Command (getValue) returned unexpected state",
          "getValue failed",
        )
      ).value;
      // Convert BLZ hardware MAC format to IEEE EUI-64 standard format
      const ieeeEui64 = this.convertBlzMacToIeeeEui64(ieee);
      this.ieee = new BlzEUI64(ieeeEui64);
      this.attachBlzRuntimeListeners(blz);
      logger.debug(() => `BLZ nodeid=0x0000, IEEE=0x${this.ieee}`, NS);
      logger.debug("Network ready", NS);

      return result;
    } catch (error) {
      await this.cleanupFailedStartup(error);
      throw error;
    }
  }

  private async cleanupFailedStartup(error: unknown): Promise<void> {
    logger.debug(
      () => `Startup failed, cleaning up BLZ resources: ${error}`,
      NS,
    );
    const resetCancelledStartup =
      error === this.startupCancellationError &&
      error instanceof Error &&
      error.message === "Driver reset";

    try {
      await this.stop(false, resetCancelledStartup);
    } catch (stopError) {
      logger.debug(
        () => `Failed to stop after failed startup ${stopError}`,
        NS,
      );
    }
  }

  private async needsToBeInitialised(
    options: TsType.NetworkOptions,
    startupStopGeneration: number,
  ): Promise<boolean> {
    const blz = this.getBlz();
    const stackUp = await this.runStartupOperation(
      () => blz.networkInit(),
      startupStopGeneration,
    );
    logger.debug(`needToBeInitialized success stack up: ${stackUp}`, NS);
    if (!stackUp) {
      return true;
    }

    const netParams = await this.runStartupOperation(
      () => blz.execCommand("getNetworkParameters"),
      startupStopGeneration,
    );
    logger.debug(
      () =>
        `Current Node type: ${netParams.nodeType}, Network parameters: ${netParams}`,
      NS,
    );
    const gotParameters = netParams.status === BlzStatus.SUCCESS;
    logger.debug(
      `needToBeInitialized success get parameters: ${gotParameters}`,
      NS,
    );
    if (!gotParameters) {
      return true;
    }

    const isCoordinator = netParams.nodeType === BlzNodeType.COORDINATOR;
    logger.debug(`needToBeInitialized is coordinator: ${isCoordinator}`, NS);
    if (!isCoordinator) {
      return true;
    }

    const samePanId = options.panID === netParams.panId;
    logger.debug(`needToBeInitialized same PanID: ${samePanId}`, NS);
    if (!samePanId) {
      return true;
    }

    // valid = valid && options.channelList.includes(netParams.channel);
    // // try to add support for change channel so if only channel is different, it can still work as resumed
    logger.debug(
      `needToBeInitialized valid channel (optional, can be false): ${options.channelList.includes(netParams.channel)}`,
      NS,
    );

    if (netParams.extPanId === undefined) {
      logger.debug("needToBeInitialized missing extended PanID", NS);
      return true;
    }

    const extPanIdBytes = uint64ToLittleEndianBuffer(netParams.extPanId);
    const sameExtendedPanId = bytesEqual(options.extendedPanID!, extPanIdBytes);
    logger.debug(
      () => `options.extendedPanID: ${bytesToHex(options.extendedPanID!)}`,
      NS,
    );
    logger.debug(
      () => `current extendedPanID: ${bytesToHex(extPanIdBytes)}`,
      NS,
    );
    logger.debug(
      `needToBeInitialized same extended PanID: ${sameExtendedPanId}`,
      NS,
    );
    return !sameExtendedPanId;
  }

  private async formNetwork(
    restore: boolean,
    startupStopGeneration?: number,
  ): Promise<void> {
    const blz = this.getBlz();
    let backup;
    if (restore) {
      backup = await this.runMaybeStartupOperation(
        () => this.backupMan.getStoredBackup(),
        startupStopGeneration,
      );

      if (!backup) {
        throw new Error(`No valid backup found.`);
      }
      const { sequenceNumber, frameCounter } = backup.networkKeyInfo;
      let networkKey = backup.networkOptions.networkKey;
      // Convert hex string to Buffer if needed
      if (typeof networkKey === "string") {
        networkKey = fixedBufferFromHex(
          networkKey,
          16,
          "Network key must be 16 bytes.",
          "Network key must contain only hexadecimal characters.",
        );
      }
      // can only change network key and link key when the stack is on and leave the current network
      await this.runMaybeStartupOperation(
        () => this.setNetworkKeyInfo(networkKey, frameCounter, sequenceNumber),
        startupStopGeneration,
      );
      // await this.setGlobalTcLinkKey(backup.blz!.tclk!, backup.blz!.tclkFrameCounter!);
    } else {
      if (this.nwkOpt.networkKey) {
        const networkKey = fixedBufferFromBytes(
          this.nwkOpt.networkKey,
          16,
          "Network key must be 16 bytes.",
        );
        await this.runMaybeStartupOperation(
          () => this.setNetworkKeyInfo(networkKey, 0, 0),
          startupStopGeneration,
        );
      }
    }

    let formStatus: BlzStatus;
    if (restore) {
      const backupextendedPanID = uint64FromLittleEndianBytes(
        backup!.networkOptions.extendedPanId,
      );
      formStatus = await this.runMaybeStartupOperation(
        () =>
          blz.formNetwork(
            backupextendedPanID,
            backup!.networkOptions.panId,
            backup!.logicalChannel,
          ),
        startupStopGeneration,
      );
    } else {
      const nwkoptextendedPanID = uint64FromLittleEndianBytes(
        this.nwkOpt.extendedPanID!,
      );
      formStatus = await this.runMaybeStartupOperation(
        () =>
          blz.formNetwork(
            nwkoptextendedPanID,
            this.nwkOpt.panID,
            this.nwkOpt.channelList[0],
          ),
        startupStopGeneration,
      );
    }

    if (formStatus !== BlzStatus.SUCCESS) {
      throw new Error(`Failed to form network: status ${formStatus}`);
    }

    this.clearNetworkState();
  }

  private async runMaybeStartupOperation<T>(
    operation: () => Promise<T>,
    startupStopGeneration?: number,
  ): Promise<T> {
    if (startupStopGeneration === undefined) {
      return await operation();
    }

    return await this.runStartupOperation(operation, startupStopGeneration);
  }

  private handleFrame(frameName: string, frame: BLZFrameData): void {
    switch (frameName) {
      case "apsDataIndication": {
        this.handleApsDataIndication(frame);
        break;
      }
      case "deviceJoinCallback": {
        // NCP sends both join and leave through the same frame ID (0x0036).
        // status=0x00: UNSECURED_JOIN, status=0x01: REJOIN, status=0x03: LEAVE
        if (frame.status === 0x03) {
          const ieeeAddr = `0x${frame.eui64.toString(16).padStart(16, "0")}`;
          logger.debug(
            `Device left callback received: nwk=0x${frame.nodeId.toString(16)} ieee=${ieeeAddr}`,
            NS,
          );
          this.handleNodeLeft(frame.nodeId, ieeeAddr);
        } else {
          logger.debug(
            `Device joined callback received: status=${frame.status}`,
            NS,
          );
          this.handleNodeJoined(frame.nodeId, frame.eui64);
        }
        break;
      }
      case "nwkStatusCallback": {
        logger.debug(`Network status callback called is received`, NS);
        this.handleNetworkStatus(frame.status);
        break;
      }
      case "apsDataConfirm": {
        if (frame.status === BlzStatus.SUCCESS) {
          logger.debug(`APS confirmed`, NS);
        } else {
          logger.warning(`APS Request failed`, NS);
        }
        break;
      }
      case "stackStatusHandler": {
        if (frame.status === BlzStatus.SUCCESS) {
          logger.debug(`Stack status is success`, NS);
        } else {
          logger.warning(`Stack status failed`, NS);
        }
        break;
      }
      default:
        logger.debug(`Unhandled frame ${frameName}`, NS);
    }
  }

  private makeIncomingApsFrame(frame: BLZFrameData): BlzApsFrame {
    const apsFrame = new BlzApsFrame();
    apsFrame.profileId = frame.profileId;
    apsFrame.clusterId = frame.clusterId;
    apsFrame.sourceEndpoint = frame.srcEp;
    apsFrame.destinationEndpoint = frame.dstEp;
    apsFrame.sequence = 0;
    apsFrame.groupId = frame.dstShortAddr;
    return apsFrame;
  }

  private emitIncomingApsMessage(
    frame: BLZFrameData,
    apsFrame: BlzApsFrame,
    options?: { zdoResponse?: GenericZdoResponse },
  ): void {
    const message: BlzIncomingMessage = {
      messageType: frame.msgType,
      apsFrame,
      lqi: frame.lqi,
      rssi: frame.rssi,
      sender: frame.srcShortAddr,
      bindingIndex: null,
      addressIndex: null,
      message: frame.message,
      senderEui64: this.getCachedEui64(frame.srcShortAddr),
    };

    if (options) {
      message.zdoResponse = options.zdoResponse;
    }

    this.emit("incomingMessage", message);
  }

  private handleApsDataIndication(frame: BLZFrameData): void {
    const apsFrame = this.makeIncomingApsFrame(frame);

    if (
      frame.profileId == Zdo.ZDO_PROFILE_ID &&
      frame.clusterId >= 0x8000 /* response only */
    ) {
      let zdoResponse: GenericZdoResponse | undefined;
      try {
        zdoResponse = Zdo.Buffalo.readResponse(
          true,
          frame.clusterId,
          frame.message,
        );
      } catch (error) {
        logger.error(
          () =>
            `Failed to parse ZDO response 0x${frame.clusterId.toString(16)}: ${formatUnknownError(error)}`,
          NS,
        );
      }

      if (zdoResponse) {
        if (frame.clusterId === Zdo.ClusterId.NETWORK_ADDRESS_RESPONSE) {
          // special case to properly resolve a NETWORK_ADDRESS_RESPONSE following a NETWORK_ADDRESS_REQUEST (based on EUI64 from ZDO payload)
          // NOTE: if response has invalid status (no EUI64 available), response waiter will eventually time out
          /* istanbul ignore else */
          if (
            Zdo.Buffalo.checkStatus<Zdo.ClusterId.NETWORK_ADDRESS_RESPONSE>(
              zdoResponse,
            )
          ) {
            const eui64 = zdoResponse[1].eui64;

            // update cache with new network address
            this.cacheNodeIeee(frame.srcShortAddr, eui64);

            this.waitress.resolve({
              address: eui64,
              payload: frame.message,
              frame: apsFrame,
              zdoResponse,
            });
          }
        } else {
          this.waitress.resolve({
            address: frame.srcShortAddr,
            payload: frame.message,
            frame: apsFrame,
            zdoResponse,
          });
        }
      }

      // always pass ZDO to bubble up to controller
      this.emitIncomingApsMessage(frame, apsFrame, { zdoResponse });
      return;
    }

    const handled = this.waitress.resolve({
      address: frame.srcShortAddr,
      payload: frame.message,
      frame: apsFrame,
    });

    if (!handled) {
      this.emitIncomingApsMessage(frame, apsFrame);
    }
  }

  private handleNetworkStatus(status: BlzStatus): void {
    logger.debug(`handleNetworkStatus: networkStatusCode=${status}`, NS);
  }

  private cacheNodeIeee(
    nwk: number,
    ieee: BlzEUI64 | ArrayLike<number> | string | number | bigint,
  ): BlzEUI64 {
    const eui64 =
      ieee instanceof BlzEUI64
        ? new BlzEUI64(ieee)
        : new BlzEUI64(
            typeof ieee === "number" || typeof ieee === "bigint"
              ? ieee.toString(16).padStart(16, "0")
              : ieee,
          );
    const normalized = normalizeIeeeAddress(eui64);
    const previousEui64 = this.nodeIdToEui64.get(nwk);
    const previousNwk = this.eui64ToNodeId.get(normalized);

    if (previousEui64) {
      this.eui64ToNodeId.delete(normalizeIeeeAddress(previousEui64));
    }

    if (previousNwk !== undefined && previousNwk !== nwk) {
      this.nodeIdToEui64.delete(previousNwk);
    }

    this.eui64ToNodeId.set(normalized, nwk);
    this.nodeIdToEui64.set(nwk, eui64);

    return new BlzEUI64(eui64);
  }

  private getCachedEui64(nwk: number): BlzEUI64 | undefined {
    const eui64 = this.nodeIdToEui64.get(nwk);
    return eui64 ? new BlzEUI64(eui64) : undefined;
  }

  private clearAddressCache(): void {
    this.eui64ToNodeId.clear();
    this.nodeIdToEui64.clear();
  }

  private clearNetworkState(): void {
    this.networkParams = undefined;
    this.clearAddressCache();
  }

  private clearCoordinatorAndNetworkState(): void {
    this.ieee = undefined;
    this.clearNetworkState();
  }

  private removeCachedNode(nwk: number, ieeeAddr: string): void {
    const cachedEui64 = this.nodeIdToEui64.get(nwk);
    if (cachedEui64) {
      this.eui64ToNodeId.delete(normalizeIeeeAddress(cachedEui64));
    }

    this.nodeIdToEui64.delete(nwk);
    this.eui64ToNodeId.delete(normalizeIeeeAddress(ieeeAddr));
  }

  private handleNodeJoined(nwk: number, ieee: number | bigint): void {
    const eui64 = this.cacheNodeIeee(nwk, ieee);
    const ieeeAddrFull = `0x${eui64.toString()}`;
    logger.debug(`deviceJoined, 0x${nwk.toString(16)}, ${ieeeAddrFull}`, NS);
    this.emit("deviceJoined", nwk, ieeeAddrFull);
  }

  private handleNodeLeft(nwk: number, ieeeAddr: string): void {
    this.removeCachedNode(nwk, ieeeAddr);
    logger.debug(`deviceLeft, 0x${nwk.toString(16)}, ${ieeeAddr}`, NS);
    this.emit("deviceLeft", nwk, ieeeAddr);
  }

  private async request(
    nwk: number | BlzEUI64,
    apsFrame: BlzApsFrame,
    data: Buffer,
  ): Promise<boolean> {
    const requestGeneration = this.requestGeneration;

    for (let attempt = 0; attempt < REQUEST_ATTEMPT_DELAYS.length; attempt++) {
      if (this.isRequestCancelled(requestGeneration)) {
        return false;
      }

      try {
        let resolvedNwk: number;

        if (typeof nwk !== "number") {
          const eui64 = nwk as BlzEUI64;
          const strEui64 = eui64.toString();
          let nodeId = this.eui64ToNodeId.get(normalizeIeeeAddress(strEui64));

          if (nodeId === undefined) {
            nodeId = (
              await this.runRequestOperation(
                () =>
                  this.getBlz().execCommand("getNodeIdByEui64", {
                    eui64: eui64,
                  }),
                requestGeneration,
              )
            ).nodeId;
            if (nodeId !== undefined && nodeId !== 0xffff) {
              this.cacheNodeIeee(nodeId, eui64);
            } else {
              throw new Error("Unknown EUI64:" + strEui64);
            }
          }
          resolvedNwk = nodeId;
        } else {
          resolvedNwk = nwk;
        }

        const sendResult = await this.runRequestOperation(
          () =>
            this.sendApsData(
              BlzOutgoingMessageType.BLZ_MSG_TYPE_UNICAST,
              resolvedNwk,
              apsFrame,
              data,
            ),
          requestGeneration,
        );

        if (sendResult === BlzStatus.SUCCESS) {
          return true;
        }

        logger.debug(
          `Request attempt ${attempt + 1}/${REQUEST_ATTEMPT_DELAYS.length} failed with status=${sendResult}`,
          NS,
        );
      } catch (e) {
        logger.debug(
          () => `Request attempt ${attempt + 1}/${REQUEST_ATTEMPT_DELAYS.length} error: ${e}`,
          NS,
        );
      }

      if (this.isRequestCancelled(requestGeneration)) {
        return false;
      }

      // Wait before retrying (unless this was the last attempt)
      if (attempt < REQUEST_ATTEMPT_DELAYS.length - 1) {
        const continueRetry = await this.waitForRequestRetry(
          REQUEST_ATTEMPT_DELAYS[attempt],
          requestGeneration,
        );

        if (!continueRetry) {
          return false;
        }
      }
    }

    return false;
  }

  private isRequestCancelled(requestGeneration: number): boolean {
    return !this.isRequestGenerationActive(requestGeneration);
  }

  private isRequestGenerationActive(requestGeneration: number): boolean {
    return this.requestGeneration === requestGeneration && this.blz !== undefined;
  }

  private cancelDriverRequests(error: Error): void {
    this.requestGeneration += 1;
    this.cancelRequestOperations(error);
    this.cancelRequestDelays();
  }

  private cancelRequestDelays(): void {
    this.requestRetryDelay.cancel();
    this.channelChangeDelay.cancel();
  }

  private cancelDriverLifecycle(error: Error): void {
    this.stopGeneration += 1;
    this.cancelResetRecovery(error);
    this.cancelStartupOperations(error);
  }

  private cancelResetRecovery(error: Error): void {
    this.resetDelay.cancel();
    this.resetForceOperations.cancel(error);
  }

  private cancelRequestOperations(error: Error): void {
    this.requestOperations.cancel(error);
  }

  private async runRequestOperation<T>(
    operation: () => Promise<T>,
    requestGeneration: number,
  ): Promise<T> {
    return await this.requestOperations.run(
      operation,
      () => this.isRequestGenerationActive(requestGeneration),
      () => this.createDriverStoppedError(),
    );
  }

  private async runBlzCommandOperation<T>(
    operation: (blz: Blz) => Promise<T>,
  ): Promise<T> {
    const blz = this.getBlz();
    const requestGeneration = this.requestGeneration;

    return await this.runRequestOperation(
      () => operation(blz),
      requestGeneration,
    );
  }

  private async waitForRequestRetry(
    milliseconds: number,
    requestGeneration: number,
  ): Promise<boolean> {
    return await this.requestRetryDelay.wait(
      milliseconds,
      () => this.isRequestGenerationActive(requestGeneration),
    );
  }

  private async waitForChannelChangeDelay(milliseconds: number): Promise<void> {
    const requestGeneration = this.requestGeneration;
    const completed = await this.channelChangeDelay.wait(
      milliseconds,
      () => this.isRequestGenerationActive(requestGeneration),
    );

    if (!completed) {
      throw this.createDriverStoppedError();
    }
  }

  private async waitForResetDelay(
    milliseconds: number,
    resetStopGeneration: number,
  ): Promise<boolean> {
    if (!this.isResetGenerationActive(resetStopGeneration)) {
      logger.debug("Reset cancelled by stop.", NS);
      return false;
    }

    const stillActive = await this.resetDelay.wait(
      milliseconds,
      () => this.isResetGenerationActive(resetStopGeneration),
    );

    if (!stillActive) {
      logger.debug("Reset cancelled by stop.", NS);
    }

    return stillActive;
  }

  private isResetGenerationActive(resetStopGeneration: number): boolean {
    return this.stopGeneration === resetStopGeneration;
  }

  private throwIfStartupCancelled(startupStopGeneration: number): void {
    if (!this.isStartupGenerationActive(startupStopGeneration)) {
      throw this.getStartupCancellationError();
    }
  }

  private isStartupGenerationActive(startupStopGeneration: number): boolean {
    return this.stopGeneration === startupStopGeneration;
  }

  private getStartupCancellationError(): Error {
    return this.startupCancellationError ?? this.createDriverStoppedError();
  }

  private createDriverStoppedError(): Error {
    return new Error("Driver stopped");
  }

  private async waitForStartupDelay(
    milliseconds: number,
    startupStopGeneration: number,
  ): Promise<void> {
    this.throwIfStartupCancelled(startupStopGeneration);

    const stillActive = await this.startupDelay.wait(
      milliseconds,
      () => this.isStartupGenerationActive(startupStopGeneration),
    );

    if (!stillActive) {
      throw this.getStartupCancellationError();
    }
  }

  private cancelStartupOperations(error: Error): void {
    this.startupCancellationError = error;
    this.cancelStartupDelay();
    this.cancelStartupRunningOperations(error);
  }

  private cancelStartupDelay(): void {
    this.startupDelay.cancel();
  }

  private cancelStartupRunningOperations(error: Error): void {
    this.startupOperations.cancel(error);
  }

  private async runStartupOperation<T>(
    operation: () => Promise<T>,
    startupStopGeneration: number,
  ): Promise<T> {
    return await this.startupOperations.run(
      operation,
      () => this.isStartupGenerationActive(startupStopGeneration),
      () => this.getStartupCancellationError(),
    );
  }

  private async runCheckedStartupCommand(
    command: string,
    params: ParamsDesc | undefined,
    startupStopGeneration: number,
    logMessage: string,
    errorMessage: string,
  ): Promise<BLZFrameData> {
    const frameResponse = await this.runStartupOperation(
      () =>
        params === undefined
          ? this.getBlz().execCommand(command)
          : this.getBlz().execCommand(command, params),
      startupStopGeneration,
    );

    logger.info(`Command (${command}) returned: ${frameResponse.status}`, NS);

    this.assertBlzStatus(
      frameResponse.status,
      logMessage,
      errorMessage,
      " with status=",
    );

    return frameResponse;
  }

  private async mrequest(
    apsFrame: BlzApsFrame,
    data: Buffer,
  ): Promise<boolean> {
    return await this.sendRoutedApsRequest(
      BlzOutgoingMessageType.BLZ_MSG_TYPE_MULTICAST,
      apsFrame.groupId ?? 0,
      apsFrame,
      data,
    );
  }

  private async brequest(
    destination: number,
    apsFrame: BlzApsFrame,
    data: Buffer,
  ): Promise<boolean> {
    return await this.sendRoutedApsRequest(
      BlzOutgoingMessageType.BLZ_MSG_TYPE_BROADCAST,
      destination,
      apsFrame,
      data,
    );
  }

  private async sendRoutedApsRequest(
    messageType: number,
    destination: number,
    apsFrame: BlzApsFrame,
    data: Buffer,
  ): Promise<boolean> {
    this.getBlz();
    const requestGeneration = this.requestGeneration;

    try {
      return await this.runRequestOperation(
        () =>
          this.sendApsDataStatus(
            messageType,
            destination,
            apsFrame,
            data,
          ),
        requestGeneration,
      );
    } catch (error) {
      if (this.isRequestCancelled(requestGeneration)) {
        return false;
      }

      throw error;
    }
  }

  public async sendZclMulticast(
    groupID: number,
    clusterId: number,
    profileId: number,
    sourceEndpoint: number,
    data: Buffer,
  ): Promise<boolean> {
    const frame = this.makeApsFrame(clusterId, {
      profileId,
      sourceEndpoint,
      destinationEndpoint: 0xff,
      groupId: groupID,
    });

    return await this.mrequest(frame, data);
  }

  public async sendZclBroadcast(
    destination: ZSpec.BroadcastAddress,
    clusterId: number,
    profileId: number,
    sourceEndpoint: number,
    destinationEndpoint: number,
    data: Buffer,
  ): Promise<boolean> {
    const frame = this.makeApsFrame(clusterId, {
      profileId,
      sourceEndpoint,
      destinationEndpoint,
      groupId: destination,
    });

    return await this.brequest(destination, frame, data);
  }

  public async sendZclEndpoint(
    ieeeAddress: string,
    networkAddress: number,
    clusterId: number,
    profileId: number,
    sourceEndpoint: number,
    destinationEndpoint: number,
    data: Buffer,
  ): Promise<boolean> {
    this.cacheNodeIeee(networkAddress, new BlzEUI64(ieeeAddress));

    const frame = this.makeApsFrame(clusterId, {
      profileId,
      sourceEndpoint,
      destinationEndpoint,
      groupId: 0,
    });

    return await this.request(networkAddress, frame, data);
  }

  public async sendZdo(
    ieeeAddress: string,
    networkAddress: number,
    clusterId: Zdo.ClusterId,
    payload: Buffer,
    disableResponse: true,
  ): Promise<void>;
  public async sendZdo<K extends keyof RequestToResponseMap>(
    ieeeAddress: string,
    networkAddress: number,
    clusterId: K,
    payload: Buffer,
    disableResponse: false,
  ): Promise<RequestToResponseMap[K]>;
  public async sendZdo<K extends keyof RequestToResponseMap>(
    ieeeAddress: string,
    networkAddress: number,
    clusterId: K | Zdo.ClusterId,
    payload: Buffer,
    disableResponse: boolean,
  ): Promise<RequestToResponseMap[K] | undefined>;
  public async sendZdo<K extends keyof RequestToResponseMap>(
    ieeeAddress: string,
    networkAddress: number,
    clusterId: K | Zdo.ClusterId,
    payload: Buffer,
    disableResponse: boolean,
  ): Promise<RequestToResponseMap[K] | undefined> {
    const requestGeneration = this.requestGeneration;
    const clusterName = Zdo.ClusterId[clusterId];
    const frame = this.makeApsFrame(clusterId);
    const requestPayload = clonePayloadWithSequence(payload, frame.sequence);
    let waiter: ReturnType<typeof this.waitFor> | undefined;
    let responseClusterId: number | undefined;

    if (!disableResponse) {
      responseClusterId = Zdo.Utils.getResponseClusterId(clusterId);

      if (responseClusterId) {
        waiter = this.waitFor(
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
      requestGeneration,
    );

    if (clusterId === Zdo.ClusterId.LEAVE_REQUEST) {
      logger.info(
        `[BLZ] LEAVE_REQUEST sent to ${ieeeAddress}:${networkAddress}, emitting deviceLeave`,
        NS,
      );
      this.handleNodeLeft(networkAddress, ieeeAddress);
    }

    if (waiter && responseClusterId !== undefined) {
      const response = await waiter.start().promise;

      logger.debug(
        () =>
          `<~~ [ZDO ${Zdo.ClusterId[responseClusterId]} ${JSON.stringify(response.zdoResponse!)}]`,
        NS,
      );

      return response.zdoResponse! as RequestToResponseMap[K];
    }
  }

  private async sendZdoFrame(
    ieeeAddress: string,
    networkAddress: number,
    clusterName: string,
    frame: BlzApsFrame,
    payload: Buffer,
    waiter: { cancel: () => void } | undefined,
    requestGeneration: number,
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
      const req = await (isBroadcast
        ? this.brequest(networkAddress, frame, payload)
        : this.request(networkAddress, frame, payload));

      if (this.isRequestCancelled(requestGeneration)) {
        throw this.createDriverStoppedError();
      }

      logger.debug(`~~~> [SENT ZDO ${isBroadcast ? "BROADCAST" : "UNICAST"}]`, NS);

      if (!req) {
        throw new Error(`~x~> [ZDO ${clusterName} ${route}] Failed to send request.`);
      }
    } catch (error) {
      this.cancelZdoResponseWaiter(waiter);

      if (this.isRequestCancelled(requestGeneration)) {
        throw this.createDriverStoppedError();
      }

      throw error;
    }
  }

  private async sendApsDataStatus(
    messageType: number,
    destination: number,
    apsFrame: BlzApsFrame,
    data: Buffer,
  ): Promise<boolean> {
    try {
      return (
        (await this.sendApsData(messageType, destination, apsFrame, data)) ===
        BlzStatus.SUCCESS
      );
    } catch {
      return false;
    }
  }

  private async sendApsData(
    messageType: number,
    destination: number,
    apsFrame: BlzApsFrame,
    data: Buffer,
  ): Promise<BlzStatus> {
    const seq = (apsFrame.sequence + 1) & 0xff;

    return await this.getBlz().sendApsData(
      messageType,
      destination,
      apsFrame.profileId,
      apsFrame.clusterId,
      apsFrame.sourceEndpoint,
      apsFrame.destinationEndpoint,
      0,
      5,
      seq,
      data.length,
      data,
    );
  }

  private nextTransactionID(): number {
    this.transactionID = (this.transactionID + 1) & 0xff;
    return this.transactionID;
  }

  private makeApsFrame(
    clusterId: number,
    overrides: ApsFrameOverrides = {},
  ): BlzApsFrame {
    const frame = new BlzApsFrame();
    frame.clusterId = clusterId;
    frame.profileId = overrides.profileId ?? 0;
    frame.sequence = this.nextTransactionID();
    frame.sourceEndpoint = overrides.sourceEndpoint ?? 0;
    frame.destinationEndpoint = overrides.destinationEndpoint ?? 0;
    frame.groupId = overrides.groupId ?? 0;
    return frame;
  }

  private async networkIdToEUI64(nwk: number): Promise<BlzEUI64> {
    const cached = this.getCachedEui64(nwk);

    if (cached) {
      return cached;
    }

    for (const [eui64Str, nodeId] of this.eui64ToNodeId) {
      if (nodeId === nwk) {
        return this.cacheNodeIeee(nwk, eui64Str);
      }
    }

    const blz = this.getBlz();
    const requestGeneration = this.requestGeneration;
    const response = await this.runRequestOperation(
      () =>
        blz.execCommand("getEui64ByNodeId", {
          nodeId: nwk,
        }),
      requestGeneration,
    );

    if (response.status === BlzStatus.SUCCESS) {
      return this.cacheNodeIeee(nwk, response.eui64);
    } else {
      throw new Error("Unrecognized nodeId:" + nwk);
    }
  }

  public async permitJoining(seconds: number): Promise<void> {
    await this.runCheckedBlzCommand(
      "permitJoining",
      {
        duration: seconds,
      },
      "permitJoining() returned unexpected BLZ status",
      "Failed to permit joining",
    );
  }

  private async leaveNetwork(): Promise<BlzStatus> {
    return await this.runBlzCommandOperation((blz) => blz.leaveNetwork());
  }

  private async formNetworkWithParameters(
    extendedPanId: bigint,
    panId: number,
    channel: number,
  ): Promise<BlzStatus> {
    return await this.runBlzCommandOperation((blz) =>
      blz.formNetwork(extendedPanId, panId, channel),
    );
  }

  private async addEndpoint({
    endpoint = 1,
    profileId = 260,
    deviceId = 0xbeef,
    appFlags = 0,
    inputClusters = [],
    outputClusters = [],
  }: AddEndpointParameters): Promise<void> {
    const res = await this.runCheckedBlzCommand(
      "addEndpoint",
      {
        endpoint: endpoint,
        profileId: profileId,
        deviceId: deviceId,
        appFlags: appFlags,
        inputClusterCount: inputClusters.length,
        outputClusterCount: outputClusters.length,
        inputClusterList: inputClusters,
        outputClusterList: outputClusters,
      },
      "addEndpoint() returned unexpected BLZ status",
      "Failed to add endpoint",
    );
    logger.debug(() => `Blz adding endpoint: ${JSON.stringify(res)}`, NS);
  }

  private waitFor(
    address: number | string,
    clusterId: number,
    timeout = 10000,
  ): ReturnType<typeof this.waitress.waitFor> & { cancel: () => void } {
    const waiter = this.waitress.waitFor({ address, clusterId }, timeout);
    return { ...waiter, cancel: () => this.waitress.remove(waiter.ID) };
  }

  private cancelZdoResponseWaiter(waiter: { cancel: () => void } | undefined): void {
    waiter?.cancel();
  }

  private clearZdoResponseWaiters(error: Error): void {
    this.waitress.clear(error);
  }

  private waitressTimeoutFormatter(
    matcher: BlzWaitressMatcher,
    timeout: number,
  ): string {
    return `${JSON.stringify(matcher)} after ${timeout}ms`;
  }

  private waitressValidator(
    payload: BlzFrame,
    matcher: BlzWaitressMatcher,
  ): boolean {
    logger.debug(
      () =>
        `waitressValidator: payload.address=${payload.address}, matcher.address=${matcher.address}, payload.frame.clusterId=${payload.frame?.clusterId}, matcher.clusterId=${matcher.clusterId}`,
      NS,
    );
    return (
      addressesMatch(payload.address, matcher.address) &&
      (!payload.frame || payload.frame.clusterId === matcher.clusterId)
    );
  }

  private assertBlzStatus(
    status: BlzStatus,
    logMessage: string,
    errorMessage: string,
    statusText = ": status ",
  ): void {
    if (status !== BlzStatus.SUCCESS) {
      logger.error(`${logMessage}: ${status}`, NS);
      throw new Error(`${errorMessage}${statusText}${status}`);
    }
  }

  private async runCheckedBlzCommand(
    command: string,
    params: ParamsDesc | undefined,
    logMessage: string,
    errorMessage: string,
  ): Promise<BLZFrameData> {
    const frameResponse = await this.runBlzCommandOperation((blz) =>
      params === undefined
        ? blz.execCommand(command)
        : blz.execCommand(command, params),
    );

    this.assertBlzStatus(
      frameResponse.status,
      logMessage,
      errorMessage,
    );

    return frameResponse;
  }

  private async getGlobalTcLinkKey(): Promise<BLZFrameData> {
    const frameResponse = await this.runCheckedBlzCommand(
      "getGlobalTcLinkKey",
      undefined,
      "getGlobalTcLinkKey() returned unexpected BLZ status",
      "Failed to get global Trust Center key",
    );
    const { linkKey, outgoingFrameCounter, trustCenterAddress } = frameResponse;

    logger.debug(
      () => `Global TC Key retrieved: Key=${linkKey.toString("hex")}, FrameCounter=${outgoingFrameCounter}, TCAddress=${trustCenterAddress}`,
      NS,
    );

    return frameResponse;
  }

  private async setGlobalTcLinkKey(
    linkKey: Bytes,
    outgoingFrameCounter: uint32_t,
  ): Promise<BlzStatus> {
    const frameRequest = {
      linkKey,
      outgoingFrameCounter,
    };

    const frameResponse = await this.runCheckedBlzCommand(
      "setGlobalTcLinkKey",
      frameRequest,
      "setGlobalTcLinkKey() failed with status",
      "Failed to set global Trust Center key",
    );
    const { status } = frameResponse;

    logger.debug(
      () => `Global TC Key set successfully: Key=${linkKey}, FrameCounter=${outgoingFrameCounter}`,
      NS,
    );

    return status;
  }

  private async getNetworkKeyInfo(): Promise<BLZFrameData> {
    const frameResponse = await this.runCheckedBlzCommand(
      "getNwkSecurityInfos",
      undefined,
      "getNetworkKeyInfo() returned unexpected BLZ status",
      "Failed to get network key info",
    );
    const { nwkKey, outgoingFrameCounter, nwkKeySeqNum } = frameResponse;

    logger.debug(
      () => `Network Key Info retrieved: Key=${nwkKey.toString("hex")}, FrameCounter=${outgoingFrameCounter}, SeqNum=${nwkKeySeqNum}`,
      NS,
    );

    return frameResponse;
  }

  private async getCurrentNetworkParameters(): Promise<BLZFrameData> {
    return await this.runCheckedBlzCommand(
      "getNetworkParameters",
      undefined,
      "getCurrentNetworkParameters() returned unexpected BLZ status",
      "Failed to get network parameters",
    );
  }

  private async getMacAddress(): Promise<Buffer> {
    const frameResponse = await this.runCheckedBlzCommand(
      "getValue",
      {
        valueId: BlzValueId.BLZ_VALUE_ID_MAC_ADDRESS,
      },
      "getMacAddress() returned unexpected BLZ status",
      "Failed to get MAC address",
    );
    const { value } = frameResponse;

    return value;
  }

  private async setNetworkKeyInfo(
    nwkKey: Bytes,
    outgoingFrameCounter: uint32_t,
    nwkKeySeqNum: uint8_t,
  ): Promise<BlzStatus> {
    // Validate network key format
    if (!Buffer.isBuffer(nwkKey) || nwkKey.length !== 16) {
      throw new Error(`Invalid network key format - must be 16 byte Buffer`);
    }

    logger.debug(() => `Setting network key: ${nwkKey.toString("hex")}`, NS);
    logger.debug(`Frame counter: ${outgoingFrameCounter}`, NS);
    logger.debug(`Key seq num: ${nwkKeySeqNum}`, NS);

    const frameRequest = {
      nwkKey,
      outgoingFrameCounter,
      nwkKeySeqNum,
    };

    const frameResponse = await this.runCheckedBlzCommand(
      "setNwkSecurityInfos",
      frameRequest,
      "setNwkSecurityInfos() failed with status",
      "Failed to set network security infos",
    );
    const { status } = frameResponse;

    logger.debug(
      () => `Network Security Infos set successfully: Key=${nwkKey.toString("hex")}, FrameCounter=${outgoingFrameCounter}, SeqNum=${nwkKeySeqNum}`,
      NS,
    );

    return status;
  }

  private async needsToBeRestore(
    options: TsType.NetworkOptions,
  ): Promise<boolean> {
    const backup = await this.backupMan.getStoredBackup();
    if (!backup) {
      logger.debug("needToBeRestore no backup found!", NS);
      return false;
    }
    let valid = true;
    valid = valid && options.panID == backup.networkOptions.panId;
    logger.debug(`needsToBeRestore same PanID: ${valid}`, NS);
    valid = valid && options.channelList.includes(backup.logicalChannel);
    logger.debug(`needsToBeRestore valid channel: ${valid}`, NS);
    // Ensure both extendedPanIDs are compared with same endianness
    const currentExtendedPanID = options.extendedPanID!;
    const backupExtendedPanID = backup.networkOptions.extendedPanId;
    logger.debug(
      () => `Configured extendedPanID (raw): ${bytesToHex(currentExtendedPanID)}`,
      NS,
    );
    logger.debug(
      () => `Backup extendedPanID (raw): ${bytesToHex(backupExtendedPanID)}`,
      NS,
    );

    // Convert both to uint64 for consistent comparison
    const currentPanID = uint64FromLittleEndianBytes(currentExtendedPanID);
    const backupPanID = uint64FromLittleEndianBytes(backupExtendedPanID);
    logger.debug(
      () => `Configured extendedPanID (uint64): ${currentPanID.toString(16)}`,
      NS,
    );
    logger.debug(
      () => `Backup extendedPanID (uint64): ${backupPanID.toString(16)}`,
      NS,
    );
    valid = valid && currentPanID === backupPanID;
    logger.debug(`needsToBeRestore same extendedPanID: ${valid}`, NS);
    const currentNetworkKey = options.networkKey!;
    const backupNetworkKey = backup.networkOptions.networkKey;
    logger.debug(
      () => `Configured networkKey (raw): ${bytesToHex(currentNetworkKey)}`,
      NS,
    );
    logger.debug(
      () => `Backup networkKey (raw): ${bytesToHex(backupNetworkKey)}`,
      NS,
    );
    valid = valid && bytesEqual(currentNetworkKey, backupNetworkKey);
    logger.debug(`needsToBeRestore same network key: ${valid}`, NS);
    return valid;
  }
}
