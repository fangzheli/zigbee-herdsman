/* istanbul ignore file */

import * as stream from "node:stream";

import { logger } from "../../../utils/logger";
import * as consts from "./consts";
import Frame from "./frame";
import { unstuffFrameData } from "./framing";

const NS = "zh:blz:uart";

export class Parser extends stream.Transform {
  private tail: Buffer[];

  public constructor() {
    super();
    this.tail = [];
  }

  public _transform(chunk: Buffer, _: string, cb: () => void): void {
    logger.debug(`<-- [${chunk.toString("hex")}]`, NS);

    // Append the new chunk to the tail for processing
    this.tail.push(chunk);
    let buffer = Buffer.concat(this.tail);

    let startPlace = buffer.indexOf(consts.START);
    let endPlace = buffer.indexOf(consts.END, startPlace + 1);

    while (startPlace >= 0 && endPlace > startPlace) {
      // Extract a complete frame from START to END
      const frameBuffer = buffer.subarray(startPlace + 1, endPlace); // Exclude delimiters

      try {
        const unstuffedBuffer = unstuffFrameData(frameBuffer);
        const frame = Frame.fromBuffer(unstuffedBuffer);

        if (frame) {
          this.emit("parsed", frame); // Emit the parsed frame
        }
      } catch (error) {
        logger.debug(`<-- error ${error}`, NS);
      }

      // Remove the processed part and search for the next frame
      buffer = buffer.subarray(endPlace + 1);
      startPlace = buffer.indexOf(consts.START);
      endPlace = buffer.indexOf(consts.END, startPlace + 1);
    }

    // Save unprocessed data for the next chunk.
    const firstStart = buffer.indexOf(consts.START);
    if (firstStart === -1) {
      this.tail = [];
      cb();
      return;
    }
    const partialFrame = firstStart === 0 ? buffer : buffer.subarray(firstStart);

    // Guard against unbounded growth from corrupted serial data (missing END delimiter).
    if (partialFrame.length > 16384) {
      logger.warning(
        `Parser buffer overflow (${partialFrame.length} bytes), discarding`,
        NS,
      );
      this.tail = [];
    } else {
      this.tail = [partialFrame];
    }
    cb();
  }

  public reset(): void {
    // Clear tail
    this.tail.length = 0;
  }
}
