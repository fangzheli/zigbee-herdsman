/* istanbul ignore file */

import { verifyFrameCrc } from "./framing";
/**
 * Class representing a BLZ protocol frame.
 */
export class Frame {
    public readonly control: number; // Control byte
    public readonly sequence: number; // Sequence byte
    public readonly frameId: number; // Frame ID
    public readonly payload: Buffer; // Optional payload
    public readonly buffer: Buffer; // Raw frame buffer

    /**
     * Constructs a Frame instance from a given buffer.
     * @param buffer The raw frame buffer.
     */
    public constructor(buffer: Buffer) {
        if (buffer.length < 6) {
            throw new Error(`Invalid frame length: ${buffer.length}`);
        }

        this.buffer = buffer;

        // Parse fixed fields
        this.control = this.buffer[0]; // Control byte
        this.sequence = this.buffer[1]; // Sequence byte
        this.frameId = this.buffer.readUInt16LE(2); // Frame ID (2 bytes, little-endian)

        // Extract optional payload (all bytes between Frame ID and CRC)
        this.payload = this.buffer.subarray(4, -2);
    }

    /**
     * Factory method to create a Frame instance from a buffer.
     * @param buffer The raw frame buffer.
     * @returns A new Frame instance.
     */
    public static fromBuffer(buffer: Buffer): Frame {
        return new Frame(buffer);
    }

    /**
     * Validates the CRC of the frame.
     * Throws an error if the CRC does not match.
     */
    public checkCRC(): void {
        verifyFrameCrc(this.buffer);
    }

    /**
     * Converts the frame buffer to a hex string representation.
     * @returns Hexadecimal string of the buffer.
     */
    public toString(): string {
        return this.buffer.toString("hex");
    }
}

export default Frame;
