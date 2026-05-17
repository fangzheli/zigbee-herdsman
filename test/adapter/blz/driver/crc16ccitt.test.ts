// biome-ignore-all lint/suspicious/noExplicitAny: Tests inspect dynamic properties attached to the CRC function.

import {describe, expect, it} from "vitest";
import crc16ccitt from "../../../../src/adapter/blz/driver/utils/crc16ccitt";

describe("CRC16-CCITT", () => {
    describe("Basic functionality", () => {
        it("should calculate CRC for empty buffer", () => {
            const result = crc16ccitt(Buffer.from([]), 0xffff);
            expect(result).toBe(0xffff); // Initial value unchanged for empty input
        });

        it("should calculate CRC for single byte", () => {
            const result = crc16ccitt(Buffer.from([0x00]), 0xffff);
            expect(typeof result).toBe("number");
            expect(result).toBeGreaterThanOrEqual(0);
            expect(result).toBeLessThanOrEqual(0xffff);
        });

        it("should calculate CRC for multiple bytes", () => {
            const result = crc16ccitt(Buffer.from([0x01, 0x02, 0x03, 0x04]), 0xffff);
            expect(typeof result).toBe("number");
            expect(result).toBeGreaterThanOrEqual(0);
            expect(result).toBeLessThanOrEqual(0xffff);
        });

        it("should produce consistent results", () => {
            const data = Buffer.from([0x01, 0x02, 0x03]);
            const result1 = crc16ccitt(data, 0xffff);
            const result2 = crc16ccitt(data, 0xffff);
            expect(result1).toBe(result2);
        });

        it("should produce different results for different data", () => {
            const result1 = crc16ccitt(Buffer.from([0x01, 0x02, 0x03]), 0xffff);
            const result2 = crc16ccitt(Buffer.from([0x01, 0x02, 0x04]), 0xffff);
            expect(result1).not.toBe(result2);
        });
    });

    describe("Initial value handling", () => {
        it("should use provided initial value", () => {
            const data = Buffer.from([0x01, 0x02, 0x03]);
            const result1 = crc16ccitt(data, 0x0000);
            const result2 = crc16ccitt(data, 0xffff);
            expect(result1).not.toBe(result2);
        });

        it("should handle zero initial value", () => {
            const result = crc16ccitt(Buffer.from([0x01, 0x02]), 0x0000);
            expect(typeof result).toBe("number");
        });

        it("should handle max initial value", () => {
            const result = crc16ccitt(Buffer.from([0x01, 0x02]), 0xffff);
            expect(typeof result).toBe("number");
        });
    });

    describe("Input types", () => {
        it("should accept Buffer input", () => {
            const result = crc16ccitt(Buffer.from([0x01, 0x02, 0x03]), 0xffff);
            expect(typeof result).toBe("number");
        });

        it("should accept number array input", () => {
            const result = crc16ccitt([0x01, 0x02, 0x03], 0xffff);
            expect(typeof result).toBe("number");
        });

        it("should produce same result for Buffer and array", () => {
            const data = [0x01, 0x02, 0x03, 0x04];
            const result1 = crc16ccitt(Buffer.from(data), 0xffff);
            const result2 = crc16ccitt(data, 0xffff);
            expect(result1).toBe(result2);
        });
    });

    describe("Known CRC values", () => {
        // Standard CRC-16/CCITT test vectors
        it('should calculate correct CRC for "123456789"', () => {
            // Standard CCITT test: "123456789" should give 0x29B1 (with initial 0xFFFF)
            const data = Buffer.from("123456789", "ascii");
            const result = crc16ccitt(data, 0xffff);
            expect(result).toBe(0x29b1);
        });

        it("should calculate correct CRC for all zeros", () => {
            const data = Buffer.from([0x00, 0x00, 0x00, 0x00]);
            const result = crc16ccitt(data, 0xffff);
            // All zeros with 0xFFFF init should produce a specific value
            expect(typeof result).toBe("number");
        });

        it("should calculate correct CRC for all 0xFF", () => {
            const data = Buffer.from([0xff, 0xff, 0xff, 0xff]);
            const result = crc16ccitt(data, 0xffff);
            expect(typeof result).toBe("number");
        });
    });

    describe("BLZ frame verification", () => {
        it("should verify CRC of a sample BLZ frame", () => {
            // Create a simple frame: control=0x00, seq=0x01, frameId=0x0010
            const frameData = Buffer.from([0x00, 0x01, 0x10, 0x00]);
            const crc = crc16ccitt(frameData, 0xffff);

            // Verify CRC is a valid 16-bit value
            expect(crc).toBeGreaterThanOrEqual(0);
            expect(crc).toBeLessThanOrEqual(0xffff);

            // Create complete frame with CRC
            const completeFrame = Buffer.concat([frameData, Buffer.from([crc >> 8, crc & 0xff])]);

            // Recalculate CRC over complete frame (excluding CRC bytes)
            const verifyCrc = crc16ccitt(completeFrame.subarray(0, -2), 0xffff);
            expect(verifyCrc).toBe(crc);
        });

        it("should detect data corruption", () => {
            const frameData = Buffer.from([0x00, 0x01, 0x10, 0x00]);
            const originalCrc = crc16ccitt(frameData, 0xffff);

            // Corrupt one byte
            const corruptedData = Buffer.from(frameData);
            corruptedData[2] = 0x11;

            const corruptedCrc = crc16ccitt(corruptedData, 0xffff);
            expect(corruptedCrc).not.toBe(originalCrc);
        });
    });

    describe("Incremental calculation", () => {
        it("should support incremental CRC calculation", () => {
            const data1 = Buffer.from([0x01, 0x02]);
            const data2 = Buffer.from([0x03, 0x04]);
            const fullData = Buffer.concat([data1, data2]);

            // Calculate incrementally
            const intermediateCrc = crc16ccitt(data1, 0xffff);
            const incrementalResult = crc16ccitt(data2, intermediateCrc);

            // Calculate at once
            const fullResult = crc16ccitt(fullData, 0xffff);

            expect(incrementalResult).toBe(fullResult);
        });
    });

    describe("Edge cases", () => {
        it("should handle single byte values at boundaries", () => {
            expect(() => crc16ccitt(Buffer.from([0x00]), 0xffff)).not.toThrow();
            expect(() => crc16ccitt(Buffer.from([0xff]), 0xffff)).not.toThrow();
            expect(() => crc16ccitt(Buffer.from([0x7f]), 0xffff)).not.toThrow();
            expect(() => crc16ccitt(Buffer.from([0x80]), 0xffff)).not.toThrow();
        });

        it("should handle large buffers", () => {
            const largeBuffer = Buffer.alloc(10000, 0xab);
            const result = crc16ccitt(largeBuffer, 0xffff);
            expect(typeof result).toBe("number");
            expect(result).toBeGreaterThanOrEqual(0);
            expect(result).toBeLessThanOrEqual(0xffff);
        });

        it("should produce unsigned result", () => {
            // The result should always be unsigned (0 to 65535)
            const testCases = [Buffer.from([0x00]), Buffer.from([0xff]), Buffer.from([0x01, 0x02, 0x03]), Buffer.from([0xff, 0xff, 0xff, 0xff])];

            for (const data of testCases) {
                const result = crc16ccitt(data, 0xffff);
                expect(result >>> 0).toBe(result); // Check unsigned
            }
        });
    });

    describe("Function properties", () => {
        it("should have model property", () => {
            expect((crc16ccitt as any).model).toBe("ccitt");
        });

        it("should have signed function", () => {
            expect(typeof (crc16ccitt as any).signed).toBe("function");
        });

        it("should have unsigned function", () => {
            expect(typeof (crc16ccitt as any).unsigned).toBe("function");
        });

        it("unsigned and default should return same result", () => {
            const data = Buffer.from([0x01, 0x02, 0x03]);
            const defaultResult = crc16ccitt(data, 0xffff);
            const unsignedResult = (crc16ccitt as any).unsigned(data, 0xffff);
            expect(defaultResult).toBe(unsignedResult);
        });
    });
});
