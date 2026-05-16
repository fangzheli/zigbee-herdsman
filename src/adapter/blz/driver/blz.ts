/* istanbul ignore file */

import { EventEmitter } from "events";

import { logger } from "../../../utils/logger";
import { bufferFromBytes, bytesToHex } from "../byteUtils";
import { CancellableQueue } from "../cancellableQueue";
import {
  attachListenersOrRollback,
  detachListeners,
  type OwnedEventListener,
} from "../eventListeners";
import {errorFromUnknown, formatLogMessage, formatUnknownError} from "../errorUtils";
import {
  runAsyncCleanupSteps,
  runCleanupSteps,
} from "../lifecycleCleanup";
import { SerialPortOptions } from "../../tstype";
import {
  BlzCommandWaiters,
  type BlzCommandWaiter,
} from "./blzCommandWaiters";
import { BlzWatchdog } from "./blzWatchdog";
import { CancellableDelay } from "./cancellableDelay";
import { CancellableOperation } from "./cancellableOperation";
import { FRAMES, ParamsDesc } from "./commands";
import { BLZFrameData } from "./frameData";
import * as t from "./types";
import { BlzOutgoingMessageType, BlzStatus } from "./types/named";
import { BlzApsFrame } from "./types/struct";
import { SerialDriver } from "./uart";
import { Bytes, uint8_t, uint16_t, uint32_t, uint64_t } from "./types";
import { BlzValueId } from "./types/named";

export { BLZFrameData } from "./frameData";

export const NS = "zh:blz:blz";

export const MAX_SERIAL_CONNECT_ATTEMPTS = 4;
/** In ms. This is multiplied by tries count (above), e.g., 4 tries = 5000, 10000, 15000 */
export const SERIAL_CONNECT_NEW_ATTEMPT_MIN_DELAY = 5000;
const MTOR_MIN_INTERVAL = 10;
const MTOR_MAX_INTERVAL = 90;
const MTOR_ROUTE_ERROR_THRESHOLD = 4;
const MTOR_DELIVERY_FAIL_THRESHOLD = 3;
const MAX_WATCHDOG_FAILURES = 2;
const WATCHDOG_WAKE_PERIOD = 30; // in sec
const BLZ_DEFAULT_RADIUS = 0;

type ForceResetOptions = {
  holdResetState?: boolean;
};

export type BlzVersion = {
  product: number;
  major: string;
  minor: string;
  patch: string;
  build: string;
};

export class Blz extends EventEmitter {
  private serialDriver: SerialDriver;
  private readonly commandWaiters = new BlzCommandWaiters();
  private readonly watchdog: BlzWatchdog;
  private queue: CancellableQueue;
  private inResetingProcess = false;
  private connectGeneration = 0;
  private connectPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private emitCloseWhenCloseCompletes = false;
  private readonly connectRetryDelay = new CancellableDelay();
  private readonly connectOperations = new CancellableOperation();
  private readonly connectResetOperations = new CancellableOperation();
  private serialDriverEventBridgeAttached = false;
  private serialDriverResetListenerAttached = false;
  private readonly onSerialResetHandler = this.onSerialReset.bind(this);
  private readonly onSerialCloseHandler = this.onSerialClose.bind(this);
  private readonly onFrameReceivedHandler = this.onFrameReceived.bind(this);
  private readonly serialDriverEventBridgeRegistrations: readonly OwnedEventListener[] =
    [
      { event: "received", listener: this.onFrameReceivedHandler },
      { event: "close", listener: this.onSerialCloseHandler },
    ];
  private version: BlzVersion;

  constructor() {
    super();
    this.queue = new CancellableQueue();

    this.serialDriver = new SerialDriver();
    this.watchdog = new BlzWatchdog({
      periodSeconds: WATCHDOG_WAKE_PERIOD,
      maxFailures: MAX_WATCHDOG_FAILURES,
      heartbeat: () => this.getVersion(),
      isResetting: () => this.inResetingProcess,
      emitReset: () => this.emit("reset"),
      debug: (message) => logger.debug(message, NS),
      error: (message) => logger.error(formatLogMessage(message), NS),
    });
    this.attachSerialDriverEventBridge();
    this.version = {
      product: 1,
      major: "0",
      minor: "0",
      patch: "0",
      build: "0",
    };
  }

