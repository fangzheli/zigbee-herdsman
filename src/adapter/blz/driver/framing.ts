import * as consts from "./consts";
import crc16ccitt from "./utils/crc16ccitt";

const BLZ_CRC_INITIAL_VALUE = 0xffff;

export function appendFrameCrc(data: Buffer): Buffer {
    const result = Buffer.allocUnsafe(data.length + 2);
    data.copy(result, 0);
    writeFrameCrc(result, data.length);

    return result;
}

export function verifyFrameCrc(frame: Buffer): void {
    const data = frame.subarray(0, -2);
    const expected = crc16ccitt(data, BLZ_CRC_INITIAL_VALUE);
    const actual = frame.subarray(-2);

    if (actual[0] !== expected >> 8 || actual[1] !== (expected & 0xff)) {
        throw new Error(`CRC mismatch: expected ${crcToHex(expected)}, got ${actual.toString("hex")}`);
    }
}

export function buildFrameBuffer(control: number, sequence: number, frameId: number, payload?: Buffer): Buffer {
    const payloadLength = payload?.length ?? 0;
    const frame = Buffer.allocUnsafe(4 + payloadLength + 2);

    frame[0] = control;
    frame[1] = sequence;
    frame.writeUInt16LE(frameId, 2);
    payload?.copy(frame, 4);
    writeFrameCrc(frame, 4 + payloadLength);

    return frame;
}

export function wrapFrameBuffer(frame: Buffer): Buffer {
    const stuffed = stuffFrameData(frame);
    const wrapped = Buffer.allocUnsafe(stuffed.length + 2);

    wrapped[0] = consts.START;
    stuffed.copy(wrapped, 1);
    wrapped[wrapped.length - 1] = consts.END;

    return wrapped;
}

export function stuffFrameData(buffer: Buffer): Buffer {
    const result = Buffer.allocUnsafe(getStuffedLength(buffer));
    let offset = 0;

    for (const byte of buffer) {
        if (isReservedByte(byte)) {
            result[offset++] = consts.ESCAPE;
            result[offset++] = byte ^ consts.STUFF;
        } else {
            result[offset++] = byte;
        }
    }

    return result;
}

export function unstuffFrameData(buffer: Buffer): Buffer {
    const result = Buffer.allocUnsafe(getUnstuffedLength(buffer));
    let offset = 0;
    let escaped = false;

    for (const byte of buffer) {
        if (escaped) {
            result[offset++] = byte ^ consts.STUFF;
            escaped = false;
        } else if (byte === consts.ESCAPE) {
            escaped = true;
        } else {
            result[offset++] = byte;
        }
    }

    return result;
}

function getStuffedLength(buffer: Buffer): number {
    let length = 0;

    for (const byte of buffer) {
        length += isReservedByte(byte) ? 2 : 1;
    }

    return length;
}

function getUnstuffedLength(buffer: Buffer): number {
    let length = 0;
    let escaped = false;

    for (const byte of buffer) {
        if (escaped) {
            length++;
            escaped = false;
        } else if (byte === consts.ESCAPE) {
            escaped = true;
        } else {
            length++;
        }
    }

    return length;
}

function isReservedByte(byte: number): boolean {
    return byte === consts.START || byte === consts.END || byte === consts.ESCAPE;
}

function writeFrameCrc(frame: Buffer, dataLength: number): void {
    const crc = crc16ccitt(frame.subarray(0, dataLength), BLZ_CRC_INITIAL_VALUE);
    frame[dataLength] = crc >> 8;
    frame[dataLength + 1] = crc & 0xff;
}

function crcToHex(crc: number): string {
    return `${(crc >> 8).toString(16).padStart(2, "0")}${(crc & 0xff).toString(16).padStart(2, "0")}`;
}
