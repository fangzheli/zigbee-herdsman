/* istanbul ignore file */

import { EventEmitter } from "events";
import net from "net";

import { Queue, Waitress } from "../../../utils";
import { logger } from "../../../utils/logger";
import { SerialPort } from "../../serialPort";
import { isTcpPath, parseTcpPath } from "../../utils";
import { SerialPortOptions } from "../../tstype";
import { CancellableDelay } from "./cancellableDelay";
import { CancellableOperation } from "./cancellableOperation";
import { Frame } from "./frame";
import { Parser } from "./parser";
import { Writer } from "./writer";
import { FRAMES } from "./commands";

const NS = "zh:blz:uart";

type BLZPacket = {
  frameId: number;
};

type BLZPacketMatcher = {
  frameId: number;
};

export class SerialDriver extends EventEmitter {
  private serialPort?: SerialPort;
  private socketPort?: net.Socket;
  private writer: Writer;
  private parser: Parser;
  private initialized: boolean;
  private sendSeq = 0; // next frame number to send
  private recvSeq = 0; // next frame number to receive
  private waitress: Waitress<BLZPacket, BLZPacketMatcher>;
  private queue: Queue;
  private operationGeneration = 0;
  private readonly sendRetryDelay = new CancellableDelay();
  private connectPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private emitCloseWhenCloseCompletes = false;
  private readonly onParsedHandler = this.onParsed.bind(this);
  private readonly onPortCloseHandler = this.onPortClose.bind(this);
  private readonly onPortErrorHandler = this.onPortError.bind(this);
  private readonly connectOperations = new CancellableOperation();
  private detachSocketListeners?: () => void;

  constructor() {
    super();
    this.initialized = false;
    this.queue = new Queue(1);
    this.waitress = new Waitress<BLZPacket, BLZPacketMatcher>(
      this.waitressValidator,
      this.waitressTimeoutFormatter,
    );
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

    this.attachParserToPort(serialPort);

    let opened = false;
    const cleanupOpen = (): void => {
      if (this.serialPort !== serialPort) {
        return;
      }

      this.initialized = false;
      this.cleanupParser();
      this.detachSerialPort();
      serialPort.destroy();
      this.serialPort = undefined;
    };

    try {
      await this.connectOperations.run(
        () => serialPort.asyncOpen(),
        () => this.serialPort === serialPort,
        () => new Error("Connection closed"),
      );

      if (this.serialPort !== serialPort) {
        throw new Error("Connection closed");
      }

      opened = true;
      logger.debug("Serialport opened", NS);

      serialPort.once("close", this.onPortCloseHandler);
      serialPort.on("error", this.onPortErrorHandler);

      // reset
      // await this.reset();

      this.initialized = true;
    } catch (error) {
      if (!opened) {
        cleanupOpen();
      }

      throw error;
    }
  }

  private async openSocketPort(path: string): Promise<void> {
    const info = parseTcpPath(path);
    logger.debug(`Opening TCP socket with ${info.host}:${info.port}`, NS);

    this.socketPort = new net.Socket();
    this.socketPort.setNoDelay(true);
    this.socketPort.setKeepAlive(true, 15000);

    this.attachParserToPort(this.socketPort);

    let settled = false;
    const socketPort = this.socketPort!;
    const cleanupOpen = (): void => {
      if (this.socketPort !== socketPort) {
        return;
      }

      this.initialized = false;
      this.cleanupParser();
      this.detachSocketPort();
      socketPort.destroy();
      this.socketPort = undefined;
    };

    const openSocket = (): Promise<void> =>
      new Promise<void>((resolve, reject): void => {
        let readyStarted = false;
        const openError = (err: Error): void => {
          if (settled) {
            return;
          }

          settled = true;
          cleanupOpen();
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
            await this.reset();
          } catch (error) {
            openError(error instanceof Error ? error : new Error(String(error)));
            return;
          }

          if (settled || this.socketPort !== socketPort) {
            openError(new Error("Connection closed"));
            return;
          }

          detachOpenListeners();
          socketPort.once("close", this.onPortCloseHandler);
          socketPort.on("error", this.onPortErrorHandler);
          this.detachSocketListeners = detachRuntimeListeners;

          settled = true;
          this.initialized = true;

          resolve();
        };
        const onReady = (): void => {
          void handleSocketReady().catch((error) => {
            openError(error instanceof Error ? error : new Error(String(error)));
          });
        };
        const detachOpenListeners = (): void => {
          socketPort.off("connect", onConnect);
          socketPort.off("ready", onReady);
          socketPort.off("error", openError);
          socketPort.off("close", openClose);
        };
        const detachRuntimeListeners = (): void => {
          socketPort.off("close", this.onPortCloseHandler);
          socketPort.off("error", this.onPortErrorHandler);
        };
        this.detachSocketListeners = (): void => {
          detachOpenListeners();
          detachRuntimeListeners();
        };
        socketPort.on("connect", onConnect);
        socketPort.on("ready", onReady);
        socketPort.once("error", openError);
        socketPort.once("close", openClose);

        socketPort.connect(info.port, info.host);
      });

    try {
      await this.connectOperations.run(
        openSocket,
        () => this.socketPort === socketPort,
        () => new Error("Connection closed"),
      );
    } catch (error) {
      if (!settled) {
        settled = true;
        cleanupOpen();
      }

      throw error;
    }
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
      logger.error(`Error parsing frame: ${error}`, NS);
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

    const handled = this.waitress.resolve({ frameId: frame.frameId });
    if (!handled) {
      logger.debug(`Unsolicited frame ID ${frame.frameId.toString(16)}`, NS);
    }

