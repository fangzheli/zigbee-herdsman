/* istanbul ignore file */

import { EventEmitter } from "events";
import net from "net";

import { Queue } from "../../../utils";
import { logger } from "../../../utils/logger";
import { SerialPort } from "../../serialPort";
import { isTcpPath, parseTcpPath } from "../../utils";
import { SerialPortOptions } from "../../tstype";
import {
  attachListenersOrRollback,
  detachListeners,
  type OwnedEventListener,
} from "../eventListeners";
import {
  runAsyncCleanupSteps,
  runCleanupSteps,
} from "../lifecycleCleanup";
import { CancellableDelay } from "./cancellableDelay";
import { CancellableOperation } from "./cancellableOperation";
import { Frame } from "./frame";
import { Parser } from "./parser";
import { Writer } from "./writer";
import { FRAMES } from "./commands";
import {
  UartFrameWaiters,
  type UartFrameWaiter,
} from "./uartFrameWaiters";

const NS = "zh:blz:uart";

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    try {
      return error.message;
    } catch {
      // Fall through to the generic stringifier below.
    }
  }

  try {
    return String(error);
  } catch {
    return "<unprintable error>";
  }
}

function errorFromUnknown(error: unknown): Error {
  if (error instanceof Error) {
    try {
      void error.message;
      return error;
    } catch {
      return new Error(formatErrorMessage(error), { cause: error });
    }
  }

  return new Error(formatErrorMessage(error), { cause: error });
}

export class SerialDriver extends EventEmitter {
  private serialPort?: SerialPort;
  private socketPort?: net.Socket;
  private writer: Writer;
  private parser: Parser;
  private initialized: boolean;
  private sendSeq = 0; // next frame number to send
  private recvSeq = 0; // next frame number to receive
  private readonly frameWaiters = new UartFrameWaiters();
  private queue: Queue;
  private operationGeneration = 0;
  private readonly sendRetryDelay = new CancellableDelay();
  private connectPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private emitCloseWhenCloseCompletes = false;
  private readonly onParsedHandler = this.onParsed.bind(this);
  private readonly onPortCloseHandler = this.onPortClose.bind(this);
  private readonly onPortErrorHandler = this.onPortError.bind(this);
  private readonly runtimePortListenerRegistrations: readonly OwnedEventListener[] =
    [
      { event: "close", listener: this.onPortCloseHandler, once: true },
      { event: "error", listener: this.onPortErrorHandler },
    ];
  private readonly connectOperations = new CancellableOperation();
  private detachSocketListeners?: () => void;

  constructor() {
    super();
    this.initialized = false;
    this.queue = new Queue(1);
    this.writer = new Writer();
    this.parser = new Parser();
  }

