import {beforeEach, describe, expect, it, vi} from "vitest";
import * as consts from "../../../../src/adapter/blz/driver/consts";
import crc16ccitt from "../../../../src/adapter/blz/driver/utils/crc16ccitt";
import {Writer} from "../../../../src/adapter/blz/driver/writer";
import {logger} from "../../../../src/utils/logger";

describe("BLZ Writer", () => {
    let writer: Writer;

    /**
     * Unstuffs a buffer for verification
     */
    function unstuff(buffer: Buffer): Buffer {
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

    /**
     * Extracts frame content without START/END delimiters and unstuffs it
     */
    function extractFrameContent(buffer: Buffer): Buffer {
        expect(buffer[0]).toBe(consts.START);
        expect(buffer[buffer.length - 1]).toBe(consts.END);
        return unstuff(buffer.subarray(1, -1));
    }

    /**
     * Helper to get first data chunk from writer
     */
    function getWriterOutput(writer: Writer): Promise<Buffer> {
        return new Promise((resolve) => {
            writer.once("data", (chunk) => {
                resolve(chunk);
            });
        });
    }

    beforeEach(() => {
        writer = new Writer();
    });

    describe("writeBuffer", () => {
        it("should push buffer to readable stream", async () => {
            const testBuffer = Buffer.from([0x01, 0x02, 0x03]);
            const outputPromise = getWriterOutput(writer);
            writer.writeBuffer(testBuffer);
            const chunk = await outputPromise;
            expect(chunk).toEqual(testBuffer);
        });

        it("should not stringify outgoing buffers unless debug logging evaluates the message", async () => {
            const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
            const testBuffer = Buffer.from([0x01, 0x02, 0x03]);
            const toStringSpy = vi.spyOn(testBuffer, "toString").mockImplementation(() => {
                throw new Error("eager outgoing hex string");
            });

            try {
                const outputPromise = getWriterOutput(writer);

                expect(() => writer.writeBuffer(testBuffer)).not.toThrow();
                await outputPromise;
                expect(debug).toHaveBeenCalledWith(expect.any(Function), expect.any(String));
            } finally {
                toStringSpy.mockRestore();
                debug.mockRestore();
            }
        });
    });

    describe("sendACK", () => {
        it("should create ACK frame with correct frameId", async () => {
            const ackSeq = 3;
            const outputPromise = getWriterOutput(writer);
            writer.sendACK(ackSeq);
            const chunk = await outputPromise;
            const content = extractFrameContent(chunk);

            // Check control byte (0x80 for ACK)
            expect(content[0]).toBe(0x80);
            // Check frameId is 0x0001 (ACK)
            expect(content.readUInt16LE(2)).toBe(0x0001);
        });

        it("should set correct sequence byte for ACK", async () => {
            const ackSeq = 5;
            const outputPromise = getWriterOutput(writer);
            writer.sendACK(ackSeq);
            const chunk = await outputPromise;
            const content = extractFrameContent(chunk);

            // Sequence byte: (ackSeq & 0x07) << 4 | (seq & 0x07)
            // For ACK, seq should be 0
            const expectedSeqByte = ((ackSeq & 0x07) << 4) | 0;
            expect(content[1]).toBe(expectedSeqByte);
        });

        it("should include valid CRC", async () => {
            const outputPromise = getWriterOutput(writer);
            writer.sendACK(0);
            const chunk = await outputPromise;
            const content = extractFrameContent(chunk);
            const data = content.subarray(0, -2);
            const crc = crc16ccitt(data, 0xffff);

            expect(content[content.length - 2]).toBe(crc >> 8);
            expect(content[content.length - 1]).toBe(crc & 0xff);
        });

        it("should wrap ackSeq to 3 bits", async () => {
            const ackSeq = 10; // Should become 2 (10 & 0x07)
            const outputPromise = getWriterOutput(writer);
            writer.sendACK(ackSeq);
            const chunk = await outputPromise;
            const content = extractFrameContent(chunk);
            const expectedSeqByte = (2 << 4) | 0;
            expect(content[1]).toBe(expectedSeqByte);
        });
    });

    describe("sendData", () => {
        it("should create DATA frame with payload", async () => {
            const data = Buffer.from([0x01, 0x02, 0x03]);
            const seq = 1;
            const ackSeq = 2;
            const frameId = 0x0010;

            const outputPromise = getWriterOutput(writer);
            writer.sendData(data, seq, ackSeq, frameId);
            const chunk = await outputPromise;
            const content = extractFrameContent(chunk);

            // Check frameId
            expect(content.readUInt16LE(2)).toBe(frameId);
            // Check payload (after 4-byte header, before 2-byte CRC)
            expect(content.subarray(4, -2)).toEqual(data);
        });

        it("should set correct sequence byte", async () => {
            const seq = 3;
            const ackSeq = 5;

            const outputPromise = getWriterOutput(writer);
            writer.sendData(Buffer.from([0x01]), seq, ackSeq, 0x0010);
            const chunk = await outputPromise;
            const content = extractFrameContent(chunk);
            const expectedSeqByte = ((ackSeq & 0x07) << 4) | (seq & 0x07);
            expect(content[1]).toBe(expectedSeqByte);
        });

        it("should set control byte without flags by default", async () => {
            const outputPromise = getWriterOutput(writer);
            writer.sendData(Buffer.from([0x01]), 0, 0, 0x0010);
            const chunk = await outputPromise;
            const content = extractFrameContent(chunk);
            expect(content[0]).toBe(0x00);
        });

        it("should set RETX flag when isRetransmission is true", async () => {
            const outputPromise = getWriterOutput(writer);
            writer.sendData(Buffer.from([0x01]), 0, 0, 0x0010, true);
            const chunk = await outputPromise;
            const content = extractFrameContent(chunk);
            expect(content[0] & consts.RETX).toBe(consts.RETX);
        });

        it("should set DEBUG flag when isDebug is true", async () => {
            const outputPromise = getWriterOutput(writer);
            writer.sendData(Buffer.from([0x01]), 0, 0, 0x0010, false, true);
            const chunk = await outputPromise;
            const content = extractFrameContent(chunk);
            expect(content[0] & consts.DEBUG).toBe(consts.DEBUG);
        });

        it("should set both RETX and DEBUG flags", async () => {
            const outputPromise = getWriterOutput(writer);
            writer.sendData(Buffer.from([0x01]), 0, 0, 0x0010, true, true);
            const chunk = await outputPromise;
            const content = extractFrameContent(chunk);
            expect(content[0]).toBe(consts.RETX | consts.DEBUG);
        });

        it("should handle empty data", async () => {
            const outputPromise = getWriterOutput(writer);
            writer.sendData(Buffer.from([]), 0, 0, 0x0010);
            const chunk = await outputPromise;
            const content = extractFrameContent(chunk);
            // Should only have header (4 bytes) and CRC (2 bytes)
            expect(content.length).toBe(6);
        });

        it("should include valid CRC", async () => {
            const data = Buffer.from([0x01, 0x02, 0x03]);

            const outputPromise = getWriterOutput(writer);
            writer.sendData(data, 0, 0, 0x0010);
            const chunk = await outputPromise;
            const content = extractFrameContent(chunk);
            const dataForCrc = content.subarray(0, -2);
            const crc = crc16ccitt(dataForCrc, 0xffff);

            expect(content[content.length - 2]).toBe(crc >> 8);
            expect(content[content.length - 1]).toBe(crc & 0xff);
        });
    });

    describe("sendReset", () => {
        it("should create RESET frame with frameId 0x0003", async () => {
            const outputPromise = getWriterOutput(writer);
            writer.sendReset(0, 0);
            const chunk = await outputPromise;
            const content = extractFrameContent(chunk);
            expect(content.readUInt16LE(2)).toBe(0x0003);
        });

        it("should set sequence bytes correctly", async () => {
            const seq = 2;
            const ackSeq = 4;

            const outputPromise = getWriterOutput(writer);
            writer.sendReset(seq, ackSeq);
            const chunk = await outputPromise;
            const content = extractFrameContent(chunk);
            const expectedSeqByte = ((ackSeq & 0x07) << 4) | (seq & 0x07);
            expect(content[1]).toBe(expectedSeqByte);
        });

        it("should set RETX flag when specified", async () => {
            const outputPromise = getWriterOutput(writer);
            writer.sendReset(0, 0, true);
            const chunk = await outputPromise;
            const content = extractFrameContent(chunk);
            expect(content[0] & consts.RETX).toBe(consts.RETX);
        });

        it("should set DEBUG flag when specified", async () => {
            const outputPromise = getWriterOutput(writer);
            writer.sendReset(0, 0, false, true);
            const chunk = await outputPromise;
            const content = extractFrameContent(chunk);
            expect(content[0] & consts.DEBUG).toBe(consts.DEBUG);
        });

        it("should not stringify reset frames unless debug logging evaluates the message", async () => {
            const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
            const toStringSpy = vi.spyOn(Buffer.prototype, "toString").mockImplementation(() => {
                throw new Error("eager reset hex string");
            });

            try {
                const outputPromise = getWriterOutput(writer);

                expect(() => writer.sendReset(0, 0)).not.toThrow();
                await outputPromise;
                expect(debug).toHaveBeenCalledWith(expect.any(Function), expect.any(String));
            } finally {
                toStringSpy.mockRestore();
                debug.mockRestore();
            }
        });
    });

    describe("Byte stuffing", () => {
        it("should stuff START byte in payload", async () => {
            const data = Buffer.from([0x00, consts.START, 0x00]);

            const outputPromise = getWriterOutput(writer);
            writer.sendData(data, 0, 0, 0x0010);
            const chunk = await outputPromise;

            // The raw chunk should contain escape sequence for START
            const innerContent = chunk.subarray(1, -1); // Remove START/END delimiters
            expect(innerContent.includes(consts.ESCAPE)).toBe(true);

            // But after unstuffing, we should get the original data back
            const content = extractFrameContent(chunk);
            expect(content.subarray(4, -2)).toEqual(data);
        });

        it("should stuff END byte in payload", async () => {
            const data = Buffer.from([0x00, consts.END, 0x00]);

            const outputPromise = getWriterOutput(writer);
            writer.sendData(data, 0, 0, 0x0010);
            const chunk = await outputPromise;
            const content = extractFrameContent(chunk);
            expect(content.subarray(4, -2)).toEqual(data);
        });

        it("should stuff ESCAPE byte in payload", async () => {
            const data = Buffer.from([0x00, consts.ESCAPE, 0x00]);

            const outputPromise = getWriterOutput(writer);
            writer.sendData(data, 0, 0, 0x0010);
            const chunk = await outputPromise;
            const content = extractFrameContent(chunk);
            expect(content.subarray(4, -2)).toEqual(data);
        });

        it("should handle multiple reserved bytes", async () => {
            const data = Buffer.from([consts.START, consts.END, consts.ESCAPE, consts.START]);

            const outputPromise = getWriterOutput(writer);
            writer.sendData(data, 0, 0, 0x0010);
            const chunk = await outputPromise;
            const content = extractFrameContent(chunk);
            expect(content.subarray(4, -2)).toEqual(data);
        });

        it("should stuff reserved bytes in header/CRC area too", async () => {
            // Use a frameId that might produce START/END/ESCAPE in the buffer
            const frameId = consts.START | (consts.END << 8);

            const outputPromise = getWriterOutput(writer);
            writer.sendData(Buffer.from([0x01]), 0, 0, frameId);
            const chunk = await outputPromise;
            const content = extractFrameContent(chunk);
            expect(content.readUInt16LE(2)).toBe(frameId);
        });
    });

    describe("Frame structure", () => {
        it("should wrap frame with START and END delimiters", async () => {
            const outputPromise = getWriterOutput(writer);
            writer.sendData(Buffer.from([0x01]), 0, 0, 0x0010);
            const chunk = await outputPromise;
            expect(chunk[0]).toBe(consts.START);
            expect(chunk[chunk.length - 1]).toBe(consts.END);
        });

        it("should produce correct frame order: [START, control, seq, frameId_lo, frameId_hi, data..., crc_hi, crc_lo, END]", async () => {
            const data = Buffer.from([0xaa, 0xbb]);
            const seq = 1;
            const ackSeq = 2;
            const frameId = 0x1234;

            const outputPromise = getWriterOutput(writer);
            writer.sendData(data, seq, ackSeq, frameId);
            const chunk = await outputPromise;
            const content = extractFrameContent(chunk);

            // Control byte
            expect(content[0]).toBe(0x00);
            // Sequence byte
            expect(content[1]).toBe(((ackSeq & 0x07) << 4) | (seq & 0x07));
            // Frame ID (little-endian)
            expect(content[2]).toBe(0x34); // Low byte
            expect(content[3]).toBe(0x12); // High byte
            // Payload
            expect(content[4]).toBe(0xaa);
            expect(content[5]).toBe(0xbb);
            // CRC (2 bytes at end - verified by other tests)
            expect(content.length).toBe(8); // 4 header + 2 data + 2 CRC
        });
    });

    describe("_read", () => {
        it("should be a no-op function", () => {
            // _read is required by Readable stream but does nothing
            expect(() => writer._read()).not.toThrow();
        });
    });
});