    this.writer.sendACK(frame.sequence & 0x07);
    this.emit("received", frame.buffer);
  }

  private handleACK(frame: Frame): void {
    const ackSeq = (frame.control & 0x70) >> 4;
    const handled = this.waitress.resolve({ frameId: frame.frameId });
    if (!handled) {
      logger.debug(`Unexpected packet sequence ${ackSeq} `, NS);
    } else {
      logger.debug(() => `<-- ACK (${ackSeq}): ${frame}`, NS);
    }
  }

  private handleResetAck(frame: Frame): void {
    logger.debug(() => `<-- RESET_ACK: ${frame}`, NS);
    // this.waitress.resolve({frameId: -1});
  }

  private handleError(frame: Frame): void {
    logger.error(`<-- Error: NCP is in error state`, NS);
    // await this.reset();
  }

  async reset(): Promise<void> {
    this.parser.reset();
    this.throwIfClosing();
    this.cancelPendingOperations(new Error("Connection reset"));
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
        logger.error(`Reset failed: ${e}`, NS);
        this.emit("reset");
        throw new Error(`Reset error: ${e}`);
      }
    });
  }

  private throwIfClosing(): void {
    if (this.closePromise) {
      throw new Error("Connection closed");
    }
  }

  private handleReset(frame: Frame): void {
    logger.warning(() => `<-- RST:  ${frame}`, NS);
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
    const closeError = new Error("Connection closed");
    this.connectOperations.cancel(closeError);
    this.cancelPendingOperations(closeError);
    this.cleanupParser();

    const wasInitialized = this.initialized;
    this.initialized = false;

    const serialPort = this.serialPort;
    if (serialPort) {
      try {
        this.detachSerialPort();
        if (wasInitialized && serialPort.isOpen) {
          await serialPort.asyncFlushAndClose();
        } else {
          this.destroyActivePort();
        }
      } catch (error) {
        this.destroyActivePort();
        if (this.emitCloseWhenCloseCompletes) {
          this.emit("close");
        }

        throw error;
      } finally {
        if (this.serialPort === serialPort) {
          this.serialPort = undefined;
        }
      }
    } else if (this.socketPort) {
      this.destroyActivePort();
    }

    if (this.emitCloseWhenCloseCompletes) {
      this.emit("close");
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

  private cancelPendingOperations(error: Error): void {
    this.operationGeneration += 1;
    this.sendRetryDelay.cancel();
    this.queue.clear(error);
    this.waitress.clear(error);
  }

  private detachSerialPort(): void {
    if (!this.serialPort) {
      return;
    }

    this.writer.unpipe(this.serialPort);
    this.serialPort.unpipe(this.parser);
    this.serialPort.off("close", this.onPortCloseHandler);
    this.serialPort.off("error", this.onPortErrorHandler);
  }

  private detachSocketPort(): void {
    if (!this.socketPort) {
      return;
    }

    this.writer.unpipe(this.socketPort);
    this.socketPort.unpipe(this.parser);
    this.detachSocketListeners?.();
    this.detachSocketListeners = undefined;
  }

  private destroyActivePort(): void {
    if (this.serialPort) {
      this.detachSerialPort();
      this.serialPort.destroy();
      this.serialPort = undefined;
      return;
    }

    if (this.socketPort) {
      this.detachSocketPort();
      this.socketPort.destroy();
      this.socketPort = undefined;
    }
  }

  private onPortError(error: Error): void {
    logger.error(`Port error: ${error}`, NS);
  }

  private onPortClose(err: boolean | Error): void {
    logger.debug(`Port closed. Error? ${err}`, NS);
    this.initialized = false;
    const closeError = new Error(
      err != null && err !== false ? "Connection reset" : "Connection closed",
    );
    this.cancelPendingOperations(closeError);
    this.cleanupParser();

    this.destroyActivePort();

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
        throw new Error("Send cancelled by driver reset or close", {
          cause: error,
        });
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
      if (this.operationGeneration !== generation || !this.initialized) {
        throw new Error("Send cancelled by driver reset or close");
      }

      const isRetransmission = attempt > 0;
      const waiter =
        frameId === FRAMES.reset.ID
          ? undefined
          : this.waitFor(frameId, 1000); // 1 second timeout per attempt

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
        if (waiter) {
          this.waitress.remove(waiter.ID);
        }
        logger.error(`Attempt ${attempt + 1} failed for seq ${seq}: ${e}`, NS);

        if (this.operationGeneration !== generation || !this.initialized) {
          throw new Error("Send cancelled by driver reset or close");
        }

        if (attempt === retries) {
          logger.error(`All retries failed for seq ${seq}.`, NS);
          throw new Error(`Failed to send data after ${retries} retries`);
        }

        // Wait before retry
        const continueRetry = await this.waitForSendRetry(1000, generation);

        if (!continueRetry) {
          throw new Error("Send cancelled by driver reset or close");
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
      () => this.operationGeneration === generation && this.initialized,
    );
  }

  private waitFor(
    frameId: number,
    timeout = 3000,
  ): { start: () => { promise: Promise<BLZPacket>; ID: number }; ID: number } {
    return this.waitress.waitFor({ frameId }, timeout);
  }

  private waitressTimeoutFormatter(
    matcher: BLZPacketMatcher,
    timeout: number,
  ): string {
    return `${JSON.stringify(matcher)} after ${timeout}ms`;
  }

  private waitressValidator(
    payload: BLZPacket,
    matcher: BLZPacketMatcher,
  ): boolean {
    return payload.frameId === matcher.frameId;
  }
}
