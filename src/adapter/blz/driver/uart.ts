/* istanbul ignore file */

import { EventEmitter } from "events";
import net from "net";

import { Queue, wait, Waitress } from "../../../utils";
import { logger } from "../../../utils/logger";
import { SerialPort } from "../../serialPort";
import { isTcpPath, parseTcpPath } from "../../utils";
import { SerialPortOptions } from "../../tstype";
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
  private ackSeq = 0; // next number after the last accepted frame
  private rejectCondition = false;
  private waitress: Waitress<BLZPacket, BLZPacketMatcher>;
  private queue: Queue;

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

  async connect(options: SerialPortOptions): Promise<void> {
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
    };

    logger.debug(`Opening SerialPort with ${JSON.stringify(options)}`, NS);
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    this.serialPort = new SerialPort(options);

    this.writer.pipe(this.serialPort);

    this.serialPort.pipe(this.parser);
    this.parser.on("parsed", this.onParsed.bind(this));

    try {
      await this.serialPort.asyncOpen();
      logger.debug("Serialport opened", NS);

      this.serialPort.once("close", this.onPortClose.bind(this));
      this.serialPort.on("error", this.onPortError.bind(this));

      // reset
      // await this.reset();

      this.initialized = true;
    } catch (error) {
      this.initialized = false;
      // Clean up pipes and port on failure to prevent orphaned streams
      this.cleanupParser();
      this.detachSerialPort();
      this.serialPort.destroy();
      this.serialPort = undefined;
      throw error;
    }
  }

  private async openSocketPort(path: string): Promise<void> {
    const info = parseTcpPath(path);
    logger.debug(`Opening TCP socket with ${info.host}:${info.port}`, NS);

    this.socketPort = new net.Socket();
    this.socketPort.setNoDelay(true);
    this.socketPort.setKeepAlive(true, 15000);

    this.writer.pipe(this.socketPort);

    this.socketPort.pipe(this.parser);
    this.parser.on("parsed", this.onParsed.bind(this));

    return await new Promise((resolve, reject): void => {
      let settled = false;
      const openError = (err: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.initialized = false;
        this.cleanupParser();
        this.detachSocketPort();
        this.socketPort?.destroy();
        this.socketPort = undefined;

        reject(err);
      };

      this.socketPort!.on("connect", () => {
        logger.debug("Socket connected", NS);
      });
      this.socketPort!.on("ready", async (): Promise<void> => {
        if (settled) {
          return;
        }

        logger.debug("Socket ready", NS);
        this.socketPort!.removeListener("error", openError);
        this.socketPort!.once("close", this.onPortClose.bind(this));
        this.socketPort!.on("error", this.onPortError.bind(this));

        try {
          // reset
          await this.reset();
        } catch (error) {
          openError(error instanceof Error ? error : new Error(String(error)));
          return;
        }

        settled = true;
        this.initialized = true;

        resolve();
      });
      this.socketPort!.once("error", openError);

      this.socketPort!.connect(info.port, info.host);
    });
  }

  private async onParsed(frame: Frame): Promise<void> {
    try {
      if ((frame.control & 0x80) !== 0) {
        frame.checkCRC();
      }
      const frmNum = frame.sequence & 0x0f;
      const reTx = frame.control & 0x01;

      this.recvSeq = (frmNum + 1) & 0x0f;
      logger.debug(`<-- Frame (${frmNum}, ${reTx}): ${frame}`, NS);

      switch (frame.frameId) {
        case 0x0001:
          this.handleACK(frame);
          break;
        case 0x0002:
          await this.handleError(frame);
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
      this.rejectCondition = true;
      logger.error(`Error parsing frame: ${error}`, NS);
    }
  }

  private handleDATA(frame: Frame): void {
    const ackSeq = (frame.control & 0x70) >> 4;

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
      logger.debug(`<-- ACK (${ackSeq}): ${frame}`, NS);
    }
  }

  private handleResetAck(frame: Frame): void {
    logger.debug(`<-- RESET_ACK: ${frame}`, NS);
    // this.waitress.resolve({frameId: -1});
  }

  private async handleError(frame: Frame): Promise<void> {
    logger.error(`<-- Error: NCP is in error state`, NS);
    // await this.reset();
  }

  async reset(): Promise<void> {
    this.parser.reset();
    this.queue.clear();
    this.sendSeq = 0;
    this.recvSeq = 0;

    return this.queue.execute(async () => {
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

  private handleReset(frame: Frame): void {
    logger.warning(`<-- RST:  ${frame}`, NS);
  }

  public async close(emitClose: boolean): Promise<void> {
    logger.debug("Closing UART", NS);
    this.queue.clear();
    this.waitress.clear();
    this.cleanupParser();

    if (this.initialized) {
      this.initialized = false;

      if (this.serialPort) {
        try {
          this.detachSerialPort();
          await this.serialPort.asyncFlushAndClose();
          this.serialPort = undefined;
        } catch (error) {
          if (emitClose) {
            this.emit("close");
          }

          throw error;
        }
      } else if (this.socketPort) {
        this.detachSocketPort();
        this.socketPort.destroy();
        this.socketPort = undefined;
      }
    }

    if (emitClose) {
      this.emit("close");
    }
  }

  private cleanupParser(): void {
    this.parser.removeAllListeners();
    this.parser.reset();
  }

  private detachSerialPort(): void {
    if (!this.serialPort) {
      return;
    }

    this.writer.unpipe(this.serialPort);
    this.serialPort.unpipe(this.parser);
    this.serialPort.removeAllListeners("close");
    this.serialPort.removeAllListeners("error");
  }

  private detachSocketPort(): void {
    if (!this.socketPort) {
      return;
    }

    this.writer.unpipe(this.socketPort);
    this.socketPort.unpipe(this.parser);
    this.socketPort.removeAllListeners("connect");
    this.socketPort.removeAllListeners("ready");
    this.socketPort.removeAllListeners("close");
    this.socketPort.removeAllListeners("error");
  }

  private onPortError(error: Error): void {
    logger.error(`Port error: ${error}`, NS);
  }

  private onPortClose(err: boolean | Error): void {
    logger.debug(`Port closed. Error? ${err}`, NS);
    this.initialized = false;

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
    const seq = this.sendSeq;
    const ackSeq = this.recvSeq;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const isRetransmission = attempt > 0;
      const waiter = this.waitFor(frameId, 1000); // 1 second timeout per attempt

      try {
        this.writer.sendData(
          data,
          seq,
          ackSeq,
          frameId,
          true,
          isRetransmission,
        );
        this.sendSeq = (seq + 1) & 0x0f;

        // Don't wait for response if this is a reset command
        if (frameId !== FRAMES.reset.ID) {
          await waiter.start().promise;
        }
        return;
      } catch (e) {
        this.waitress.remove(waiter.ID);
        logger.error(`Attempt ${attempt + 1} failed for seq ${seq}: ${e}`, NS);

        if (attempt === retries) {
          logger.error(`All retries failed for seq ${seq}.`, NS);
          throw new Error(`Failed to send data after ${retries} retries`);
        }

        // Wait before retry
        await wait(1000);
      }
    }
  }

  public waitFor(
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