  public async connect(options: SerialPortOptions): Promise<void> {
    if (this.connectPromise) {
      logger.debug("UART connect already in progress.", NS);
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
    if (this.serialPort || this.socketPort || this.initialized) {
      await this.close(false);
    }

    if (isTcpPath(options.path!)) {
      await this.openSocketPort(options.path!);
    } else {
      await this.openSerialPort(
        options.path!,
        options.baudRate!,
        options.rtscts!,
      );
    }
  }

  private async openSerialPort(
    path: string,
    baudRate: number,
    rtscts: boolean,
  ): Promise<void> {
    const options = {
      path,
      baudRate: typeof baudRate === "number" ? baudRate : 2000000,
      rtscts: typeof rtscts === "boolean" ? rtscts : false,
      autoOpen: false,
      parity: "none",
      stopBits: 1,
      xon: false,
      xoff: false,
    } as const;

    logger.debug(() => `Opening SerialPort with ${JSON.stringify(options)}`, NS);
    this.serialPort = new SerialPort(options);
    const serialPort = this.serialPort;

    try {
      this.attachParserToPort(serialPort);
    } catch (error) {
      this.cleanupFailedOpenPort(serialPort);
      throw error;
    }

    try {
      await this.connectOperations.run(
        () => serialPort.asyncOpen(),
        () => this.serialPort === serialPort,
        () => this.createConnectionClosedError(),
      );

      if (this.serialPort !== serialPort) {
        throw this.createConnectionClosedError();
      }

      logger.debug("Serialport opened", NS);

      this.attachRuntimePortListeners(serialPort);

      // reset
      // await this.reset();

      this.initialized = true;
    } catch (error) {
      if (!this.initialized) {
        this.cleanupFailedOpenPort(serialPort);
      }

      throw error;
    }
  }

  private async openSocketPort(path: string): Promise<void> {
    const info = parseTcpPath(path);
    logger.debug(`Opening TCP socket with ${info.host}:${info.port}`, NS);

    this.socketPort = new net.Socket();
    const socketPort = this.socketPort!;
    try {
      socketPort.setNoDelay(true);
      socketPort.setKeepAlive(true, 15000);
      this.attachParserToPort(socketPort);
    } catch (error) {
      this.cleanupFailedOpenPort(socketPort);
      throw error;
    }

    let settled = false;

    const openSocket = (): Promise<void> =>
      new Promise<void>((resolve, reject): void => {
        let readyStarted = false;
        const openError = (err: Error): void => {
          if (settled) {
            return;
          }

          settled = true;
          try {
            this.cleanupFailedOpenPort(socketPort);
          } catch (cleanupError) {
            reject(new AggregateError([err, cleanupError], "Failed to open TCP socket and cleanup failed"));
            return;
          }

          reject(err);
        };
        const openClose = (): void => {
          openError(new Error("Socket closed before ready"));
        };
        const onConnect = (): void => {
          logger.debug("Socket connected", NS);
        };
        const handleSocketReady = async (): Promise<void> => {
          if (settled || readyStarted) {
            return;
          }

          readyStarted = true;
          logger.debug("Socket ready", NS);
          socketPort.off("ready", onReady);

          try {
            // reset
            await this.runSocketReadyReset(socketPort);
          } catch (error) {
            openError(errorFromUnknown(error));
            return;
          }

          if (settled || this.socketPort !== socketPort) {
            openError(this.createConnectionClosedError());
            return;
          }

          detachOpenListeners();
          this.attachRuntimePortListeners(socketPort);
          this.detachSocketListeners = detachRuntimeListeners;

          settled = true;
          this.initialized = true;

          resolve();
        };
        const onReady = (): void => {
          void handleSocketReady().catch((error) => {
            openError(errorFromUnknown(error));
          });
        };
        const detachOpenListeners = (): void => {
          this.detachSocketOpenListeners(
            socketPort,
            onConnect,
            onReady,
            openError,
            openClose,
          );
        };
        const detachRuntimeListeners = (): void => {
          this.detachRuntimePortListeners(socketPort);
        };
        this.detachSocketListeners = (): void => {
          detachOpenListeners();
          detachRuntimeListeners();
        };
        this.attachSocketOpenListeners(
          socketPort,
          onConnect,
          onReady,
          openError,
          openClose,
        );

        socketPort.connect(info.port, info.host);
      });

    try {
      await this.connectOperations.run(
        openSocket,
        () => this.socketPort === socketPort,
        () => this.createConnectionClosedError(),
      );
    } catch (error) {
      if (!settled) {
        settled = true;
        this.cleanupFailedOpenPort(socketPort);
      }

      throw error;
    }
  }

  private async runSocketReadyReset(port: net.Socket): Promise<void> {
    await this.connectOperations.run(
      () => this.reset(),
      () => this.socketPort === port,
      () => this.createConnectionClosedError(),
    );
  }

  private onParsed(frame: Frame): void {
    try {
      frame.checkCRC();
      const frmNum = frame.sequence & 0x0f;
      const reTx = frame.control & 0x01;

      this.recvSeq = (frmNum + 1) & 0x0f;
      logger.debug(() => `<-- Frame (${frmNum}, ${reTx}): ${frame}`, NS);

      switch (frame.frameId) {
        case 0x0001:
          this.handleACK(frame);
          break;
        case 0x0002:
          this.handleError(frame);
          break;
        case 0x0003:
          this.handleReset(frame);
          break;
        case 0x0004:
          this.handleResetAck(frame);
          break;
        default:
          this.handleDATA(frame);
      }
    } catch (error) {
      logger.error(() => `Error parsing frame: ${error}`, NS);
    }
  }

  private handleDATA(frame: Frame): void {
    // // Log frame immediately before any processing
    // logger.debug(`<-- Processed FRAME (${frame.frameId.toString(16)}): ${frame}`, NS);

    // // Special handling for APS indication frames
    // if (frame.frameId === 0x0082) { // APS indication
    //     this.emit('apsIndication', frame.buffer);
    //     this.writer.sendACK(frame.sequence & 0x07);
    //     return;
    // }

    const handled = this.frameWaiters.resolve(frame.frameId);
    if (!handled) {
      logger.debug(`Unsolicited frame ID ${frame.frameId.toString(16)}`, NS);
    }

    this.writer.sendACK(frame.sequence & 0x07);
    this.emit("received", frame.buffer);
  }

  private handleACK(frame: Frame): void {
    const ackSeq = (frame.control & 0x70) >> 4;
    const handled = this.frameWaiters.resolve(frame.frameId);
    if (!handled) {
      logger.debug(`Unexpected packet sequence ${ackSeq} `, NS);
    } else {
      logger.debug(() => `<-- ACK (${ackSeq}): ${frame}`, NS);
    }
  }

  private handleResetAck(frame: Frame): void {
    logger.debug(() => `<-- RESET_ACK: ${frame}`, NS);
    // this.frameWaiters.resolve(-1);
  }

  private handleError(frame: Frame): void {
    logger.error(`<-- Error: NCP is in error state`, NS);
    this.handleResetFrame();
  }

  async reset(): Promise<void> {
    this.parser.reset();
    this.throwIfClosing();
    this.cancelPendingOperations(this.createConnectionResetError());
    this.sendSeq = 0;
    this.recvSeq = 0;

    return this.queue.execute(async () => {
      this.throwIfClosing();
      try {
        logger.debug(
          `UART reset: sending reset frame with seq=${this.sendSeq}, ackSeq=${this.recvSeq}`,
          NS,
        );
        this.writer.sendReset(this.sendSeq, this.recvSeq);
        logger.debug("UART reset frame sent successfully", NS);
      } catch (e) {
        const errorMessage = formatErrorMessage(e);
        logger.error(() => `Reset failed: ${errorMessage}`, NS);
        this.emit("reset");
        throw new Error(`Reset error: ${errorMessage}`);
      }
    });
  }

  private throwIfClosing(): void {
    if (this.closePromise) {
      throw this.createConnectionClosedError();
    }
  }

  private handleReset(frame: Frame): void {
    logger.warning(() => `<-- RST:  ${frame}`, NS);
    this.handleResetFrame();
  }

  private handleResetFrame(): void {
    const resetError = this.createConnectionResetError();
    this.cleanupPortEvent(resetError);
    this.emit("reset");
  }

  public async close(emitClose: boolean): Promise<void> {
    if (emitClose) {
      this.emitCloseWhenCloseCompletes = true;
    }

    if (this.closePromise) {
      logger.debug("UART close already in progress.", NS);
      return await this.closePromise;
    }

    const closePromise = this.performClose().finally(() => {
      if (this.closePromise === closePromise) {
        this.closePromise = undefined;
        this.emitCloseWhenCloseCompletes = false;
      }
    });
    this.closePromise = closePromise;

    return await closePromise;
  }

  private async performClose(): Promise<void> {
    logger.debug("Closing UART", NS);
    const closeError = this.createConnectionClosedError();
    this.cancelConnectOperations(closeError);
    const wasInitialized = this.initialized;
    const serialPort = this.serialPort;
    try {
      await runAsyncCleanupSteps([
        () => {
          this.enterClosedState(closeError);
        },
        async () => {
          await this.closeActivePort(wasInitialized, serialPort);
        },
      ]);
    } catch (error) {
      this.emitCloseIfRequested();
      throw error;
    }

    this.emitCloseIfRequested();
  }

  private emitCloseIfRequested(): void {
    if (this.emitCloseWhenCloseCompletes) {
      this.emit("close");
    }
  }

  private async closeActivePort(
    wasInitialized: boolean,
    serialPort: SerialPort | undefined,
  ): Promise<void> {
    if (serialPort) {
      await this.closeSerialPort(wasInitialized, serialPort);
    } else if (this.socketPort) {
      this.destroyActivePortAfterCloseFailure("socket", true);
    }
  }

  private async closeSerialPort(
    wasInitialized: boolean,
    serialPort: SerialPort,
  ): Promise<void> {
    try {
      await runAsyncCleanupSteps([
        () => {
          this.detachSerialPort();
        },
        async () => {
          if (wasInitialized && serialPort.isOpen) {
            await serialPort.asyncFlushAndClose();
          } else {
            this.destroyActivePort();
          }
        },
      ]);
    } catch (error) {
      this.destroyActivePortAfterCloseFailure("serial", false);
      throw error;
    } finally {
      if (this.serialPort === serialPort) {
        this.serialPort = undefined;
      }
    }
  }

  private destroyActivePortAfterCloseFailure(
    portType: "serial" | "socket",
    rethrow: boolean,
  ): void {
    try {
      this.destroyActivePort();
    } catch (destroyError) {
      logger.debug(
        () => `Failed to destroy ${portType} port after close failure: ${formatErrorMessage(destroyError)}`,
        NS,
      );

      if (rethrow) {
        throw destroyError;
      }
    }
  }

  private cleanupParser(): void {
    this.parser.off("parsed", this.onParsedHandler);
    this.parser.reset();
  }

  private attachParserToPort(port: SerialPort | net.Socket): void {
    this.writer.pipe(port);
    port.pipe(this.parser);
    this.parser.on("parsed", this.onParsedHandler);
  }

  private cleanupFailedOpenPort(port: SerialPort | net.Socket): void {
    if (this.serialPort !== port && this.socketPort !== port) {
      return;
    }

    this.initialized = false;
    runCleanupSteps([
      () => {
        this.cleanupParser();
      },
      () => {
        this.destroyActivePort();
      },
    ]);
  }

  private attachRuntimePortListeners(port: SerialPort | net.Socket): void {
    attachListenersOrRollback(port, this.runtimePortListenerRegistrations);
  }

  private detachRuntimePortListeners(port: SerialPort | net.Socket): void {
    detachListeners(port, this.runtimePortListenerRegistrations);
  }

  private attachSocketOpenListeners(
    port: net.Socket,
    onConnect: () => void,
    onReady: () => void,
    onError: (error: Error) => void,
    onClose: () => void,
  ): void {
    attachListenersOrRollback(
      port,
      this.socketOpenListenerRegistrations(
        onConnect,
        onReady,
        onError,
        onClose,
      ),
    );
  }

  private detachSocketOpenListeners(
    port: net.Socket,
    onConnect: () => void,
    onReady: () => void,
    onError: (error: Error) => void,
    onClose: () => void,
  ): void {
    detachListeners(
      port,
      this.socketOpenListenerRegistrations(
        onConnect,
        onReady,
        onError,
        onClose,
      ),
    );
  }

  private socketOpenListenerRegistrations(
    onConnect: () => void,
    onReady: () => void,
    onError: (error: Error) => void,
    onClose: () => void,
  ): readonly OwnedEventListener[] {
    return [
      { event: "connect", listener: onConnect },
      { event: "ready", listener: onReady },
      { event: "error", listener: onError, once: true },
      { event: "close", listener: onClose, once: true },
    ];
  }

  private cancelPendingOperations(error: Error): void {
    this.operationGeneration += 1;
    this.cancelSendRetryDelay();
    this.queue.clear(error);
    this.frameWaiters.clear(error);
  }

  private cancelSendRetryDelay(): void {
    this.sendRetryDelay.cancel();
  }

  private cancelConnectOperations(error: Error): void {
    this.connectOperations.cancel(error);
  }

  private createConnectionClosedError(): Error {
    return new Error("Connection closed");
  }

  private createConnectionResetError(): Error {
    return new Error("Connection reset");
  }

  private createPortCloseError(err: boolean | Error): Error {
    return err != null && err !== false
      ? this.createConnectionResetError()
      : this.createConnectionClosedError();
  }

  private createSendCancelledError(cause?: unknown): Error {
    const error = new Error("Send cancelled by driver reset or close");
    if (cause !== undefined) {
      error.cause = cause;
    }

    return error;
  }

  private enterClosedState(error: Error): void {
    this.initialized = false;
    runCleanupSteps([
      () => {
        this.cancelPendingOperations(error);
      },
      () => {
        this.cleanupParser();
      },
    ]);
  }

  private cleanupPortEvent(error: Error): void {
    try {
      runCleanupSteps([
        () => {
          this.enterClosedState(error);
        },
        () => {
          this.destroyActivePort();
        },
      ]);
    } catch (cleanupError) {
      logger.debug(
        () => `Failed to cleanup UART port event: ${formatErrorMessage(cleanupError)}`,
        NS,
      );
    }
  }

  private detachSerialPort(): void {
    const serialPort = this.serialPort;
    if (!serialPort) {
      return;
    }

    runCleanupSteps([
      () => {
        this.writer.unpipe(serialPort);
      },
      () => {
        serialPort.unpipe(this.parser);
      },
      () => {
        this.detachRuntimePortListeners(serialPort);
      },
    ]);
  }

  private detachSocketPort(): void {
    const socketPort = this.socketPort;
    if (!socketPort) {
      return;
    }

    runCleanupSteps([
      () => {
        this.writer.unpipe(socketPort);
      },
      () => {
        socketPort.unpipe(this.parser);
      },
      () => {
        this.detachSocketListeners?.();
        this.detachSocketListeners = undefined;
      },
    ]);
  }

  private destroyActivePort(): void {
    if (this.serialPort) {
      const serialPort = this.serialPort;
      try {
        this.detachSerialPort();
      } finally {
        serialPort.destroy();
        this.serialPort = undefined;
      }
      return;
    }

    if (this.socketPort) {
      const socketPort = this.socketPort;
      try {
        this.detachSocketPort();
      } finally {
        socketPort.destroy();
        this.socketPort = undefined;
      }
    }
  }

  private onPortError(error: Error): void {
    logger.error(() => `Port error: ${error}`, NS);
  }

  private onPortClose(err: boolean | Error): void {
    logger.debug(() => `Port closed. Error? ${err}`, NS);
    const closeError = this.createPortCloseError(err);
    this.cleanupPortEvent(closeError);

    if (err != null && err !== false) {
      this.emit("reset");
    } else {
      this.emit("close");
    }
  }

  public isInitialized(): boolean {
    return this.initialized;
  }

  public async sendDATA(
    data: Buffer,
    frameId: number,
    retries = 2,
  ): Promise<void> {
    try {
      return await this.queue.execute(() =>
        this.sendDATAInternal(data, frameId, retries),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "Connection reset" ||
          error.message === "Connection closed")
      ) {
        throw this.createSendCancelledError(error);
      }

      throw error;
    }
  }