  public getVersionSnapshot(): BlzVersion {
    return { ...this.version };
  }

  public async connect(options: SerialPortOptions): Promise<void> {
    if (this.closePromise) {
      await this.closePromise;
    }

    if (this.connectPromise) {
      logger.debug("Connection already in progress.", NS);
      return await this.connectPromise;
    }

    const connectPromise = this.performConnect(options).finally(() => {
      if (this.connectPromise === connectPromise) {
        this.connectPromise = undefined;
      }
    });
    this.connectPromise = connectPromise;

    return await connectPromise;
  }

  private async performConnect(options: SerialPortOptions): Promise<void> {
    let connectionEstablished = false;
    const connectGeneration = this.connectGeneration;
    this.attachSerialDriverEventBridge();

    try {
      if (this.serialDriver.isInitialized()) {
        const reconnectError = this.createConnectionClosedError();
        const runtimeCleanupError =
          this.captureSerialRuntimeCleanup(reconnectError);
        let closeError: unknown;

        try {
          await this.runConnectOperation(
            () => this.serialDriver.close(false),
            connectGeneration,
          );
        } catch (error) {
          closeError = error;
        }

        this.throwIfReconnectCleanupFailed(
          runtimeCleanupError,
          closeError,
        );
      }

      const resetForReconnect = (): void => {
        this.cancelConnectResetOperations(this.createFailureToConnectError());
      };
      await this.withConnectResetListener(
        resetForReconnect,
        () => this.connectWithRetries(options, connectGeneration),
      );

      this.inResetingProcess = false;
      this.watchdog.resetFailures();
      this.attachSerialDriverResetListener();
      this.startWatchdogTimer();
      connectionEstablished = true;

      logger.debug("Connection established successfully", NS);
    } catch (error) {
      if (!connectionEstablished) {
        return await this.throwAfterFailedConnectCleanup(error);
      }
      throw error;
    }
  }

  private async throwAfterFailedConnectCleanup(error: unknown): Promise<never> {
    try {
      await this.cleanupFailedConnect();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Failed to connect and cleanup serial driver listeners",
      );
    }

