import * as consts from "./consts";
import crc16ccitt from "./utils/crc16ccitt";

const BLZ_CRC_INITIAL_VALUE = 0xffff;

export function appendFrameCrc(data: Buffer): Buffer {
    const crc = crc16ccitt(data, BLZ_CRC_INITIAL_VALUE);

    return Buffer.concat([data, Buffer.from([crc >> 8, crc & 0xff])]);
}

export function verifyFrameCrc(frame: Buffer): void {
    const data = frame.subarray(0, -2);
    const expected = appendFrameCrc(data).subarray(-2);
    const actual = frame.subarray(-2);

    if (!actual.equals(expected)) {
        throw new Error(`CRC mismatch: expected ${expected.toString("hex")}, got ${actual.toString("hex")}`);
    }
}

export function buildFrameBuffer(control: number, sequence: number, frameId: number, payload?: Buffer): Buffer {
    const header = Buffer.from([control, sequence, frameId & 0xff, (frameId >> 8) & 0xff]);

    return appendFrameCrc(payload ? Buffer.concat([header, payload]) : header);
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
