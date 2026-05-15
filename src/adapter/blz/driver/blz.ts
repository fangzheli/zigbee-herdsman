/* istanbul ignore file */

import { EventEmitter } from "events";

import { Queue, Waitress } from "../../../utils";
import { logger } from "../../../utils/logger";
import { bufferFromBytes } from "../byteUtils";
import { SerialPortOptions } from "../../tstype";
import { CancellableDelay } from "./cancellableDelay";
import { CancellableOperation } from "./cancellableOperation";
import {
  BLZFrameDesc,
  FRAME_NAMES_BY_ID,
  FRAMES,
  ParamsDesc,
} from "./commands";
import * as t from "./types";
import { BlzOutgoingMessageType, BlzStatus } from "./types/named";
import { BlzApsFrame } from "./types/struct";
import { SerialDriver } from "./uart";
import { uint8_t, uint16_t, uint32_t, uint64_t, Bytes, WordList } from "./types";
import { serializeMappedBufferSegments } from "./types/basic";
import { BlzValueId } from "./types/named";

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
const BYTE_FIELD_LENGTHS: Record<string, string> = {
  value: "valueLength",
  payload: "payloadLen",
  message: "messageLength",
};
const WORD_LIST_FIELD_LENGTHS: Record<string, string> = {
  inputClusterList: "inputClusterCount",
  outputClusterList: "outputClusterCount",
};

/**
 * Type-specific for BLZ Frames.
 */
type BLZFrame = {
  sequence: number;
  frameId: number;
  frameName: string;
  payload: BLZFrameData;
};

type BLZWaitressMatcher = {
  // sequence: number | null;
  frameId: number | string;
};

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

export class BLZFrameData {
  _cls_: string;
  _id_: number;
  _isRequest_: boolean;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
  [name: string]: any;

  static createFrame(
    frame_id: number,
    isRequest: boolean,
    params: ParamsDesc | Buffer,
  ): BLZFrameData | undefined {
    const names = FRAME_NAMES_BY_ID[frame_id];
    if (!names) {
      throw new Error(`Unrecognized frame FrameID ${frame_id}`);
    }

    for (const frameName of names) {
      try {
        return new BLZFrameData(frameName, isRequest, params);
      } catch (error) {
        logger.error(`Frame ${frameName} parsing error: ${error}`, NS);
      }
    }

    return undefined;
  }

  static getFrame(name: string): BLZFrameDesc {
    const frameDesc = FRAMES[name];
    if (!frameDesc) throw new Error(`Unrecognized frame from FrameID ${name}`);
    return frameDesc;
  }

  constructor(
    key: string,
    isRequest: boolean,
    params: ParamsDesc | Buffer | undefined,
  ) {
    this._cls_ = key;
    this._id_ = FRAMES[this._cls_].ID;

    this._isRequest_ = isRequest;
    const frame = BLZFrameData.getFrame(key);
    const frameDesc = this._isRequest_
      ? frame.request || {}
      : frame.response || {};
    if (Buffer.isBuffer(params)) {
      let data = params;
      for (const prop of Object.getOwnPropertyNames(frameDesc)) {
        const fieldType = frameDesc[prop];
        const byteLength = getDeclaredByteFieldLength(prop, this);
        if (fieldType === Bytes && byteLength !== undefined) {
          if (data.length < byteLength) {
            throw new RangeError(
              `Byte field ${prop} expected ${byteLength} bytes, received ${data.length}`,
            );
          }

          [this[prop]] = fieldType.deserialize(
            fieldType,
            data.subarray(0, byteLength),
          );
          data = data.subarray(byteLength);
        } else if (fieldType === WordList) {
          const itemCount = getDeclaredWordListItemCount(prop, this);
          if (itemCount !== undefined) {
            [this[prop], data] = deserializeCountedWordList(
              prop,
              itemCount,
              data,
            );
          } else {
            [this[prop], data] = fieldType.deserialize(fieldType, data);
          }
        } else {
          [this[prop], data] = fieldType.deserialize(fieldType, data);
        }
      }

      if (data.length > 0) {
        throw new RangeError(
          `Unexpected trailing data after ${key} frame: ${data.length} bytes`,
        );
      }
    } else {
      for (const prop of Object.getOwnPropertyNames(frameDesc)) {
        this[prop] = params![prop];
      }
    }
  }