    throw error;
  }

  private async cleanupFailedConnect(): Promise<void> {
    if (!this.closePromise && this.serialDriver.isInitialized()) {
      await runAsyncCleanupSteps([
        () => {
          this.detachSerialDriverListeners();
        },
        () => this.serialDriver.close(false),
      ]);
      return;
    }

    this.detachSerialDriverListeners();
  }

  private async connectWithRetries(
    options: SerialPortOptions,
    connectGeneration: number,
  ): Promise<void> {
    let lastError: Error | null = null;

    for (let i = 1; i <= MAX_SERIAL_CONNECT_ATTEMPTS; i++) {
      try {
        logger.debug(
          `Attempting connection (attempt ${i}/${MAX_SERIAL_CONNECT_ATTEMPTS})`,
          NS,
        );
        await this.runSerialConnectAttempt(options, connectGeneration);

        if (this.isConnectCancelled(connectGeneration)) {
          throw this.createConnectionCancelledByCloseError();
        }

        // Verify connection is actually established
        if (this.serialDriver.isInitialized()) {
          return;
        }

        throw new Error("Driver reported connection but is not initialized");
      } catch (error) {
        const attemptError = errorFromUnknown(error);
        lastError = attemptError;
        logger.error(
          formatLogMessage(() => `Connection attempt ${i} failed: ${attemptError.message}`),
          NS,
        );

        if (this.isConnectCancelled(connectGeneration)) {
          throw lastError;
        }

        await this.cleanupFailedConnectAttempt(connectGeneration);

        if (this.isConnectCancelled(connectGeneration)) {
          throw lastError;
        }

        if (i < MAX_SERIAL_CONNECT_ATTEMPTS) {
          const delay = SERIAL_CONNECT_NEW_ATTEMPT_MIN_DELAY * i;
          logger.debug(`Waiting ${delay}ms before next attempt`, NS);
          const continueRetry = await this.waitForConnectRetry(
            delay,
            connectGeneration,
          );

          if (!continueRetry) {
            throw this.createConnectionCancelledByCloseError();
          }
        }
      }
    }

    const error = new Error(
      `Failed to connect after ${MAX_SERIAL_CONNECT_ATTEMPTS} attempts`,
    );
    error.cause = lastError;
    throw error;
  }

  private async withConnectResetListener(
    listener: () => void,
    operation: () => Promise<void>,
  ): Promise<void> {
    let operationError: unknown;
    let hasOperationError = false;
    let cleanupError: unknown;
    let hasCleanupError = false;

    this.attachConnectResetListener(listener);

    try {
      await operation();
    } catch (error) {
      operationError = error;
      hasOperationError = true;
    }

    try {
      this.detachConnectResetListener(listener);
    } catch (error) {
      cleanupError = error;
      hasCleanupError = true;
    }

    if (hasOperationError && hasCleanupError) {
      throw new AggregateError(
        [operationError, cleanupError],
        "Failed to connect and cleanup connect reset listener",
      );
    }

    if (hasOperationError) {
      throw operationError;
    }

    if (hasCleanupError) {
      throw cleanupError;
    }
  }

  private async runSerialConnectAttempt(
    options: SerialPortOptions,
    connectGeneration: number,
  ): Promise<void> {
    await this.runConnectOperation(
      () =>
        this.connectResetOperations.run(
          () => this.serialDriver.connect(options),
          () => this.isConnectGenerationActive(connectGeneration),
          () => this.createConnectionCancelledByCloseError(),
        ),
      connectGeneration,
    );
  }

  private async cleanupFailedConnectAttempt(
    connectGeneration: number,
  ): Promise<void> {
    const connectFailureError = this.createFailureToConnectError();
    const runtimeCleanupError =
      this.captureSerialRuntimeCleanup(connectFailureError);

    try {
      await this.runConnectOperation(
        () => this.serialDriver.close(false),
        connectGeneration,
      );
    } catch (error) {
      if (this.isConnectCancelled(connectGeneration)) {
        throw error;
      }

      logger.debug(
        () => `Failed to close serial driver after connect failure: ${formatUnknownError(error)}`,
        NS,
      );
    }

    if (runtimeCleanupError !== undefined) {
      throw runtimeCleanupError;
    }
  }

  private captureSerialRuntimeCleanup(error: Error): unknown {
    try {
      this.clearSerialRuntimeState(error);
    } catch (cleanupError) {
      return cleanupError;
    }

    return undefined;
  }

  private throwIfReconnectCleanupFailed(
    runtimeCleanupError: unknown,
    closeError: unknown,
  ): void {
    if (runtimeCleanupError !== undefined && closeError !== undefined) {
      throw new AggregateError(
        [runtimeCleanupError, closeError],
        "Failed to cleanup serial runtime state and close serial driver",
      );
    }

    if (closeError !== undefined) {
      throw closeError;
    }

    if (runtimeCleanupError !== undefined) {
      throw runtimeCleanupError;
    }
  }

  private isConnectCancelled(connectGeneration: number): boolean {
    return !this.isConnectGenerationActive(connectGeneration);
  }

  private isConnectGenerationActive(connectGeneration: number): boolean {
    return this.connectGeneration === connectGeneration;
  }

  private throwIfConnectionChanged(connectGeneration: number): void {
    if (this.isConnectCancelled(connectGeneration)) {
      throw this.createConnectionClosedError();
    }
  }

  private async runConnectOperation<T>(
    operation: () => Promise<T>,
    connectGeneration: number,
  ): Promise<T> {
    return await this.connectOperations.run(
      operation,
      () => this.isConnectGenerationActive(connectGeneration),
      () => this.createConnectionCancelledByCloseError(),
    );
  }

  private async waitForConnectRetry(
    milliseconds: number,
    connectGeneration: number,
  ): Promise<boolean> {
    return await this.connectRetryDelay.wait(
      milliseconds,
      () => this.isConnectGenerationActive(connectGeneration),
    );
  }

  private clearWatchdogTimer(): void {
    this.watchdog.clear();
  }

  private startWatchdogTimer(): void {
    this.watchdog.start();
  }

  private attachSerialDriverEventBridge(): void {
    if (this.serialDriverEventBridgeAttached) {
      return;
    }

    attachListenersOrRollback(
      this.serialDriver,
      this.serialDriverEventBridgeRegistrations,
    );
    this.serialDriverEventBridgeAttached = true;
  }

  private attachSerialDriverResetListener(): void {
    this.detachSerialDriverResetListener();
    this.serialDriver.on("reset", this.onSerialResetHandler);
    this.serialDriverResetListenerAttached = true;
  }

  private attachConnectResetListener(listener: () => void): void {
    this.serialDriver.on("reset", listener);
  }

  private detachConnectResetListener(listener: () => void): void {
    this.serialDriver.off("reset", listener);
  }

  private detachSerialDriverEventBridge(): void {
    if (!this.serialDriverEventBridgeAttached) {
      return;
    }

    try {
      detachListeners(
        this.serialDriver,
        this.serialDriverEventBridgeRegistrations,
      );
    } finally {
      this.serialDriverEventBridgeAttached = false;
    }
  }

  private detachSerialDriverResetListener(): void {
    if (!this.serialDriverResetListenerAttached) {
      return;
    }

    try {
      this.serialDriver.off("reset", this.onSerialResetHandler);
    } finally {
      this.serialDriverResetListenerAttached = false;
    }
  }

  private detachSerialDriverListeners(): void {
    runCleanupSteps([
      () => {
        this.detachSerialDriverEventBridge();
      },
      () => {
        this.detachSerialDriverResetListener();
      },
    ]);
  }

  public isInitialized(): boolean {
    return this.serialDriver?.isInitialized();
  }

  private onSerialReset(): void {
    logger.debug("onSerialReset()", NS);
    this.inResetingProcess = true;
    this.cleanupAfterSerialDriverEvent(this.createConnectionResetError());
    this.emit("reset");
  }

  private onSerialClose(): void {
    logger.debug("onSerialClose()", NS);
    this.cleanupAfterSerialDriverEvent(this.createConnectionClosedError());

    if (!this.inResetingProcess) {
      this.emit("close");
    }
  }

  private cancelConnectionOperations(error: Error): void {
    this.connectGeneration += 1;
    runCleanupSteps([
      () => {
        this.cancelConnectOperations(error);
      },
      () => {
        this.cancelConnectResetOperations(error);
      },
      () => {
        this.cancelConnectRetryDelay();
      },
      () => {
        this.clearWatchdogTimer();
      },
    ]);
  }

  private cancelConnectOperations(error: Error): void {
    this.connectOperations.cancel(error);
  }

  private cancelConnectResetOperations(error: Error): void {
    this.connectResetOperations.cancel(error);
  }

  private cancelConnectRetryDelay(): void {
    this.connectRetryDelay.cancel();
  }

  private createConnectionClosedError(): Error {
    return new Error("Connection closed");
  }

  private createConnectionResetError(): Error {
    return new Error("Connection reset");
  }

  private createConnectionCancelledByCloseError(): Error {
    return new Error("Connection cancelled by close");
  }

  private createFailureToConnectError(): Error {
    return new Error("Failure to connect");
  }

  private clearPendingCommands(error: Error): void {
    runCleanupSteps([
      () => {
        this.queue.clear(error);
      },
      () => {
        this.commandWaiters.clear(error);
      },
    ]);
  }

  private clearSerialRuntimeState(error: Error): void {
    runCleanupSteps([
      () => {
        this.clearWatchdogTimer();
      },
      () => {
        this.clearPendingCommands(error);
      },
    ]);
  }

  private enterDisconnectedState(connectionError: Error, commandError = connectionError): void {
    runCleanupSteps([
      () => {
        this.cancelConnectionOperations(connectionError);
      },
      () => {
        this.clearPendingCommands(commandError);
      },
      () => {
        this.detachSerialDriverListeners();
      },
    ]);
  }

  private cleanupAfterSerialDriverEvent(connectionError: Error, commandError = connectionError): void {
    try {
      this.enterDisconnectedState(connectionError, commandError);
    } catch (cleanupError) {
      logger.debug(
        () => `Failed to cleanup after serial driver event ${formatUnknownError(cleanupError)}`,
        NS,
      );
    }
  }

  public async close(emitClose: boolean): Promise<void> {
    if (emitClose) {
      this.emitCloseWhenCloseCompletes = true;
    }

    if (this.closePromise) {
      logger.debug("Close already in progress.", NS);
      return await this.closePromise;
    }

    const closePromise = this.performClose(emitClose).finally(() => {
      if (this.closePromise === closePromise) {
        this.closePromise = undefined;
        this.emitCloseWhenCloseCompletes = false;
      }
    });
    this.closePromise = closePromise;

    return await closePromise;
  }

  private async performClose(emitClose: boolean): Promise<void> {
    logger.debug("Closing Blz", NS);

    const connectionCancelError = this.createConnectionCancelledByCloseError();
    const closeError = this.createConnectionClosedError();
    try {
      await runAsyncCleanupSteps([
        () => {
          this.enterDisconnectedState(connectionCancelError, closeError);
        },
        () => this.serialDriver.close(emitClose),
      ]);
    } finally {
      this.inResetingProcess = false;
      if (this.emitCloseWhenCloseCompletes) {
        this.emit("close");
      }
    }
  }

  /**
   * Force a direct UART-level reset, bypassing the normal command queue.
   */
  public async forceReset({
    holdResetState = false,
  }: ForceResetOptions = {}): Promise<void> {
    logger.debug("Forcing direct UART reset", NS);
    const resetConnectGeneration = this.connectGeneration;
    const wasResetingProcess = this.inResetingProcess;

    if (!this.serialDriver.isInitialized()) {
      throw new Error("Connection not initialized");
    }

    this.inResetingProcess = true;
    try {
      this.throwIfConnectionChanged(resetConnectGeneration);
      const resetError = this.createConnectionResetError();
      this.clearPendingCommands(resetError);
      this.throwIfConnectionChanged(resetConnectGeneration);
      await this.serialDriver.reset();
      this.throwIfConnectionChanged(resetConnectGeneration);
      logger.debug("Direct UART reset sent successfully", NS);
      if (!holdResetState) {
        this.inResetingProcess = wasResetingProcess;
      }
    } catch (error) {
      this.inResetingProcess = wasResetingProcess;
      logger.error(formatLogMessage(() => `Direct UART reset failed: ${error}`), NS);
      throw error;
    }
  }

  private onFrameReceived(data: Buffer): void {
    if (!Buffer.isBuffer(data)) {
      logger.error(`Data is not a Buffer. Converting...`, NS);
      data = bufferFromBytes(data as ArrayLike<number>);
    }
    const rawFrame = data;
    logger.debug(() => `<== Frame: ${rawFrame.toString("hex")}`, NS);
    if (data.length < 6) {
      logger.error(
        `Received malformed BLZ frame: expected at least 6 bytes, received ${data.length}`,
        NS,
      );
      return;
    }

    let frameId: number;
    frameId = data.readUInt16LE(2);
    const sequence = (data[1] & 0x70) >> 4;
    data = data.subarray(4, -2);

    let frm: BLZFrameData | undefined;
    try {
      frm = BLZFrameData.createFrame(frameId, false, data);
    } catch (error) {
      logger.error(
        formatLogMessage(() => `Failed to parse BLZ frame 0x${frameId.toString(16)}: ${error}`),
        NS,
      );
      return;
    }

    if (!frm) {
      logger.error(`Unparsed frame 0x${frameId.toString(16)}. Skipped`, NS);
      return;
    }

    logger.debug(
      () => `<== 0x${frameId.toString(16)}: ${JSON.stringify(frm)}`,
      NS,
    );

    const handled = this.commandWaiters.resolve({
      frameId,
      frameName: frm.name,
      sequence,
      payload: frm,
    });

    if (!handled) {
      this.emit("frame", frm.name, frm);
    }
  }

  private makeFrame(name: string, params: ParamsDesc | undefined): Buffer {
    const frmData = new BLZFrameData(name, true, params);

    logger.debug(() => `==> ${JSON.stringify(frmData)}`, NS);
    return frmData.serialize();
  }

  public async execCommand(
    name: string,
    params?: ParamsDesc,
  ): Promise<BLZFrameData> {
    logger.debug(() => `==> ${name}: ${JSON.stringify(params)}`, NS);

    if (!this.serialDriver.isInitialized()) {
      throw new Error("Connection not initialized");
    }

    return await this.queue.execute<BLZFrameData>(
      async (): Promise<BLZFrameData> => {
        const commandConnectGeneration = this.connectGeneration;
        const data = this.makeFrame(name, params);
        const waiter: BlzCommandWaiter | undefined =
          name === "reset" ? undefined : this.commandWaiters.waitFor(name);
        try {
          await this.serialDriver.sendDATA(data, FRAMES[name].ID);
          this.throwIfConnectionChanged(commandConnectGeneration);

          // Don't wait for response if this is a reset command
          if (waiter) {
            const response = await waiter.start().promise;
            this.throwIfConnectionChanged(commandConnectGeneration);
            return response.payload;
          } else {
            // For reset command, return empty BLZFrameData since we don't wait for response
            return new BLZFrameData("reset", false, {});
          }
        } catch (error) {
          this.commandWaiters.cancel(waiter);
          this.throwIfConnectionChanged(commandConnectGeneration);
          throw new Error(`Failure send ${name}: ${bytesToHex(data)}`, {
            cause: error,
          });
        }
      },
    );
  }

  private isSuccessStatus(status: BlzStatus): boolean {
    return status === BlzStatus.SUCCESS;
  }

  private formatSetValueForLog(value: number | Buffer): string {
    return Buffer.isBuffer(value) ? value.toString("hex") : `${value}`;
  }

  async networkInit(): Promise<boolean> {
    // logger.debug('Set up stack status handler before initial the network', NS);
    const result = await this.execCommand("networkInit");
    logger.debug(() => `Network init result: ${JSON.stringify(result)}`, NS);
    if (!this.isSuccessStatus(result.status)) {
      logger.error("Failure to init network", NS);
      return false;
    }
    return this.isSuccessStatus(result.status);
  }

  async leaveNetwork(): Promise<number> {
    const result = await this.execCommand("leaveNetwork");
    logger.debug(() => `Network leave result: ${JSON.stringify(result)}`, NS);

    if (!this.isSuccessStatus(result.status)) {
      logger.debug("Failure to leave network", NS);
      throw new Error(`Failure to leave network: status ${result.status}`);
    }

    return result.status;
  }

  async setValue(
    valueId: t.BlzValueId,
    value: number | Buffer,
  ): Promise<BLZFrameData> {
    const valueName = t.BlzValueId.valueName(t.BlzValueId, valueId);
    logger.debug(
      () => `Set ${valueName} = ${this.formatSetValueForLog(value)}`,
      NS,
    );

    // Convert value to Buffer if it's a number
    let valueBuffer: Buffer;
    if (typeof value === "number") {
      // For numbers, use a 4-byte buffer
      valueBuffer = Buffer.allocUnsafe(4);
      valueBuffer.writeUInt32LE(value, 0);
    } else if (Buffer.isBuffer(value)) {
      valueBuffer = value;
    } else {
      throw new Error(
        `Value must be a number or Buffer. Received: ${typeof value}`,
      );
    }

    // Send command with proper parameters
    const ret = await this.execCommand("setValue", {
      valueId,
      valueLength: valueBuffer.length,
      value: valueBuffer,
    });

    if (!this.isSuccessStatus(ret.status)) {
      logger.error(
        formatLogMessage(() => `Command (setValue(${valueName}, ${value})) returned unexpected state: ${JSON.stringify(ret)}`),
        NS,
      );
      throw new Error(`Failed to set value ${valueName}: status ${ret.status}`);
    }

    return ret;
  }

  async getValue(valueId: t.BlzValueId): Promise<Buffer> {
    const valueName = t.BlzValueId.valueName(t.BlzValueId, valueId);
    logger.debug(`Get ${valueName}`, NS);
    const ret = await this.execCommand("getValue", { valueId });

    if (!this.isSuccessStatus(ret.status)) {
      logger.error(
        formatLogMessage(() => `Command (getValue(${valueName})) returned unexpected state: ${JSON.stringify(ret)}`),
        NS,
      );
      throw new Error(`Failed to get value ${valueName}: status ${ret.status}`);
    }

    // logger.debug(`Got ${valueName} = ${ret.value}`, NS);
    return ret.value;
  }

  async formNetwork(
    extPanId: uint64_t,
    panId: uint16_t,
    channel: uint8_t,
  ): Promise<number> {
    const commandParams = {
      extPanId: extPanId,
      panId: panId,
      channel: channel,
    };

    const v = await this.execCommand("formNetwork", commandParams);
    if (!this.isSuccessStatus(v.status)) {
      const message = `Failure forming network: status ${v.status}`;
      logger.error(message, NS);
      throw new Error(message);
    }

    return v.status;
  }

  public async getVersion(): Promise<void> {
    // Retrieve version info specific to BLZ
    let verInfo = await this.getValue(BlzValueId.BLZ_VALUE_ID_STACK_VERSION);
    // Update parsing logic if necessary
    let build, major, minor, patch;
    [build, verInfo] = uint16_t.deserialize(uint16_t, verInfo);
    [major, verInfo] = uint8_t.deserialize(uint8_t, verInfo);
    [minor, verInfo] = uint8_t.deserialize(uint8_t, verInfo);
    [patch, verInfo] = uint8_t.deserialize(uint8_t, verInfo);
    const vers = `${major}.${minor}.${patch}.${build}`;
    logger.debug(`BLZ version: ${vers}`, NS);
    this.version = {
      product: 1,
      major: `${major}`,
      minor: `${minor}`,
      patch: `${patch} `,
      build: `${build}`,
    };
  }

  public async sendApsData(
    msgType: uint8_t,
    dstShortAddr: uint16_t,
    profileId: uint16_t,
    clusterId: uint16_t,
    srcEp: uint8_t,
    dstEp: uint8_t,
    txOptions: uint8_t,
    radius: uint8_t,
    messageTag: uint32_t,
    payloadLen: uint8_t,
    payload: Bytes,
  ): Promise<BlzStatus> {
    // Construct the request payload inline and send the command
    const frameResponse = await this.execCommand("sendApsData", {
      msgType,
      dstShortAddr,
      profileId,
      clusterId,
      srcEp,
      dstEp,
      txOptions,
      radius,
      messageTag,
      payloadLen,
      payload,
    });

    // Extract and validate the status from the response
    const { status } = frameResponse;

    if (!this.isSuccessStatus(status)) {
      logger.error(`sendApsData() failed with status: ${status}`, NS);
      throw new Error(`Failed to send APS data: status ${status}`);
    }

    logger.debug(
      `sendApsData() succeeded: msgType=${msgType}, dstShortAddr=${dstShortAddr}, clusterId=${clusterId}, payloadLen=${payloadLen}`,
      NS,
    );

    return status; // Return the status of the operation
  }
}
