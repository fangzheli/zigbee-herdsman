import {describe, expect, it} from 'vitest';
import {Frame} from '../../../../src/adapter/blz/driver/frame';
import crc16ccitt from '../../../../src/adapter/blz/driver/utils/crc16ccitt';

describe('BLZ Frame', () => {
    /**
     * Creates a valid frame buffer with proper CRC
     */
    function createFrameBuffer(control: number, sequence: number, frameId: number, payload?: Buffer): Buffer {
        const headerLength = 4; // control + sequence + frameId (2 bytes)
        const crcLength = 2;
        const payloadLength = payload ? payload.length : 0;
        const buffer = Buffer.alloc(headerLength + payloadLength + crcLength);

        buffer[0] = control;
        buffer[1] = sequence;
        buffer.writeUInt16LE(frameId, 2);

        if (payload) {
            payload.copy(buffer, headerLength);
        }

        // Calculate and append CRC
        const data = buffer.subarray(0, -2);
        const crc = crc16ccitt(data, 0xffff);
        buffer[buffer.length - 2] = crc >> 8;
        buffer[buffer.length - 1] = crc & 0xFF;

        return buffer;
    }

    describe('Constructor', () => {
        it('should parse a valid frame buffer', () => {
            const buffer = createFrameBuffer(0x00, 0x01, 0x0010);
            const frame = new Frame(buffer);

            expect(frame.control).toBe(0x00);
            expect(frame.sequence).toBe(0x01);
            expect(frame.frameId).toBe(0x0010);
            expect(frame.payload.length).toBe(0);
            expect(frame.buffer).toBe(buffer);
        });

        it('should parse frame with payload', () => {
            const payload = Buffer.from([0x01, 0x02, 0x03, 0x04]);
            const buffer = createFrameBuffer(0x80, 0x15, 0x0020, payload);
            const frame = new Frame(buffer);

            expect(frame.control).toBe(0x80);
            expect(frame.sequence).toBe(0x15);
            expect(frame.frameId).toBe(0x0020);
            expect(frame.payload).toEqual(payload);
        });

        it('should not retain a large source buffer when constructed from a sliced frame', () => {
            const payload = Buffer.from([0x01, 0x02, 0x03, 0x04]);
            const buffer = createFrameBuffer(0x80, 0x15, 0x0020, payload);
            const chunk = Buffer.alloc(20000, 0);
            const startOffset = chunk.length - buffer.length;
            buffer.copy(chunk, startOffset);

            const frame = new Frame(chunk.subarray(startOffset));

            expect(frame.buffer).toEqual(buffer);
            expect(frame.buffer.buffer).not.toBe(chunk.buffer);
            expect(frame.payload).toEqual(payload);
            expect(frame.payload.buffer).not.toBe(chunk.buffer);
        });

        it('should throw error for invalid frame length', () => {
            const buffer = Buffer.from([0x00, 0x01, 0x10]); // Too short
            expect(() => new Frame(buffer)).toThrow('Invalid frame length: 3');
        });

        it('should handle minimum valid frame length', () => {
            const buffer = createFrameBuffer(0x00, 0x00, 0x0001);
            expect(buffer.length).toBe(6); // 4 header + 2 CRC
            const frame = new Frame(buffer);
            expect(frame.frameId).toBe(0x0001);
        });

        it('should correctly parse frameId in little-endian', () => {
            // Frame ID 0x1234 should be stored as [0x34, 0x12] in little-endian
            const buffer = createFrameBuffer(0x00, 0x00, 0x1234);
            const frame = new Frame(buffer);
            expect(frame.frameId).toBe(0x1234);
            expect(buffer[2]).toBe(0x34); // Low byte
            expect(buffer[3]).toBe(0x12); // High byte
        });
    });

    describe('fromBuffer factory method', () => {
        it('should create frame from buffer', () => {
            const buffer = createFrameBuffer(0x00, 0x02, 0x0010);
            const frame = Frame.fromBuffer(buffer);

            expect(frame).toBeInstanceOf(Frame);
            expect(frame.control).toBe(0x00);
            expect(frame.sequence).toBe(0x02);
            expect(frame.frameId).toBe(0x0010);
        });
    });

    describe('checkCRC', () => {
        it('should pass for valid CRC', () => {
            const buffer = createFrameBuffer(0x00, 0x01, 0x0010);
            const frame = new Frame(buffer);
            expect(() => frame.checkCRC()).not.toThrow();
        });

        it('should pass for frame with payload', () => {
            const payload = Buffer.from([0x01, 0x02, 0x03]);
            const buffer = createFrameBuffer(0x00, 0x01, 0x0010, payload);
            const frame = new Frame(buffer);
            expect(() => frame.checkCRC()).not.toThrow();
        });

        it('should throw error for invalid CRC', () => {
            const buffer = createFrameBuffer(0x00, 0x01, 0x0010);
            // Corrupt the CRC
            buffer[buffer.length - 1] ^= 0xFF;
            const frame = new Frame(buffer);
            expect(() => frame.checkCRC()).toThrow('CRC mismatch');
        });

        it('should throw error if data is corrupted', () => {
            const buffer = createFrameBuffer(0x00, 0x01, 0x0010);
            // Corrupt the control byte after CRC was calculated
            buffer[0] = 0xFF;
            const frame = new Frame(buffer);
            expect(() => frame.checkCRC()).toThrow('CRC mismatch');
        });
    });

    describe('toString', () => {
        it('should return hex string representation', () => {
            const buffer = createFrameBuffer(0x00, 0x01, 0x0010);
            const frame = new Frame(buffer);
            expect(frame.toString()).toBe(buffer.toString('hex'));
        });

        it('should include payload in hex string', () => {
            const payload = Buffer.from([0xAB, 0xCD]);
            const buffer = createFrameBuffer(0x00, 0x01, 0x0010, payload);
            const frame = new Frame(buffer);
            expect(frame.toString()).toContain('abcd');
        });
    });

    describe('Frame types', () => {
        it('should parse ACK frame (ID 0x0001)', () => {
            const buffer = createFrameBuffer(0x80, 0x00, 0x0001);
            const frame = new Frame(buffer);
            expect(frame.frameId).toBe(0x0001);
        });

        it('should parse ERROR frame (ID 0x0002)', () => {
            const payload = Buffer.from([0x05]); // Error code
            const buffer = createFrameBuffer(0x00, 0x00, 0x0002, payload);
            const frame = new Frame(buffer);
            expect(frame.frameId).toBe(0x0002);
            expect(frame.payload[0]).toBe(0x05);
        });

        it('should parse RESET frame (ID 0x0003)', () => {
            const buffer = createFrameBuffer(0x00, 0x00, 0x0003);
            const frame = new Frame(buffer);
            expect(frame.frameId).toBe(0x0003);
        });

        it('should parse getValue frame (ID 0x0010)', () => {
            const payload = Buffer.from([0x00, 0x02, 0xAB, 0xCD]); // status, length, value
            const buffer = createFrameBuffer(0x00, 0x01, 0x0010, payload);
            const frame = new Frame(buffer);
            expect(frame.frameId).toBe(0x0010);
            expect(frame.payload).toEqual(payload);
        });

        it('should parse sendApsData frame (ID 0x0080)', () => {
            const payload = Buffer.from([0x00, 0x01, 0x02, 0x03]);
            const buffer = createFrameBuffer(0x00, 0x01, 0x0080, payload);
            const frame = new Frame(buffer);
            expect(frame.frameId).toBe(0x0080);
        });
    });

    describe('Control byte parsing', () => {
        it('should parse control byte with DEBUG flag', () => {
            const buffer = createFrameBuffer(0x80, 0x00, 0x0001);
            const frame = new Frame(buffer);
            expect(frame.control).toBe(0x80);
            expect(frame.control & 0x80).toBe(0x80); // DEBUG flag set
        });

        it('should parse control byte with RETX flag', () => {
            const buffer = createFrameBuffer(0x01, 0x00, 0x0001);
            const frame = new Frame(buffer);
            expect(frame.control).toBe(0x01);
            expect(frame.control & 0x01).toBe(0x01); // RETX flag set
        });

        it('should parse control byte with combined flags', () => {
            const buffer = createFrameBuffer(0x81, 0x00, 0x0001);
            const frame = new Frame(buffer);
            expect(frame.control).toBe(0x81);
            expect(frame.control & 0x80).toBe(0x80); // DEBUG flag set
            expect(frame.control & 0x01).toBe(0x01); // RETX flag set
        });
    });

    describe('Sequence byte parsing', () => {
        it('should extract ackSeq from sequence byte', () => {
            // Sequence byte format: (ackSeq & 0x07) << 4 | (seq & 0x07)
            // For ackSeq=3, seq=5: (3 << 4) | 5 = 0x35
            const buffer = createFrameBuffer(0x00, 0x35, 0x0001);
            const frame = new Frame(buffer);
            expect(frame.sequence).toBe(0x35);
            expect((frame.sequence >> 4) & 0x07).toBe(3); // ackSeq
            expect(frame.sequence & 0x07).toBe(5); // seq
        });

        it('should handle sequence wrap-around', () => {
            // Max values: ackSeq=7, seq=7
            const buffer = createFrameBuffer(0x00, 0x77, 0x0001);
            const frame = new Frame(buffer);
            expect((frame.sequence >> 4) & 0x07).toBe(7);
            expect(frame.sequence & 0x07).toBe(7);
        });
    });
});