  serialize(): Buffer {
    const frame = BLZFrameData.getFrame(this._cls_);
    const frameDesc = this._isRequest_
      ? frame.request || {}
      : frame.response || {};
    return serializeFrameFields(frameDesc, this);
  }

  get name(): string {
    return this._cls_;
  }

  toJSON(): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const key of Object.keys(this)) {
      const value = (this as Record<string, unknown>)[key];
      result[key] =
        typeof value === "bigint" ? `0x${value.toString(16)}` : value;
    }

    return result;
  }

  get id(): number {
    return this._id_;
  }
}

function serializeFrameFields(
  frameDesc: ParamsDesc,
  values: Record<string, unknown>,
): Buffer {
  const fields = Object.getOwnPropertyNames(frameDesc);
  return serializeMappedBufferSegments(fields, (prop) => {
    validateDeclaredFieldLength(prop, values);
    return frameDesc[prop].serialize(frameDesc[prop], values[prop]);
  });
}

function validateDeclaredFieldLength(
  fieldName: string,
  values: Record<string, unknown>,
): void {
  const byteLength = getDeclaredByteFieldLength(fieldName, values);
  if (byteLength !== undefined) {
    const value = values[fieldName] as ArrayLike<number> | undefined;
    const actualLength = value?.length ?? 0;
    if (actualLength !== byteLength) {
      throw new RangeError(
        `Byte field ${fieldName} expected ${byteLength} bytes, received ${actualLength}`,
      );
    }
  }

  const itemCount = getDeclaredWordListItemCount(fieldName, values);
  if (itemCount !== undefined) {
    const value = values[fieldName] as ArrayLike<number> | undefined;
    const actualCount = value?.length ?? 0;
    if (actualCount !== itemCount) {
      throw new RangeError(
        `WordList field ${fieldName} expected ${itemCount} items, received ${actualCount}`,
      );
    }
  }
}

function getDeclaredByteFieldLength(
  fieldName: string,
  values: Record<string, unknown>,
): number | undefined {
  const lengthField = BYTE_FIELD_LENGTHS[fieldName];
  if (lengthField === undefined) {
    return undefined;
  }

  const value = values[lengthField];
  return typeof value === "number" ? value : undefined;
}

function getDeclaredWordListItemCount(
  fieldName: string,
  values: Record<string, unknown>,
): number | undefined {
  const lengthField = WORD_LIST_FIELD_LENGTHS[fieldName];
  if (lengthField === undefined) {
    return undefined;
  }

  const value = values[lengthField];
  return typeof value === "number" ? value : undefined;
}

function deserializeCountedWordList(
  fieldName: string,
  itemCount: number,
  data: Buffer,
): [number[], Buffer] {
  const byteLength = itemCount * 2;
  if (data.length < byteLength) {
    throw new RangeError(
      `WordList field ${fieldName} expected ${itemCount} items (${byteLength} bytes), received ${data.length} bytes`,
    );
  }

  const [values] = WordList.deserialize(
    WordList,
    data.subarray(0, byteLength),
  );

  return [values, data.subarray(byteLength)];
}

export class Blz extends EventEmitter {
  private serialDriver: SerialDriver;
  private waitress: Waitress<BLZFrame, BLZWaitressMatcher>;
  private queue: Queue;
  private watchdogTimer?: NodeJS.Timeout;
  private failures = 0;
  private inResetingProcess = false;
  private connectGeneration = 0;
  private connectPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private emitCloseWhenCloseCompletes = false;
  private watchdogGeneration = 0;
  private watchdogPromise?: Promise<void>;
  private readonly connectRetryDelay = new CancellableDelay();
  private readonly connectOperations = new CancellableOperation();
  private readonly connectResetOperations = new CancellableOperation();
  private serialDriverEventBridgeAttached = false;
  private readonly onSerialResetHandler = this.onSerialReset.bind(this);
  private readonly onSerialCloseHandler = this.onSerialClose.bind(this);
  private readonly onFrameReceivedHandler = this.onFrameReceived.bind(this);
  private readonly watchdogHandlerRef = this.watchdogHandler.bind(this);
  private version: BlzVersion;

