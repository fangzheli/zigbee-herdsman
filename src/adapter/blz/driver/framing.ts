import * as consts from "./consts";

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
