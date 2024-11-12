/* istanbul ignore file */

import {logger} from '../../../utils/logger';
const NS = 'zh:blz:frame';

enum BlzFrameChunkSize {
    UInt8 = 1,
    UInt16,
    UInt32,
    UInt64,
}

const ESCAPE_BYTE = 0x07;
const ESCAPE_MASK = 0x10;

const hasStartByte = (startByte: number, frame: Buffer): boolean => {
    return frame.indexOf(startByte, 0) === 0;
};

const hasStopByte = (stopByte: number, frame: Buffer): boolean => {
    return frame.indexOf(stopByte, frame.length - 1) === frame.length - 1;
};

const combineBytes = (byte: number, idx: number, frame: number[]): [number, number] => {
    const nextByte = frame[idx + 1];
    return [byte, nextByte];
};

const removeDuplicate = (_: unknown, idx: number, frame: number[][]): boolean => {
    if (idx === 0) {
        return true;
    }
    const [first] = frame[idx - 1];
    return first !== ESCAPE_BYTE;
};

const decodeBytes = (bytesPair: [number, number]): number => {
    return bytesPair[0] === ESCAPE_BYTE ? bytesPair[1] ^ ESCAPE_MASK : bytesPair[0];
};

const readBytesLE = (bytes: Buffer): number => {
    return bytes.readUIntLE(0, bytes.length);
};

const readBytesBE = (bytes: Buffer): number => {
    return bytes.readUIntBE(0, bytes.length);
};

const writeBytesLE = (bytes: Buffer, val: number): void => {
    bytes.writeUIntLE(val, 0, bytes.length);
};

const writeBytesBE = (bytes: Buffer, val: number): void => {
    bytes.writeUIntBE(val, 0, bytes.length);
};

const xor = (checksum: number, byte: number): number => {
    return checksum ^ byte;
};

const decodeFrame = (frame: Buffer): Buffer => {
    const arrFrame = Array.from(frame).map(combineBytes).filter(removeDuplicate).map(decodeBytes);
    return Buffer.from(arrFrame);
};

const getFrameChunk = (frame: Buffer, pos: number, size: BlzFrameChunkSize): Buffer => {
    return frame.subarray(pos, pos + size); 
};

export default class BlzFrame {
    static readonly START_BYTE = 0x42;
    static readonly STOP_BYTE = 0x4C;

    msgFrameControlBytes: Buffer = Buffer.alloc(BlzFrameChunkSize.UInt8);
    msgSequenceBytes: Buffer = Buffer.alloc(BlzFrameChunkSize.UInt8);
    msgCodeBytes: Buffer = Buffer.alloc(BlzFrameChunkSize.UInt16);
    msgPayloadBytes: Buffer = Buffer.alloc(0);
    checksumBytes: Buffer = Buffer.alloc(BlzFrameChunkSize.UInt16);

    constructor(frame?: Buffer) {
        if (frame !== undefined) {
            const decodedFrame = decodeFrame(frame);
            logger.debug(`decoded frame >>> %o`, decodedFrame, NS);
            // this.msgLengthOffset = -1;

            if (!BlzFrame.isValid(frame)) {
                logger.error('Provided frame is not a valid BlzFrame.', NS);
                return;
            }

            this.buildChunks(decodedFrame);

            try {
                if (this.readMsgCode() !== 0x8001) logger.debug(() => `${JSON.stringify(this)}`, NS);
            } catch (error) {
                logger.error((error as Error).stack!, NS);
            }

            if (this.readChecksum() !== this.calcChecksum()) {
                logger.error(`Provided frame has an invalid checksum.`, NS);
                return;
            }
        }
    }

    static isValid(frame: Buffer): boolean {
        return hasStartByte(BlzFrame.START_BYTE, frame) && hasStopByte(BlzFrame.STOP_BYTE, frame);
    }

    buildChunks(frame: Buffer): void {
        this.msgFrameControlBytes = getFrameChunk(frame, 1, this.msgFrameControlBytes.length); 
        this.msgSequenceBytes = getFrameChunk(frame, 2, this.msgSequenceBytes.length);
        this.msgCodeBytes = getFrameChunk(frame, 3, this.msgCodeBytes.length);
        this.msgPayloadBytes = getFrameChunk(frame, 5, frame.length - 6 - this.checksumBytes.length);
        this.checksumBytes = getFrameChunk(frame, frame.length - this.checksumBytes.length - 1, this.checksumBytes.length);
    }

    toBuffer(): Buffer {
        const data = Buffer.concat([
            this.msgFrameControlBytes,
            this.msgSequenceBytes,
            this.msgCodeBytes,
            this.msgPayloadBytes,
            this.checksumBytes,
        ]);
        const escapedData = this.escapeData(data);
        return Buffer.concat([Buffer.from([BlzFrame.START_BYTE]), escapedData, Buffer.from([BlzFrame.STOP_BYTE])]);
    }    

    escapeData(data: Buffer): Buffer {
        let encodedLength = 0;
        const encodedData = Buffer.alloc(data.length * 2);
    
        for (const b of data) {
            if (b === BlzFrame.START_BYTE || b === BlzFrame.STOP_BYTE || b === ESCAPE_BYTE) {
                encodedData[encodedLength++] = ESCAPE_BYTE;
                encodedData[encodedLength++] = b ^ ESCAPE_MASK;
            } else {
                encodedData[encodedLength++] = b;
            }
        }

        return encodedData.slice(0, encodedLength);
    }
    

    readMsgCode(): number {
        return readBytesLE(this.msgCodeBytes);
    }

    writeMsgCode(msgCode: number): BlzFrame {
        writeBytesLE(this.msgCodeBytes, msgCode);
        this.writeChecksum();
        return this;
    }

    readChecksum(): number {
        return readBytesBE(this.checksumBytes);
    }

    writeMsgPayload(msgPayload: Buffer): BlzFrame {
        this.msgPayloadBytes = Buffer.from(msgPayload);
        this.writeChecksum();
        return this;
    }
    
    calcChecksum(): number {
        let crc16 = 0xFFFF; // Initial CRC value
    
        // Combine all frame parts to compute CRC on them sequentially
        const dataParts = [
            ...this.msgFrameControlBytes,
            ...this.msgSequenceBytes,
            ...this.msgCodeBytes,
            ...this.msgPayloadBytes
        ];
    
        for (const byte of dataParts) {
            crc16 = this.calcCrc16(byte, crc16);
        }
    
        return crc16;
    }
    
    /**
     * Helper function to perform the CRC-16 calculation on each byte.
     * @param {number} newByte - The byte to process.
     * @param {number} prevResult - The previous CRC result.
     * @returns {number} - Updated CRC result after processing the byte.
     */
    calcCrc16(newByte: number, prevResult: number): number {
        prevResult = ((prevResult >> 8) | (prevResult << 8)) & 0xFFFF; // Swap bytes
        prevResult ^= newByte; // XOR with new byte
        prevResult ^= (prevResult & 0xFF) >> 4; // XOR the lower 4 bits
        prevResult ^= ((prevResult << 8) << 4) & 0xFFFF; // XOR result shifted left
        prevResult ^= (((prevResult & 0xFF) << 5) | ((prevResult & 0xFF) >> 3) << 8) & 0xFFFF; // Final XOR
        return prevResult;
    }    

    writeChecksum(): this {
        const checksumValue = this.calcChecksum();
        this.checksumBytes = Buffer.alloc(2);
        writeBytesBE(this.checksumBytes, checksumValue);
        return this;
    }
    
}
