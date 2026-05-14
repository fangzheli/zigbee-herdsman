import {describe, expect, it, vi} from "vitest";

import * as consts from "../../../../src/adapter/blz/driver/consts";
import {
    appendFrameCrc,
    buildFrameBuffer,
    stuffFrameData,
    unstuffFrameData,
    verifyFrameCrc,
    wrapFrameBuffer,
} from "../../../../src/adapter/blz/driver/framing";
import crc16ccitt from "../../../../src/adapter/blz/driver/utils/crc16ccitt";

describe("BLZ frame byte stuffing", () => {
    it("stuffs all delimiter bytes and leaves other bytes unchanged", () => {
        const raw = Buffer.from([0x00, consts.START, consts.END, consts.ESCAPE, 0xff]);

        const stuffed = stuffFrameData(raw);

        expect(stuffed).toStrictEqual(
            Buffer.from([
                0x00,
                consts.ESCAPE,
                consts.START ^ consts.STUFF,
                consts.ESCAPE,
                consts.END ^ consts.STUFF,
                consts.ESCAPE,
                consts.ESCAPE ^ consts.STUFF,
                0xff,
            ]),
        );
        expect(raw).toStrictEqual(Buffer.from([0x00, consts.START, consts.END, consts.ESCAPE, 0xff]));
    });

    it("unstuffs escaped delimiter bytes", () => {
        const stuffed = Buffer.from([
            consts.ESCAPE,
            consts.START ^ consts.STUFF,
            consts.ESCAPE,
            consts.END ^ consts.STUFF,
            consts.ESCAPE,
            consts.ESCAPE ^ consts.STUFF,
        ]);

        expect(unstuffFrameData(stuffed)).toStrictEqual(Buffer.from([consts.START, consts.END, consts.ESCAPE]));
    });

    it("round trips payloads through stuff and unstuff", () => {
        const raw = Buffer.from([consts.START, 0x01, consts.END, 0x02, consts.ESCAPE, 0x03]);

        expect(unstuffFrameData(stuffFrameData(raw))).toStrictEqual(raw);
    });
});

describe("BLZ frame CRC helpers", () => {
    it("appends CRC bytes without mutating the input buffer", () => {
        const data = Buffer.from([0x00, 0x35, 0x10, 0x00, 0x01, 0x02]);
        const expectedCrc = crc16ccitt(data, 0xffff);

        const withCrc = appendFrameCrc(data);

        expect(data).toStrictEqual(Buffer.from([0x00, 0x35, 0x10, 0x00, 0x01, 0x02]));
        expect(withCrc.subarray(0, -2)).toStrictEqual(data);
        expect(withCrc[withCrc.length - 2]).toBe(expectedCrc >> 8);
        expect(withCrc[withCrc.length - 1]).toBe(expectedCrc & 0xff);
    });

    it("verifies CRC and keeps the existing mismatch message format", () => {
        const withCrc = appendFrameCrc(Buffer.from([0x00, 0x35, 0x10, 0x00]));
        withCrc[withCrc.length - 1] ^= 0xff;

        expect(() => verifyFrameCrc(withCrc)).toThrow("CRC mismatch: expected");
    });
});

describe("BLZ frame construction helpers", () => {
    it("builds raw frame buffers with header, payload, and CRC without mutating payload", () => {
        const payload = Buffer.from([0x01, 0x02, consts.START]);

        const frame = buildFrameBuffer(0x80, 0x35, 0x1234, payload);

        expect(payload).toStrictEqual(Buffer.from([0x01, 0x02, consts.START]));
        expect(frame[0]).toBe(0x80);
        expect(frame[1]).toBe(0x35);
        expect(frame.readUInt16LE(2)).toBe(0x1234);
        expect(frame.subarray(4, -2)).toStrictEqual(payload);
        expect(() => verifyFrameCrc(frame)).not.toThrow();
    });

    it("wraps raw frame buffers with delimiters and byte stuffing", () => {
        const frame = buildFrameBuffer(0x00, 0x00, consts.START, Buffer.from([consts.END]));

        const wrapped = wrapFrameBuffer(frame);

        expect(wrapped[0]).toBe(consts.START);
        expect(wrapped[wrapped.length - 1]).toBe(consts.END);
        expect(unstuffFrameData(wrapped.subarray(1, -1))).toStrictEqual(frame);
    });

    it("does not construct large intermediary number arrays when wrapping frames", () => {
        const originalFrom = Buffer.from.bind(Buffer);
        const largeArrayLengths: number[] = [];
        const fromSpy = vi.spyOn(Buffer, "from").mockImplementation(((value: unknown, ...args: unknown[]) => {
            if (Array.isArray(value) && value.length > 4) {
                largeArrayLengths.push(value.length);
            }

            return (originalFrom as (...parameters: unknown[]) => Buffer)(value, ...args);
        }) as typeof Buffer.from);

        try {
            const frame = Buffer.alloc(4096, consts.START);

            const wrapped = wrapFrameBuffer(frame);

            expect(wrapped[0]).toBe(consts.START);
            expect(wrapped[wrapped.length - 1]).toBe(consts.END);
            expect(unstuffFrameData(wrapped.subarray(1, -1))).toStrictEqual(frame);
            expect(largeArrayLengths).toStrictEqual([]);
        } finally {
            fromSpy.mockRestore();
        }
    });
});
