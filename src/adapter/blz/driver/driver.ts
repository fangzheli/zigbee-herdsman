/* istanbul ignore file */

import { EventEmitter } from "events";
import equals from "fast-deep-equal/es6";
import { Waitress } from "../../../utils";
import { logger } from "../../../utils/logger";
import * as ZSpec from "../../../zspec";
import { Clusters } from "../../../zspec/zcl/definition/cluster";
import * as Zdo from "../../../zspec/zdo";
import { GenericZdoResponse } from "../../../zspec/zdo/definition/tstypes";
import { BLZAdapterBackup } from "../adapter/backup";
import * as TsType from "./../../tstype";
import { ParamsDesc } from "./commands";
import { Blz, BLZFrameData } from "./blz";
import { CancellableDelay } from "./cancellableDelay";
import { uint64_t } from "./types";
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

export interface BlzIncomingMessage {
  messageType: number;
  apsFrame: BlzApsFrame;
  lqi: number;
  rssi: number;
  sender: number;
  bindingIndex: number;
  addressIndex: number;
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
  public blz?: Blz;
  private nwkOpt: TsType.NetworkOptions;
  // @ts-expect-error XXX: init in startup
  public networkParams: BlzNetworkParameters;
  //// @ts-expect-error XXX: init in startup
  private eui64ToNodeId = new Map<string, number>();
  private nodeIdToEui64 = new Map<number, BlzEUI64>();
  // @ts-expect-error XXX: init in startup
  public ieee: BlzEUI64;
  private waitress: Waitress<BlzFrame, BlzWaitressMatcher>;
  private resetPromise?: Promise<void>;
  private startupPromise?: Promise<TsType.StartResult>;
  private cancelPendingResetForce?: (error: Error) => void;
  private cancelPendingStartupOperation?: (error: Error) => void;
  private stopGeneration = 0;
  private requestGeneration = 0;
  private readonly requestRetryDelay = new CancellableDelay();
  private readonly resetDelay = new CancellableDelay();
  private readonly startupDelay = new CancellableDelay();
  private transactionID = 1;
  private readonly onBlzCloseHandler = this.onBlzClose.bind(this);
  private readonly onBlzResetHandler = this.onBlzReset.bind(this);
  private readonly handleFrameHandler = this.handleFrame.bind(this);
  private serialOpt: TsType.SerialPortOptions;
  public backupMan: BLZAdapterBackup;

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
    this.backupMan = new BLZAdapterBackup(this, backupPath);
  }

  public getBlz(): Blz {
    if (!this.blz) {
      throw new Error("BLZ driver is not started");
    }

    return this.blz;
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
    const reversedBuffer = Buffer.from(rawMacBuffer).reverse();
    return reversedBuffer;

    // TODO: IEEE EUI-64 expansion method (commented out for now)
    // Extract the 6-byte MAC address (first 6 bytes after reversal, skip last 2 bytes which were 0x0000)
    // const macBytes = reversedBuffer.subarray(0, 6);
    //
    // // Convert 6-byte MAC to 8-byte IEEE EUI-64 by inserting FF FE after 3rd byte
    // // IEEE standard: MAC[0:3] + FF FE + MAC[3:6] -> EUI-64
    // const ieeeEui64 = Buffer.alloc(8);
    // macBytes.copy(ieeeEui64, 0, 0, 3);  // Copy first 3 bytes of MAC
    // ieeeEui64[3] = 0xFF;                 // Insert FF
    // ieeeEui64[4] = 0xFE;                 // Insert FE
    // macBytes.copy(ieeeEui64, 5, 3, 6);  // Copy last 3 bytes of MAC
    //
    // return ieeeEui64;
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
    let resetStateMarked = false;
    logger.debug(`Reset connection.`, NS);

    try {
      // logger.debug(`Ready to reset in 10 seconds`, NS);
      // await wait(10000);
      if (resettingBlz) {
        resettingBlz.setResetingProcess(true);
        resetStateMarked = true;
        let rejectResetForce: ((error: Error) => void) | undefined;
        const resetForceCancelled = new Promise<never>((_, reject): void => {
          rejectResetForce = reject;
          this.cancelPendingResetForce = reject;
        });

        try {
          await Promise.race([
            resettingBlz.forceReset(),
            resetForceCancelled,
          ]);
        } finally {
          if (
            rejectResetForce &&
            this.cancelPendingResetForce === rejectResetForce
          ) {
            this.cancelPendingResetForce = undefined;
          }
        }
      }

      if (await this.waitForResetDelay(2000, resetStopGeneration)) {
        // don't emit 'close' on stop since we don't want this to bubble back up as 'disconnected' to the controller.
        await this.stop(false, true);
      }
    } catch (err) {
      logger.debug(`Stop error ${err}`, NS);
    }
    try {
      if (this.stopGeneration !== resetStopGeneration) {
        logger.debug("Reset cancelled by stop.", NS);
        return;
      }

      if (!(await this.waitForResetDelay(1000, resetStopGeneration))) {
        return;
      }

      logger.debug(`Startup again.`, NS);
      await this.startup();
      // Clear reset state after successful startup
      if (this.blz) {
        this.blz.setResetingProcess(false);
        if (this.blz === resettingBlz) {
          resetStateMarked = false;
        }
      }
    } catch (err) {
      logger.debug(`Reset error ${err}`, NS);
      // Clear reset state on error

      try {
        // here we let emit
        await this.stop();
      } catch (stopErr) {
        logger.debug(`Failed to stop after failed reset ${stopErr}`, NS);
      }
    } finally {
      if (resetStateMarked) {
        resettingBlz?.setResetingProcess(false);
      }
    }
  }

  private async onBlzReset(): Promise<void> {
    logger.debug("onBlzReset()", NS);
    await this.reset();
  }

  private onBlzClose(): void {
    logger.debug("onBlzClose()", NS);
    this.emit("close");
  }

  public async stop(
    emitClose: boolean = true,
    internalReset: boolean = false,
  ): Promise<void> {
    logger.debug("Stopping driver", NS);
    this.requestGeneration += 1;
    this.requestRetryDelay.cancel();
    if (!internalReset) {
      this.stopGeneration += 1;
      this.resetDelay.cancel();
      this.startupDelay.cancel();
      this.cancelPendingResetForce?.(new Error("Driver stopped"));
      this.cancelPendingStartupOperation?.(new Error("Driver stopped"));
    }

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
      this.waitress.clear();
      this.clearAddressCache();
    }
  }

  private detachBlzListeners(blz: Blz): void {
    blz.off("close", this.onBlzCloseHandler);
    blz.off("reset", this.onBlzResetHandler);
    blz.off("frame", this.handleFrameHandler);
  }

  public async startup(): Promise<TsType.StartResult> {
    if (this.startupPromise) {
      logger.debug("Startup already in progress.", NS);
      return await this.startupPromise;
    }

    const startupPromise = this.performStartup().finally(() => {
      if (this.startupPromise === startupPromise) {
        this.startupPromise = undefined;
      }
    });
    this.startupPromise = startupPromise;

    return await startupPromise;
  }

  private async performStartup(): Promise<TsType.StartResult> {
    let result: TsType.StartResult = "resumed";
    this.transactionID = 1;

    if (this.blz) {
      await this.stop(false);
    }
    const startupStopGeneration = this.stopGeneration;

    const blz = new Blz();
    this.blz = blz;

    try {
      blz.on("close", this.onBlzCloseHandler);

      try {
        await this.runStartupOperation(
          () => blz.connect(this.serialOpt),
          startupStopGeneration,
        );
      } catch (error) {
        logger.debug(`BLZ could not connect: ${error}`, NS);
        throw error;
      }
      this.throwIfStartupCancelled(startupStopGeneration);

      blz.on("reset", this.onBlzResetHandler);

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

      if (
        await this.runStartupOperation(
          () => this.needsToBeInitialised(this.nwkOpt),
          startupStopGeneration,
        )
      ) {
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
          await this.runStartupOperation(
            () => this.formNetwork(true),
            startupStopGeneration,
          );
          result = "restored";
        } else {
          logger.info("Form a new network", NS);
          await this.runStartupOperation(
            () => this.formNetwork(false),
            startupStopGeneration,
          );
          result = "reset";
        }
      }
      await this.waitForStartupDelay(1000, startupStopGeneration);
      // TODO: make sure the stack is running
      logger.info("The Zigbee network is formed", NS);

      const netParams = await this.runStartupOperation(
        () => blz.execCommand("getNetworkParameters"),
        startupStopGeneration,
      );
      logger.info(
        `Command (getNetworkParameters) returned: ${netParams.status}`,
        NS,
      );
      if (netParams.status !== BlzStatus.SUCCESS) {
        logger.error(
          `Command (getNetworkParameters) returned unexpected state: ${netParams.status}`,
          NS,
        );
      }
      logger.info(`PanId: ${netParams.panId.toString(16)}`, NS);
      logger.info(`extendedPanId: ${netParams.extPanId.toString(16)}`, NS);
      this.networkParams = new BlzNetworkParameters();
      // Convert number/bigint to 8-byte Buffer in big-endian format
      const buf = Buffer.alloc(8);
      if (typeof netParams.extPanId === "bigint") {
        buf.writeBigUInt64BE(netParams.extPanId);
      } else {
        buf.writeBigUInt64BE(BigInt(netParams.extPanId));
      }
      this.networkParams.extendedPanId = buf;
      this.networkParams.panId = netParams.panId;
      this.networkParams.Channel = netParams.channel;
      this.networkParams.nwkUpdateId = netParams.nwkUpdateId;
      logger.debug(
        `Node type: ${netParams.nodeType}, Network parameters: ${this.networkParams}`,
        NS,
      );

      const ieee = (
        await this.runStartupOperation(
          () =>
            blz.execCommand("getValue", {
              valueId: BlzValueId.BLZ_VALUE_ID_MAC_ADDRESS,
            }),
          startupStopGeneration,
        )
      ).value;
      // Convert BLZ hardware MAC format to IEEE EUI-64 standard format
      const ieeeEui64 = this.convertBlzMacToIeeeEui64(ieee);
      this.ieee = new BlzEUI64(ieeeEui64);
      blz.on("frame", this.handleFrameHandler);
      logger.debug(`BLZ nodeid=0x0000, IEEE=0x${this.ieee}`, NS);
      logger.debug("Network ready", NS);

      return result;
    } catch (error) {
      await this.cleanupFailedStartup(error);
      throw error;
    }
  }

  private async cleanupFailedStartup(error: unknown): Promise<void> {
    logger.debug(`Startup failed, cleaning up BLZ resources: ${error}`, NS);

    try {
      await this.stop(false);
    } catch (stopError) {
      logger.debug(`Failed to stop after failed startup ${stopError}`, NS);
    }
  }

  private async needsToBeInitialised(
    options: TsType.NetworkOptions,
  ): Promise<boolean> {
    const blz = this.getBlz();
    let valid = true;
    valid = valid && (await blz.networkInit());
    logger.debug(`needToBeInitialized success stack up: ${valid}`, NS);
    const netParams = await blz.execCommand("getNetworkParameters");
    logger.debug(
      `Current Node type: ${netParams.nodeType}, Network parameters: ${netParams}`,
      NS,
    );
    valid = valid && netParams.status == BlzStatus.SUCCESS;
    logger.debug(`needToBeInitialized success get parameters: ${valid}`, NS);
    valid = valid && netParams.nodeType == BlzNodeType.COORDINATOR;
    logger.debug(`needToBeInitialized is coordinator: ${valid}`, NS);
    valid = valid && options.panID == netParams.panId;
    logger.debug(`needToBeInitialized same PanID: ${valid}`, NS);
    // valid = valid && options.channelList.includes(netParams.channel);
    // // try to add support for change channel so if only channel is different, it can still work as resumed
    logger.debug(
      `needToBeInitialized valid channel (optional, can be false): ${options.channelList.includes(netParams.channel)}`,
      NS,
    );
    // Convert bigint extPanId to 8-byte array in little-endian order
    const extPanIdArray = [];
    let extPanId = netParams.extPanId;
    for (let i = 0; i < 8; i++) {
      extPanIdArray.push(Number(extPanId & 0xffn));
      extPanId >>= 8n;
    }
    valid = valid && equals(options.extendedPanID, extPanIdArray);
    logger.debug(`options.extendedPanID: ${options.extendedPanID}`, NS);
    logger.debug(`current extendedPanID: ${extPanIdArray}`, NS);
    logger.debug(`needToBeInitialized same extended PanID: ${valid}`, NS);
    return !valid;
  }

  private async formNetwork(restore: boolean): Promise<void> {
    const blz = this.getBlz();
    let backup;
    if (restore) {
      backup = await this.backupMan.getStoredBackup();

      if (!backup) {
        throw new Error(`No valid backup found.`);
      }
      const { sequenceNumber, frameCounter } = backup.networkKeyInfo;
      let networkKey = backup.networkOptions.networkKey;
      // Convert hex string to Buffer if needed
      if (typeof networkKey === "string") {
        networkKey = Buffer.from(networkKey, "hex");
      }
      // can only change network key and link key when the stack is on and leave the current network
      await this.setNetworkKeyInfo(networkKey, frameCounter, sequenceNumber);
      // await this.setGlobalTcLinkKey(backup.blz!.tclk!, backup.blz!.tclkFrameCounter!);
    } else {
      if (this.nwkOpt.networkKey) {
        let networkKey = this.nwkOpt.networkKey;
        await this.setNetworkKeyInfo(Buffer.from(networkKey), 0, 0);
      }
    }

    if (restore) {
      const [backupextendedPanID] = uint64_t.deserialize(
        uint64_t,
        Buffer.from(backup!.networkOptions.extendedPanId),
      );
      await blz.formNetwork(
        backupextendedPanID,
        backup!.networkOptions.panId,
        backup!.logicalChannel,
      );
    } else {
      const [nwkoptextendedPanID] = uint64_t.deserialize(
        uint64_t,
        Buffer.from(this.nwkOpt.extendedPanID!),
      );
      await blz.formNetwork(
        nwkoptextendedPanID,
        this.nwkOpt.panID,
        this.nwkOpt.channelList[0],
      );
    }

    this.clearAddressCache();
  }

  private handleFrame(frameName: string, frame: BLZFrameData): void {
    switch (true) {
      case frameName === "apsDataIndication": {
        const apsFrame: BlzApsFrame = new BlzApsFrame();
        apsFrame.profileId = frame.profileId;
        apsFrame.clusterId = frame.clusterId;
        apsFrame.sourceEndpoint = frame.srcEp;
        apsFrame.destinationEndpoint = frame.dstEp;
        apsFrame.sequence = 0;
        apsFrame.groupId = frame.dstShortAddr;

        if (
          frame.profileId == Zdo.ZDO_PROFILE_ID &&
          frame.clusterId >= 0x8000 /* response only */
        ) {
          const zdoResponse = Zdo.Buffalo.readResponse(
            true,
            frame.clusterId,
            frame.message,
          );

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

          // always pass ZDO to bubble up to controller
          this.emit("incomingMessage", {
            messageType: frame.msgType,
            apsFrame,
            lqi: frame.lqi,
            rssi: frame.rssi,
            sender: frame.srcShortAddr,
            bindingIndex: null,
            addressIndex: null,
            message: frame.message,
            senderEui64: this.getCachedEui64(frame.srcShortAddr),
            zdoResponse,
          });
        } else {
          const handled = this.waitress.resolve({
            address: frame.srcShortAddr,
            payload: frame.message,
            frame: apsFrame,
          });

          if (!handled) {
            this.emit("incomingMessage", {
              messageType: frame.msgType,
              apsFrame,
              lqi: frame.lqi,
              rssi: frame.rssi,
              sender: frame.srcShortAddr,
              bindingIndex: null,
              addressIndex: null,
              message: frame.message,
              senderEui64: this.getCachedEui64(frame.srcShortAddr),
            });
          }
        }
        break;
      }
      case frameName === "deviceJoinCallback": {
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
      case frameName === "nwkStatusCallback": {
        logger.debug(`Network status callback called is received`, NS);
        this.handleNetworkStatus(frame.status);
        break;
      }
      case frameName === "apsDataConfirm": {
        if (frame.status === BlzStatus.SUCCESS) {
          logger.debug(`APS confirmed`, NS);
        } else {
          logger.warning(`APS Request failed`, NS);
        }
        break;
      }
      case frameName === "stackStatusHandler": {
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

  private handleNetworkStatus(status: BlzStatus): void {
    logger.debug(`handleNetworkStatus: networkStatusCode=${status}`, NS);
  }

  /** Normalize IEEE address to consistent format (no 0x prefix, lowercase). */
  private normalizeIeee(ieee: string): string {
    return ieee.replace(/^0x/i, "").toLowerCase();
  }

  private cacheNodeIeee(
    nwk: number,
    ieee: BlzEUI64 | ArrayLike<number> | string | number,
  ): BlzEUI64 {
    const eui64 =
      ieee instanceof BlzEUI64
        ? ieee
        : new BlzEUI64(
            typeof ieee === "number"
              ? ieee.toString(16).padStart(16, "0")
              : ieee,
          );
    const normalized = this.normalizeIeee(eui64.toString());
    const previousEui64 = this.nodeIdToEui64.get(nwk);
    const previousNwk = this.eui64ToNodeId.get(normalized);

    if (previousEui64) {
      this.eui64ToNodeId.delete(this.normalizeIeee(previousEui64.toString()));
    }

    if (previousNwk !== undefined && previousNwk !== nwk) {
      this.nodeIdToEui64.delete(previousNwk);
    }

    this.eui64ToNodeId.set(normalized, nwk);
    this.nodeIdToEui64.set(nwk, eui64);

    return eui64;
  }

  private getCachedEui64(nwk: number): BlzEUI64 | undefined {
    return this.nodeIdToEui64.get(nwk);
  }

  private clearAddressCache(): void {
    this.eui64ToNodeId.clear();
    this.nodeIdToEui64.clear();
  }

  private removeCachedNode(nwk: number, ieeeAddr: string): void {
    this.nodeIdToEui64.delete(nwk);
    this.eui64ToNodeId.delete(this.normalizeIeee(ieeeAddr));
  }

  public handleNodeJoined(nwk: number, ieee: number): void {
    const eui64 = this.cacheNodeIeee(nwk, ieee);
    const ieeeAddrFull = `0x${eui64.toString()}`;
    logger.debug(`deviceJoined, 0x${nwk.toString(16)}, ${ieeeAddrFull}`, NS);
    this.emit("deviceJoined", nwk, ieeeAddrFull);
  }

  public handleNodeLeft(nwk: number, ieeeAddr: string): void {
    this.removeCachedNode(nwk, ieeeAddr);
    logger.debug(`deviceLeft, 0x${nwk.toString(16)}, ${ieeeAddr}`, NS);
    this.emit("deviceLeft", nwk, ieeeAddr);
  }

  public setNode(nwk: number, ieee: BlzEUI64 | number[]): void {
    this.cacheNodeIeee(nwk, ieee);
  }

  public async request(
    nwk: number | BlzEUI64,
    apsFrame: BlzApsFrame,
    data: Buffer,
    extendedTimeout = false,
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
          let nodeId = this.eui64ToNodeId.get(this.normalizeIeee(strEui64));

          if (nodeId === undefined) {
            nodeId = (
              await this.getBlz().execCommand("getNodeIdByEui64", {
                eui64: eui64,
              })
            ).nodeId;
            if (nodeId && nodeId !== 0xffff) {
              this.cacheNodeIeee(nodeId, eui64);
            } else {
              throw new Error("Unknown EUI64:" + strEui64);
            }
          }
          resolvedNwk = nodeId;
        } else {
          resolvedNwk = nwk;
        }

        const sendResult = await this.sendApsData(
          BlzOutgoingMessageType.BLZ_MSG_TYPE_UNICAST,
          resolvedNwk,
          apsFrame,
          data,
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
          `Request attempt ${attempt + 1}/${REQUEST_ATTEMPT_DELAYS.length} error: ${e}`,
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
    return this.requestGeneration !== requestGeneration || !this.blz;
  }

  private async waitForRequestRetry(
    milliseconds: number,
    requestGeneration: number,
  ): Promise<boolean> {
    return await this.requestRetryDelay.wait(
      milliseconds,
      () => !this.isRequestCancelled(requestGeneration),
    );
  }

  private async waitForResetDelay(
    milliseconds: number,
    resetStopGeneration: number,
  ): Promise<boolean> {
    if (this.stopGeneration !== resetStopGeneration) {
      logger.debug("Reset cancelled by stop.", NS);
      return false;
    }

    const stillActive = await this.resetDelay.wait(
      milliseconds,
      () => this.stopGeneration === resetStopGeneration,
    );

    if (!stillActive) {
      logger.debug("Reset cancelled by stop.", NS);
    }

    return stillActive;
  }

  private throwIfStartupCancelled(startupStopGeneration: number): void {
    if (this.stopGeneration !== startupStopGeneration) {
      throw new Error("Driver stopped");
    }
  }

  private async waitForStartupDelay(
    milliseconds: number,
    startupStopGeneration: number,
  ): Promise<void> {
    this.throwIfStartupCancelled(startupStopGeneration);

    const stillActive = await this.startupDelay.wait(
      milliseconds,
      () => this.stopGeneration === startupStopGeneration,
    );

    if (!stillActive) {
      throw new Error("Driver stopped");
    }
  }

  private async runStartupOperation<T>(
    operation: () => Promise<T>,
    startupStopGeneration: number,
  ): Promise<T> {
    this.throwIfStartupCancelled(startupStopGeneration);

    let rejectStartupOperation: ((error: Error) => void) | undefined;
    const startupOperationCancelled = new Promise<never>((_, reject): void => {
      rejectStartupOperation = reject;
      this.cancelPendingStartupOperation = reject;
    });

    try {
      const result = await Promise.race([
        operation(),
        startupOperationCancelled,
      ]);
      this.throwIfStartupCancelled(startupStopGeneration);

      return result;
    } finally {
      if (
        rejectStartupOperation &&
        this.cancelPendingStartupOperation === rejectStartupOperation
      ) {
        this.cancelPendingStartupOperation = undefined;
      }
    }
  }

  public async mrequest(
    apsFrame: BlzApsFrame,
    data: Buffer,
    timeout = 30000,
  ): Promise<boolean> {
    return await this.sendApsDataStatus(
      BlzOutgoingMessageType.BLZ_MSG_TYPE_MULTICAST,
      apsFrame.groupId ?? 0,
      apsFrame,
      data,
    );
  }

  public async brequest(
    destination: number,
    apsFrame: BlzApsFrame,
    data: Buffer,
  ): Promise<boolean> {
    return await this.sendApsDataStatus(
      BlzOutgoingMessageType.BLZ_MSG_TYPE_BROADCAST,
      destination,
      apsFrame,
      data,
    );
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

  public nextTransactionID(): number {
    this.transactionID = (this.transactionID + 1) & 0xff;
    return this.transactionID;
  }

  public makeApsFrame(
    clusterId: number,
    disableResponse: boolean,
  ): BlzApsFrame {
    const frame = new BlzApsFrame();
    frame.clusterId = clusterId;
    frame.profileId = 0;
    frame.sequence = this.nextTransactionID();
    frame.sourceEndpoint = 0;
    frame.destinationEndpoint = 0;
    frame.groupId = 0;
    return frame;
  }

  public async networkIdToEUI64(nwk: number): Promise<BlzEUI64> {
    const cached = this.getCachedEui64(nwk);

    if (cached) {
      return cached;
    }

    for (const [eui64Str, nodeId] of this.eui64ToNodeId) {
      if (nodeId === nwk) {
        return this.cacheNodeIeee(nwk, eui64Str);
      }
    }

    const response = await this.getBlz().execCommand("getEui64ByNodeId", {
      nodeId: nwk,
    });

    if (response.status === BlzStatus.SUCCESS) {
      return this.cacheNodeIeee(nwk, response.eui64);
    } else {
      throw new Error("Unrecognized nodeId:" + nwk);
    }
  }

  public async permitJoining(seconds: number): Promise<BLZFrameData> {
    return await this.getBlz().execCommand("permitJoining", {
      duration: seconds,
    });
  }

  public async addEndpoint({
    endpoint = 1,
    profileId = 260,
    deviceId = 0xbeef,
    appFlags = 0,
    inputClusters = [],
    outputClusters = [],
  }: AddEndpointParameters): Promise<void> {
    const res = await this.getBlz().execCommand("addEndpoint", {
      endpoint: endpoint,
      profileId: profileId,
      deviceId: deviceId,
      appFlags: appFlags,
      inputClusterCount: inputClusters.length,
      outputClusterCount: outputClusters.length,
      inputClusterList: inputClusters,
      outputClusterList: outputClusters,
    });
    logger.debug(() => `Blz adding endpoint: ${JSON.stringify(res)}`, NS);
  }

  public waitFor(
    address: number | string,
    clusterId: number,
    timeout = 10000,
  ): ReturnType<typeof this.waitress.waitFor> & { cancel: () => void } {
    const waiter = this.waitress.waitFor({ address, clusterId }, timeout);
    return { ...waiter, cancel: () => this.waitress.remove(waiter.ID) };
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
      `waitressValidator: payload.address=${payload.address}, matcher.address=${matcher.address}, payload.frame.clusterId=${payload.frame?.clusterId}, matcher.clusterId=${matcher.clusterId}`,
      NS,
    );
    return (
      (!matcher.address || payload.address === matcher.address) &&
      (!payload.frame || payload.frame.clusterId === matcher.clusterId)
    );
  }

  public async getGlobalTcLinkKey(): Promise<BLZFrameData> {
    const frameResponse = await this.getBlz().execCommand("getGlobalTcLinkKey");

    const { status, linkKey, outgoingFrameCounter, trustCenterAddress } =
      frameResponse;

    if (status !== BlzStatus.SUCCESS) {
      logger.error(
        `getGlobalTcLinkKey() returned unexpected BLZ status: ${status}`,
        NS,
      );
      throw new Error(
        `Failed to get global Trust Center key: status ${status}`,
      );
    }

    logger.debug(
      `Global TC Key retrieved: Key=${linkKey.toString("hex")}, FrameCounter=${outgoingFrameCounter}, TCAddress=${trustCenterAddress}`,
      NS,
    );

    return frameResponse;
  }

  public async setGlobalTcLinkKey(
    linkKey: Bytes,
    outgoingFrameCounter: uint32_t,
  ): Promise<BlzStatus> {
    const frameRequest = {
      linkKey,
      outgoingFrameCounter,
    };

    const frameResponse = await this.getBlz().execCommand(
      "setGlobalTcLinkKey",
      frameRequest,
    );

    const { status } = frameResponse;

    if (status !== BlzStatus.SUCCESS) {
      logger.error(`setGlobalTcLinkKey() failed with status: ${status}`, NS);
      throw new Error(
        `Failed to set global Trust Center key: status ${status}`,
      );
    }

    logger.debug(
      `Global TC Key set successfully: Key=${linkKey}, FrameCounter=${outgoingFrameCounter}`,
      NS,
    );

    return status;
  }

  public async getNetworkKeyInfo(): Promise<BLZFrameData> {
    const frameResponse = await this.getBlz().execCommand("getNwkSecurityInfos");

    const { status, nwkKey, outgoingFrameCounter, nwkKeySeqNum } =
      frameResponse;

    if (status !== BlzStatus.SUCCESS) {
      logger.error(
        `getNetworkKeyInfo() returned unexpected BLZ status: ${status}`,
        NS,
      );
      throw new Error(`Failed to get network key info: status ${status}`);
    }

    logger.debug(
      `Network Key Info retrieved: Key=${nwkKey.toString("hex")}, FrameCounter=${outgoingFrameCounter}, SeqNum=${nwkKeySeqNum}`,
      NS,
    );

    return frameResponse;
  }

  public async setNetworkKeyInfo(
    nwkKey: Bytes,
    outgoingFrameCounter: uint32_t,
    nwkKeySeqNum: uint8_t,
  ): Promise<BlzStatus> {
    // Validate network key format
    if (!Buffer.isBuffer(nwkKey) || nwkKey.length !== 16) {
      throw new Error(`Invalid network key format - must be 16 byte Buffer`);
    }

    logger.debug(`Setting network key: ${nwkKey.toString("hex")}`, NS);
    logger.debug(`Frame counter: ${outgoingFrameCounter}`, NS);
    logger.debug(`Key seq num: ${nwkKeySeqNum}`, NS);

    const frameRequest = {
      nwkKey,
      outgoingFrameCounter,
      nwkKeySeqNum,
    };

    const frameResponse = await this.getBlz().execCommand(
      "setNwkSecurityInfos",
      frameRequest,
    );

    const { status } = frameResponse;

    if (status !== BlzStatus.SUCCESS) {
      logger.error(`setNwkSecurityInfos() failed with status: ${status}`, NS);
      throw new Error(`Failed to set network security infos: status ${status}`);
    }

    logger.debug(
      `Network Security Infos set successfully: Key=${nwkKey.toString("hex")}, FrameCounter=${outgoingFrameCounter}, SeqNum=${nwkKeySeqNum}`,
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
    const currentExtendedPanID = Buffer.from(options.extendedPanID!);
    const backupExtendedPanID = backup.networkOptions.extendedPanId;
    logger.debug(
      `Configured extendedPanID (raw): ${currentExtendedPanID.toString("hex")}`,
      NS,
    );
    logger.debug(
      `Backup extendedPanID (raw): ${backupExtendedPanID.toString("hex")}`,
      NS,
    );

    // Convert both to uint64_t for consistent comparison
    const [currentPanID] = uint64_t.deserialize(uint64_t, currentExtendedPanID);
    const [backupPanID] = uint64_t.deserialize(uint64_t, backupExtendedPanID);
    logger.debug(
      `Configured extendedPanID (uint64): ${currentPanID.toString(16)}`,
      NS,
    );
    logger.debug(
      `Backup extendedPanID (uint64): ${backupPanID.toString(16)}`,
      NS,
    );
    valid = valid && currentPanID === backupPanID;
    logger.debug(`needsToBeRestore same extendedPanID: ${valid}`, NS);
    const currentNetworkKey = Buffer.from(options.networkKey!);
    const backupNetworkKey = backup.networkOptions.networkKey;
    logger.debug(
      `Configured networkKey (raw): ${currentNetworkKey.toString("hex")}`,
      NS,
    );
    logger.debug(
      `Backup networkKey (raw): ${backupNetworkKey.toString("hex")}`,
      NS,
    );
    valid = valid && currentNetworkKey.equals(backupNetworkKey);
    logger.debug(`needsToBeRestore same network key: ${valid}`, NS);
    return valid;
  }
}
