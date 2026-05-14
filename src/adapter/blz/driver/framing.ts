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
    return Buffer.from([consts.START, ...stuffFrameData(frame), consts.END]);
}

export function stuffFrameData(buffer: Buffer): Buffer {
    const result: number[] = [];

    for (const byte of buffer) {
        if (consts.RESERVED.includes(byte)) {
            result.push(consts.ESCAPE, byte ^ consts.STUFF);
        } else {
            result.push(byte);
        }
    }

    return Buffer.from(result);
}

export function unstuffFrameData(buffer: Buffer): Buffer {
    const result: number[] = [];
    let escaped = false;

    for (const byte of buffer) {
        if (escaped) {
            result.push(byte ^ consts.STUFF);
            escaped = false;
        } else if (byte === consts.ESCAPE) {
            escaped = true;
        } else {
            result.push(byte);
        }
    }

    return Buffer.from(result);
}
