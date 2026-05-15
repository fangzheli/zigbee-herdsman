import {describe, expect, it} from "vitest";

import {
    bytesEqual,
    bytesToHex,
    uint64FromLittleEndianBytes,
    uint64ToLittleEndianBuffer,
} from "../../../src/adapter/blz/byteUtils";

describe("BLZ byte utilities", () => {
    it("converts uint64 values to little-endian buffers", () => {
        expect(uint64ToLittleEndianBuffer(0x0102030405060708n)).toEqual(
            Buffer.from([8, 7, 6, 5, 4, 3, 2, 1]),
        );
    });

    it("converts little-endian bytes back to uint64 values", () => {
        expect(uint64FromLittleEndianBytes([8, 7, 6, 5, 4, 3, 2, 1])).toBe(
            0x0102030405060708n,
        );
    });

    it("formats array-like bytes as lowercase hex", () => {
        expect(bytesToHex([0x00, 0xab, 0xff])).toBe("00abff");
    });

    it("compares array-like bytes without requiring the same concrete type", () => {
        expect(bytesEqual([1, 2, 3], Buffer.from([1, 2, 3]))).toBe(true);
        expect(bytesEqual([1, 2, 3], Buffer.from([1, 2, 4]))).toBe(false);
    });
});