  constructor() {
    super();
    this.queue = new Queue();
    this.waitress = new Waitress<BLZFrame, BLZWaitressMatcher>(
      this.waitressValidator,
      this.waitressTimeoutFormatter,
    );

    this.serialDriver = new SerialDriver();
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
        const reconnectError = new Error("Connection closed");
        this.clearWatchdogTimer();
        this.clearPendingCommands(reconnectError);
        await this.runConnectOperation(
          () => this.serialDriver.close(false),
          connectGeneration,
        );
      }

      const resetForReconnect = (): void => {
        this.cancelConnectResetOperations(new Error("Failure to connect"));
      };
      this.attachConnectResetListener(resetForReconnect);

      try {
        await this.connectWithRetries(options, connectGeneration);
      } finally {
        this.detachConnectResetListener(resetForReconnect);
      }

      this.inResetingProcess = false;
      this.failures = 0;
      this.attachSerialDriverResetListener();
      this.startWatchdogTimer();
      connectionEstablished = true;

      logger.debug("Connection established successfully", NS);
    } catch (error) {
      if (!connectionEstablished) {
        this.detachSerialDriverEventBridge();
      }
      throw error;
    }
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
          throw new Error("Connection cancelled by close");
        }

        // Verify connection is actually established
        if (this.serialDriver.isInitialized()) {
          return;
        }

        throw new Error("Driver reported connection but is not initialized");
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.error(
          `Connection attempt ${i} failed: ${lastError.message}`,
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
            throw new Error("Connection cancelled by close");
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

  private async runSerialConnectAttempt(
    options: SerialPortOptions,
    connectGeneration: number,
  ): Promise<void> {
    await this.runConnectOperation(
      () =>
        this.connectResetOperations.run(
          () => this.serialDriver.connect(options),
          () => !this.isConnectCancelled(connectGeneration),
          () => new Error("Connection cancelled by close"),
        ),
      connectGeneration,
    );
  }

  private async cleanupFailedConnectAttempt(
    connectGeneration: number,
  ): Promise<void> {
    const connectFailureError = new Error("Failure to connect");
    this.clearWatchdogTimer();
    this.clearPendingCommands(connectFailureError);

    try {
      await this.runConnectOperation(
        () => this.serialDriver.close(false),
        connectGeneration,
      );
    } catch (error) {
      if (this.isConnectCancelled(connectGeneration)) {
        throw error;
      }

      logger.debug(`Failed to close serial driver after connect failure: ${error}`, NS);
    }
  }

  private isConnectCancelled(connectGeneration: number): boolean {
    return this.connectGeneration !== connectGeneration;
  }

  private throwIfConnectionChanged(connectGeneration: number): void {
    if (this.isConnectCancelled(connectGeneration)) {
      throw new Error("Connection closed");
    }
  }

  private async runConnectOperation<T>(
    operation: () => Promise<T>,
    connectGeneration: number,
  ): Promise<T> {
    return await this.connectOperations.run(
      operation,
      () => !this.isConnectCancelled(connectGeneration),
      () => new Error("Connection cancelled by close"),
    );
  }

  private async waitForConnectRetry(
    milliseconds: number,
    connectGeneration: number,
  ): Promise<boolean> {
    return await this.connectRetryDelay.wait(
      milliseconds,
      () => !this.isConnectCancelled(connectGeneration),
    );
  }

  private clearWatchdogTimer(): void {
    this.watchdogGeneration += 1;
    this.watchdogPromise = undefined;
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  private startWatchdogTimer(): void {
    this.clearWatchdogTimer();

    if (WATCHDOG_WAKE_PERIOD) {
      this.watchdogTimer = setInterval(
        this.watchdogHandlerRef,
        WATCHDOG_WAKE_PERIOD * 1000,
      );
    }
  }

  private attachSerialDriverEventBridge(): void {
    if (this.serialDriverEventBridgeAttached) {
      return;
    }

    this.serialDriver.on("received", this.onFrameReceivedHandler);
    this.serialDriver.on("close", this.onSerialCloseHandler);
    this.serialDriverEventBridgeAttached = true;
  }

  private attachSerialDriverResetListener(): void {
    this.detachSerialDriverResetListener();
    this.serialDriver.on("reset", this.onSerialResetHandler);
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

    this.serialDriver.off("received", this.onFrameReceivedHandler);
    this.serialDriver.off("close", this.onSerialCloseHandler);
    this.serialDriverEventBridgeAttached = false;
  }

  private detachSerialDriverResetListener(): void {
    this.serialDriver.off("reset", this.onSerialResetHandler);
  }

  private detachSerialDriverListeners(): void {
    this.detachSerialDriverEventBridge();
    this.detachSerialDriverResetListener();
  }

  public isInitialized(): boolean {
    return this.serialDriver?.isInitialized();
  }

  private onSerialReset(): void {
    logger.debug("onSerialReset()", NS);
    this.inResetingProcess = true;
    this.cleanupSerialState(new Error("Connection reset"));
    this.emit("reset");
  }

  private onSerialClose(): void {
    logger.debug("onSerialClose()", NS);
    this.cleanupSerialState(new Error("Connection closed"));

    if (!this.inResetingProcess) {
      this.emit("close");
    }
  }

  private cancelConnectionOperations(error: Error): void {
    this.connectGeneration += 1;
    this.connectOperations.cancel(error);
    this.cancelConnectResetOperations(error);
    this.connectRetryDelay.cancel();
    this.clearWatchdogTimer();
  }

  private cancelConnectResetOperations(error: Error): void {
    this.connectResetOperations.cancel(error);
  }

  private clearPendingCommands(error: Error): void {
    this.queue.clear(error);
    this.waitress.clear(error);
  }

  private cleanupSerialState(error: Error): void {
    this.cancelConnectionOperations(error);
    this.clearPendingCommands(error);
    this.detachSerialDriverListeners();
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

    const connectionCancelError = new Error("Connection cancelled by close");
    this.cancelConnectionOperations(connectionCancelError);
    const closeError = new Error("Connection closed");
    this.clearPendingCommands(closeError);
    this.detachSerialDriverListeners();
    try {
      await this.serialDriver.close(emitClose);
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
    this.throwIfConnectionChanged(resetConnectGeneration);
    const resetError = new Error("Connection reset");
    this.clearPendingCommands(resetError);
    this.throwIfConnectionChanged(resetConnectGeneration);

    try {
      await this.serialDriver.reset();
      this.throwIfConnectionChanged(resetConnectGeneration);
      logger.debug("Direct UART reset sent successfully", NS);
      if (!holdResetState) {
        this.inResetingProcess = wasResetingProcess;
      }
    } catch (error) {
      this.inResetingProcess = wasResetingProcess;
      logger.error(`Direct UART reset failed: ${error}`, NS);
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
      logger.error(`Failed to parse BLZ frame 0x${frameId.toString(16)}: ${error}`, NS);
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

    const handled = this.waitress.resolve({
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
        const waiter = name === "reset" ? undefined : this.waitFor(name);
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
          this.cancelWaiter(waiter);
          this.throwIfConnectionChanged(commandConnectGeneration);
          throw new Error(`Failure send ${name}:` + JSON.stringify(data), {
            cause: error,
          });
        }
      },
    );
  }

  async networkInit(): Promise<boolean> {
    // logger.debug('Set up stack status handler before initial the network', NS);
    const result = await this.execCommand("networkInit");
    logger.debug(() => `Network init result: ${JSON.stringify(result)}`, NS);
    if (result.status !== BlzStatus.SUCCESS) {
      logger.error("Failure to init network", NS);
      return false;
    }
    return result.status == BlzStatus.SUCCESS;
  }

  async leaveNetwork(): Promise<number> {
    const result = await this.execCommand("leaveNetwork");
    logger.debug(() => `Network leave result: ${JSON.stringify(result)}`, NS);

    if (result.status !== BlzStatus.SUCCESS) {
      logger.debug("Failure to leave network", NS);
      throw new Error("Failure to leave network: " + JSON.stringify(result));
    }

    return result.status;
  }

  async setValue(
    valueId: t.BlzValueId,
    value: number | Buffer,
  ): Promise<BLZFrameData> {
    const valueName = t.BlzValueId.valueName(t.BlzValueId, valueId);
    logger.debug(`Set ${valueName} = ${value}`, NS);

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

    if (ret.status !== BlzStatus.SUCCESS) {
      logger.error(
        `Command (setValue(${valueName}, ${value})) returned unexpected state: ${JSON.stringify(ret)}`,
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

    if (ret.status !== BlzStatus.SUCCESS) {
      logger.error(
        `Command (getValue(${valueName})) returned unexpected state: ${JSON.stringify(ret)}`,
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
    if (v.status !== BlzStatus.SUCCESS) {
      logger.error("Failure forming network: " + JSON.stringify(v), NS);
      throw new Error("Failure forming network: " + JSON.stringify(v));
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

    if (status !== BlzStatus.SUCCESS) {
      logger.error(`sendApsData() failed with status: ${status}`, NS);
      throw new Error(`Failed to send APS data: status ${status}`);
    }

    logger.debug(
      `sendApsData() succeeded: msgType=${msgType}, dstShortAddr=${dstShortAddr}, clusterId=${clusterId}, payloadLen=${payloadLen}`,
      NS,
    );

    return status; // Return the status of the operation
  }

  private waitFor(
    frameId: string | number,
    timeout = 10000,
  ): { start: () => { promise: Promise<BLZFrame>; ID: number }; ID: number } {
    return this.waitress.waitFor({ frameId }, timeout);
  }

  private cancelWaiter(waiter: ReturnType<typeof this.waitFor> | undefined): void {
    if (waiter) {
      this.waitress.remove(waiter.ID);
    }
  }

  private waitressTimeoutFormatter(
    matcher: BLZWaitressMatcher,
    timeout: number,
  ): string {
    return `${JSON.stringify(matcher)} after ${timeout}ms`;
  }

  private waitressValidator(
    payload: BLZFrame,
    matcher: BLZWaitressMatcher,
  ): boolean {
    if (typeof matcher.frameId === "string") {
      return payload.frameName === matcher.frameId;
    }

    const frameNames = FRAME_NAMES_BY_ID[matcher.frameId];
    return frameNames ? frameNames.includes(payload.frameName) : false;
  }

  private async watchdogHandler(): Promise<void> {
    if (this.watchdogPromise) {
      logger.debug("Watchdog heartbeat already in progress", NS);
      return;
    }

    const watchdogPromise = this.performWatchdogHeartbeat();
    this.watchdogPromise = watchdogPromise;

    try {
      await watchdogPromise;
    } finally {
      if (this.watchdogPromise === watchdogPromise) {
        this.watchdogPromise = undefined;
      }
    }
  }

  private async performWatchdogHeartbeat(): Promise<void> {
    const watchdogGeneration = this.watchdogGeneration;
    logger.debug(`Time to watchdog ... ${this.failures}`, NS);

    if (this.inResetingProcess) {
      logger.debug("The reset process is in progress...", NS);
      return;
    }

    try {
      await this.getVersion();
      if (watchdogGeneration !== this.watchdogGeneration) {
        return;
      }
      this.failures = 0;
    } catch (error) {
      if (watchdogGeneration !== this.watchdogGeneration) {
        return;
      }
      logger.error(`Watchdog heartbeat timeout ${error}`, NS);

      if (!this.inResetingProcess) {
        this.failures += 1;

        if (this.failures > MAX_WATCHDOG_FAILURES) {
          this.failures = 0;

          this.emit("reset");
        }
      }
    }
  }
}
