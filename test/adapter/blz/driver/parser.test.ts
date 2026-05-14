import {describe, expect, it, vi, beforeEach} from 'vitest';
import {Parser} from '../../../../src/adapter/blz/driver/parser';
import * as consts from '../../../../src/adapter/blz/driver/consts';
import crc16ccitt from '../../../../src/adapter/blz/driver/utils/crc16ccitt';
import {logger} from '../../../../src/utils/logger';

describe('BLZ Parser', () => {
    let parser: Parser;

    /**
     * Creates a properly framed buffer with START, END, stuffing and CRC
     */
    function createCompleteFrame(control: number, sequence: number, frameId: number, payload?: Buffer): Buffer {
        const headerLength = 4;
        const payloadLength = payload ? payload.length : 0;
        const dataBuffer = Buffer.alloc(headerLength + payloadLength);

        dataBuffer[0] = control;
        dataBuffer[1] = sequence;
        dataBuffer.writeUInt16LE(frameId, 2);

        if (payload) {
            payload.copy(dataBuffer, headerLength);
        }

        // Calculate CRC
        const crc = crc16ccitt(dataBuffer, 0xffff);
        const frameWithCrc = Buffer.concat([dataBuffer, Buffer.from([crc >> 8, crc & 0xFF])]);

        // Apply stuffing
        const stuffed: number[] = [];
        for (const byte of frameWithCrc) {
            if ([consts.START, consts.END, consts.ESCAPE].includes(byte)) {
                stuffed.push(consts.ESCAPE);
                stuffed.push(byte ^ consts.STUFF);
            } else {
                stuffed.push(byte);
            }
        }

        // Add delimiters
        return Buffer.from([consts.START, ...stuffed, consts.END]);
    }

    /**
     * Helper to get parsed frame from parser
     */
    function getParsedFrame(parser: Parser): Promise<any> {
        return new Promise((resolve) => {
            parser.once('parsed', (frame) => {
                resolve(frame);
            });
        });
    }

    /**
     * Helper to collect multiple parsed frames
     */
    function collectFrames(parser: Parser, count: number): Promise<any[]> {
        return new Promise((resolve) => {
            const frames: any[] = [];
            const handler = (frame: any) => {
                frames.push(frame);
                if (frames.length === count) {
                    parser.off('parsed', handler);
                    resolve(frames);
                }
            };
            parser.on('parsed', handler);
        });
    }

    beforeEach(() => {
        parser = new Parser();
    });

    describe('Frame parsing', () => {
        it('should parse a complete frame', async () => {
            const frame = createCompleteFrame(0x00, 0x01, 0x0010);
            const parsePromise = getParsedFrame(parser);
            parser._transform(frame, 'binary', () => {});
            const parsedFrame = await parsePromise;

            expect(parsedFrame.control).toBe(0x00);
            expect(parsedFrame.sequence).toBe(0x01);
            expect(parsedFrame.frameId).toBe(0x0010);
        });

        it('should parse frame with payload', async () => {
            const payload = Buffer.from([0x01, 0x02, 0x03, 0x04]);
            const frame = createCompleteFrame(0x00, 0x01, 0x0010, payload);
            const parsePromise = getParsedFrame(parser);
            parser._transform(frame, 'binary', () => {});
            const parsedFrame = await parsePromise;

            expect(parsedFrame.payload).toEqual(payload);
        });

        it('should parse multiple frames in single chunk', async () => {
            const frame1 = createCompleteFrame(0x00, 0x01, 0x0010);
            const frame2 = createCompleteFrame(0x00, 0x02, 0x0011);
            const combined = Buffer.concat([frame1, frame2]);

            const framesPromise = collectFrames(parser, 2);
            parser._transform(combined, 'binary', () => {});
            const frames = await framesPromise;

            expect(frames[0].frameId).toBe(0x0010);
            expect(frames[0].sequence).toBe(0x01);
            expect(frames[1].frameId).toBe(0x0011);
            expect(frames[1].sequence).toBe(0x02);
        });

        it('should handle fragmented frames across multiple chunks', async () => {
            const frame = createCompleteFrame(0x00, 0x01, 0x0010);
            const mid = Math.floor(frame.length / 2);
            const part1 = frame.subarray(0, mid);
            const part2 = frame.subarray(mid);

            const parsePromise = getParsedFrame(parser);
            parser._transform(part1, 'binary', () => {});
            parser._transform(part2, 'binary', () => {});
            const parsedFrame = await parsePromise;

            expect(parsedFrame.frameId).toBe(0x0010);
        });
    });

    describe('Byte unstuffing', () => {
        it('should unstuff escaped START byte', async () => {
            // Create a payload that contains the START byte value
            const payloadWithStart = Buffer.from([0x00, consts.START, 0x00]);
            const frame = createCompleteFrame(0x00, 0x01, 0x0010, payloadWithStart);

            const parsePromise = getParsedFrame(parser);
            parser._transform(frame, 'binary', () => {});
            const parsedFrame = await parsePromise;

            expect(parsedFrame.payload[1]).toBe(consts.START);
        });

        it('should unstuff escaped END byte', async () => {
            const payloadWithEnd = Buffer.from([0x00, consts.END, 0x00]);
            const frame = createCompleteFrame(0x00, 0x01, 0x0010, payloadWithEnd);

            const parsePromise = getParsedFrame(parser);
            parser._transform(frame, 'binary', () => {});
            const parsedFrame = await parsePromise;

            expect(parsedFrame.payload[1]).toBe(consts.END);
        });

        it('should unstuff escaped ESCAPE byte', async () => {
            const payloadWithEscape = Buffer.from([0x00, consts.ESCAPE, 0x00]);
            const frame = createCompleteFrame(0x00, 0x01, 0x0010, payloadWithEscape);

            const parsePromise = getParsedFrame(parser);
            parser._transform(frame, 'binary', () => {});
            const parsedFrame = await parsePromise;

            expect(parsedFrame.payload[1]).toBe(consts.ESCAPE);
        });

        it('should handle multiple escaped bytes in sequence', async () => {
            const payloadWithMultiple = Buffer.from([consts.START, consts.END, consts.ESCAPE]);
            const frame = createCompleteFrame(0x00, 0x01, 0x0010, payloadWithMultiple);

            const parsePromise = getParsedFrame(parser);
            parser._transform(frame, 'binary', () => {});
            const parsedFrame = await parsePromise;

            expect(parsedFrame.payload[0]).toBe(consts.START);
            expect(parsedFrame.payload[1]).toBe(consts.END);
            expect(parsedFrame.payload[2]).toBe(consts.ESCAPE);
        });
    });

    describe('reset', () => {
        it('should clear the tail buffer', () => {
            const frame = createCompleteFrame(0x00, 0x01, 0x0010);
            const partial = frame.subarray(0, frame.length - 2); // Incomplete frame

            parser._transform(partial, 'binary', () => {});
            parser.reset();

            // After reset, sending the rest should not complete the frame
            const parsed = vi.fn();
            parser.on('parsed', parsed);

            const rest = frame.subarray(frame.length - 2);
            parser._transform(rest, 'binary', () => {});

            expect(parsed).not.toHaveBeenCalled();
        });

        it('should allow new frames after reset', async () => {
            parser.reset();

            const frame = createCompleteFrame(0x00, 0x01, 0x0010);
            const parsePromise = getParsedFrame(parser);
            parser._transform(frame, 'binary', () => {});
            const parsedFrame = await parsePromise;

            expect(parsedFrame.frameId).toBe(0x0010);
        });
    });

    describe('Error handling', () => {
        it('should handle invalid frame gracefully', () => {
            // Create an invalid frame (too short after delimiters)
            const invalidFrame = Buffer.from([consts.START, 0x00, 0x01, consts.END]);

            const parsed = vi.fn();
            parser.on('parsed', parsed);

            // Should not throw
            expect(() => parser._transform(invalidFrame, 'binary', () => {})).not.toThrow();
            expect(parsed).not.toHaveBeenCalled();
        });

        it('should continue parsing after error', async () => {
            const invalidFrame = Buffer.from([consts.START, 0x00, 0x01, consts.END]);
            const validFrame = createCompleteFrame(0x00, 0x01, 0x0010);
            const combined = Buffer.concat([invalidFrame, validFrame]);

            const parsePromise = getParsedFrame(parser);
            parser._transform(combined, 'binary', () => {});
            const parsedFrame = await parsePromise;

            expect(parsedFrame.frameId).toBe(0x0010);
        });

        it('should ignore data before first START delimiter', async () => {
            const garbage = Buffer.from([0xFF, 0xFE, 0xFD]);
            const frame = createCompleteFrame(0x00, 0x01, 0x0010);
            const combined = Buffer.concat([garbage, frame]);

            const parsePromise = getParsedFrame(parser);
            parser._transform(combined, 'binary', () => {});
            const parsedFrame = await parsePromise;

            expect(parsedFrame.frameId).toBe(0x0010);
        });

        it('should drop garbage without START delimiter without retaining it as tail', () => {
            const warning = vi.spyOn(logger, 'warning');
            const garbage = Buffer.alloc(16385, 0xff);

            parser._transform(garbage, 'binary', () => {});

            expect(warning).not.toHaveBeenCalledWith(
                expect.stringContaining('Parser buffer overflow'),
                expect.anything(),
            );
        });

        it('should trim garbage before an incomplete START-delimited tail', () => {
            const garbage = Buffer.from([0xff, 0xfe, 0xfd]);
            const partial = Buffer.from([consts.START, 0x01, 0x02]);

            parser._transform(Buffer.concat([garbage, partial]), 'binary', () => {});

            const tail = (parser as unknown as {tail: Buffer[]}).tail;
            expect(Buffer.concat(tail)).toEqual(partial);
        });
    });

    describe('Frame types', () => {
        it('should parse ACK frame', async () => {
            const frame = createCompleteFrame(0x80, 0x00, 0x0001);

            const parsePromise = getParsedFrame(parser);
            parser._transform(frame, 'binary', () => {});
            const parsedFrame = await parsePromise;

            expect(parsedFrame.frameId).toBe(0x0001);
        });

        it('should parse RESET frame', async () => {
            const frame = createCompleteFrame(0x00, 0x00, 0x0003);

            const parsePromise = getParsedFrame(parser);
            parser._transform(frame, 'binary', () => {});
            const parsedFrame = await parsePromise;

            expect(parsedFrame.frameId).toBe(0x0003);
        });

        it('should parse getValue response', async () => {
            const payload = Buffer.from([0x00, 0x02, 0xAB, 0xCD]); // status=0, len=2, value
            const frame = createCompleteFrame(0x00, 0x01, 0x0010, payload);

            const parsePromise = getParsedFrame(parser);
            parser._transform(frame, 'binary', () => {});
            const parsedFrame = await parsePromise;

            expect(parsedFrame.frameId).toBe(0x0010);
            expect(parsedFrame.payload).toEqual(payload);
        });

        it('should parse apsDataIndication', async () => {
            const payload = Buffer.from([
                0x04, 0x01, // profileId
                0x06, 0x00, // clusterId
                0x00, 0x00, // srcShortAddr
                0x00, 0x00, // dstShortAddr
                0x01,       // srcEp
                0x01,       // dstEp
                0x00,       // msgType
                0xFF,       // lqi
                0x00,       // rssi
                0x03,       // messageLength
                0x01, 0x02, 0x03 // message
            ]);
            const frame = createCompleteFrame(0x00, 0x01, 0x0082, payload);

            const parsePromise = getParsedFrame(parser);
            parser._transform(frame, 'binary', () => {});
            const parsedFrame = await parsePromise;

            expect(parsedFrame.frameId).toBe(0x0082);
        });
    });

    describe('Stream behavior', () => {
        it('should call callback after processing', () => {
            const callback = vi.fn();
            const frame = createCompleteFrame(0x00, 0x01, 0x0010);

            parser._transform(frame, 'binary', callback);
            expect(callback).toHaveBeenCalled();
        });

        it('should call callback even with incomplete data', () => {
            const callback = vi.fn();
            const incomplete = Buffer.from([consts.START, 0x00, 0x01]);

            parser._transform(incomplete, 'binary', callback);
            expect(callback).toHaveBeenCalled();
        });
    });
});
