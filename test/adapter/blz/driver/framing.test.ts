import {describe, expect, it} from "vitest";

import * as consts from "../../../../src/adapter/blz/driver/consts";
import {appendFrameCrc, stuffFrameData, unstuffFrameData, verifyFrameCrc} from "../../../../src/adapter/blz/driver/framing";
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