  private async sendDATAInternal(
    data: Buffer,
    frameId: number,
    retries: number,
  ): Promise<void> {
    const seq = this.sendSeq;
    const ackSeq = this.recvSeq;
    const generation = this.operationGeneration;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (!this.isOperationGenerationActive(generation)) {
        throw this.createSendCancelledError();
      }

      const isRetransmission = attempt > 0;
      const waiter: UartFrameWaiter | undefined =
        frameId === FRAMES.reset.ID
          ? undefined
          : this.frameWaiters.waitFor(frameId, 1000); // 1 second timeout per attempt

      try {
        this.writer.sendData(
          data,
          seq,
          ackSeq,
          frameId,
          isRetransmission,
          false,
        );
        this.sendSeq = (seq + 1) & 0x0f;

        // Don't wait for response if this is a reset command
        if (waiter) {
          await waiter.start().promise;
        }
        return;
      } catch (e) {
        this.frameWaiters.cancel(waiter);
        logger.error(
          () =>
            `Attempt ${attempt + 1} failed for seq ${seq}: ${formatErrorMessage(e)}`,
          NS,
        );

        if (!this.isOperationGenerationActive(generation)) {
          throw this.createSendCancelledError();
        }

        if (attempt === retries) {
          logger.error(`All retries failed for seq ${seq}.`, NS);
          throw new Error(`Failed to send data after ${retries} retries`);
        }

        // Wait before retry
        const continueRetry = await this.waitForSendRetry(1000, generation);

        if (!continueRetry) {
          throw this.createSendCancelledError();
        }
      }
    }
  }

  private async waitForSendRetry(
    milliseconds: number,
    generation: number,
  ): Promise<boolean> {
    return await this.sendRetryDelay.wait(
      milliseconds,
      () => this.isOperationGenerationActive(generation),
    );
  }

  private isOperationGenerationActive(generation: number): boolean {
    return this.operationGeneration === generation && this.initialized;
  }
}
