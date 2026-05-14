import * as fs from 'node:fs';

import {describe, expect, it, vi} from 'vitest';
import {
    int8s,
    int16s,
    int32s,
    int64s,
    uint8_t,
    uint16_t,
    uint24_t,
    uint32_t,
    uint64_t,
    LVBytes,
    list,
    LVList,
    fixed_list,
    Bytes,
    Fixed16Bytes,
    WordList,
    int_t,
} from '../../../../src/adapter/blz/driver/types/basic';
import {deserialize as deserializeSchema, serialize as serializeSchema} from '../../../../src/adapter/blz/driver/types';
import {
    BlzEUI64,
    BlzValueId,
    BlzStatus,
    BlzNodeType,
    BlzOutgoingMessageType,
    BlzApsOption,
} from '../../../../src/adapter/blz/driver/types/named';
import {BlzApsFrame} from '../../../../src/adapter/blz/driver/types/struct';

function expectWithoutBufferConcat(action: () => Buffer, expected: Buffer): void {
    const concatSpy = vi.spyOn(Buffer, 'concat').mockImplementation(() => {
        throw new Error('Buffer.concat used');
    });

    try {
        expect(action()).toEqual(expected);
        expect(concatSpy).not.toHaveBeenCalled();
    } finally {
        concatSpy.mockRestore();
    }
}

function expectWithoutArrayMap(action: () => Buffer, expected: Buffer): void {
    const mapSpy = vi.spyOn(Array.prototype, 'map').mockImplementation(() => {
        throw new Error('Array.map used');
    });
    let result: Buffer | undefined;

    try {
        result = action();
    } finally {
        mapSpy.mockRestore();
    }

    expect(result).toEqual(expected);
}

describe('BLZ Types', () => {
    describe('Architecture', () => {
        it('should not keep legacy ZDO-only helper types in the BLZ type layer', () => {
            const namedSource = fs.readFileSync('src/adapter/blz/driver/types/named.ts', 'utf8');
            const structSource = fs.readFileSync('src/adapter/blz/driver/types/struct.ts', 'utf8');
            const indexSource = fs.readFileSync('src/adapter/blz/driver/types/index.ts', 'utf8');
            const basicSource = fs.readFileSync('src/adapter/blz/driver/types/basic.ts', 'utf8');

            for (const source of [namedSource, structSource, indexSource]) {
                expect(source).not.toContain('BlzZDOCmd');
                expect(source).not.toContain('BlzMultiAddress');
                expect(source).not.toContain('BlzNodeDescriptor');
                expect(source).not.toContain('BlzSimpleDescriptor');
                expect(source).not.toContain('BlzNeighbors');
                expect(source).not.toContain('BlzRoutingTable');
            }

            expect(namedSource).not.toContain('export class BlzNodeId');
            expect(namedSource).not.toContain('export class Bool');
            expect(structSource).not.toContain('BlzNeighborTableEntry');
            expect(structSource).not.toContain('BlzRouteTableEntry');
            expect(basicSource).not.toContain('serializeBufferSegments');
        });
    });

    describe('Basic Integer Types', () => {
        describe('uint8_t', () => {
            it('should serialize 8-bit unsigned integer', () => {
                const result = uint8_t.serialize(uint8_t, 255);
                expect(result).toEqual(Buffer.from([0xFF]));
            });

            it('should serialize zero', () => {
                const result = uint8_t.serialize(uint8_t, 0);
                expect(result).toEqual(Buffer.from([0x00]));
            });

            it('should deserialize 8-bit unsigned integer', () => {
                const [value, remaining] = uint8_t.deserialize(uint8_t, Buffer.from([0xAB, 0xCD]));
                expect(value).toBe(0xAB);
                expect(remaining).toEqual(Buffer.from([0xCD]));
            });

            it('should throw on buffer too small', () => {
                expect(() => uint8_t.deserialize(uint8_t, Buffer.from([]))).toThrow(RangeError);
            });
        });

        describe('uint16_t', () => {
            it('should serialize 16-bit unsigned integer in little-endian', () => {
                const result = uint16_t.serialize(uint16_t, 0x1234);
                expect(result).toEqual(Buffer.from([0x34, 0x12]));
            });

            it('should deserialize 16-bit unsigned integer', () => {
                const [value, remaining] = uint16_t.deserialize(uint16_t, Buffer.from([0x34, 0x12, 0xAB]));
                expect(value).toBe(0x1234);
                expect(remaining).toEqual(Buffer.from([0xAB]));
            });

            it('should handle max value', () => {
                const result = uint16_t.serialize(uint16_t, 0xFFFF);
                expect(result).toEqual(Buffer.from([0xFF, 0xFF]));
            });
        });

        describe('uint24_t', () => {
            it('should serialize 24-bit unsigned integer', () => {
                const result = uint24_t.serialize(uint24_t, 0x123456);
                expect(result).toEqual(Buffer.from([0x56, 0x34, 0x12]));
            });

            it('should deserialize 24-bit unsigned integer', () => {
                const [value] = uint24_t.deserialize(uint24_t, Buffer.from([0x56, 0x34, 0x12]));
                expect(value).toBe(0x123456);
            });
        });

        describe('uint32_t', () => {
            it('should serialize 32-bit unsigned integer', () => {
                const result = uint32_t.serialize(uint32_t, 0x12345678);
                expect(result).toEqual(Buffer.from([0x78, 0x56, 0x34, 0x12]));
            });

            it('should serialize integer buffers without zero-fill allocation', () => {
                const allocSpy = vi.spyOn(Buffer, 'alloc').mockImplementation(() => {
                    throw new Error('Buffer.alloc used');
                });

                try {
                    const result = uint32_t.serialize(uint32_t, 0x12345678);

                    expect(result).toEqual(Buffer.from([0x78, 0x56, 0x34, 0x12]));
                    expect(allocSpy).not.toHaveBeenCalled();
                } finally {
                    allocSpy.mockRestore();
                }
            });

            it('should deserialize 32-bit unsigned integer', () => {
                const [value] = uint32_t.deserialize(uint32_t, Buffer.from([0x78, 0x56, 0x34, 0x12]));
                expect(value).toBe(0x12345678);
            });
        });

        describe('uint64_t', () => {
            it('should serialize 64-bit unsigned integer', () => {
                const result = uint64_t.serialize(uint64_t, BigInt('0x0102030405060708'));
                expect(result.length).toBe(8);
                expect(result[0]).toBe(0x08);
                expect(result[7]).toBe(0x01);
            });

            it('should deserialize 64-bit unsigned integer', () => {
                const buffer = Buffer.from([0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]);
                const [value] = uint64_t.deserialize(uint64_t, buffer);
                expect(value).toBe(BigInt('0x0102030405060708'));
            });

            it('should handle conversion from number', () => {
                const result = uint64_t.serialize(uint64_t, 12345678);
                expect(result.length).toBe(8);
            });
        });

        describe('Signed integers', () => {
            it('should serialize signed 8-bit integer', () => {
                const result = int8s.serialize(int8s, -1);
                expect(result).toEqual(Buffer.from([0xFF]));
            });

            it('should deserialize signed 8-bit integer', () => {
                const [value] = int8s.deserialize(int8s, Buffer.from([0xFF]));
                expect(value).toBe(-1);
            });

            it('should serialize signed 16-bit integer', () => {
                const result = int16s.serialize(int16s, -1000);
                expect(result.length).toBe(2);
            });

            it('should deserialize signed 16-bit integer', () => {
                const buffer = int16s.serialize(int16s, -1000);
                const [value] = int16s.deserialize(int16s, buffer);
                expect(value).toBe(-1000);
            });

            it('should serialize signed 32-bit integer', () => {
                const result = int32s.serialize(int32s, -100000);
                expect(result.length).toBe(4);
            });

            it('should serialize signed 64-bit integer', () => {
                const result = int64s.serialize(int64s, BigInt(-1));
                expect(result.length).toBe(8);
            });
        });
    });

    describe('Buffer from value', () => {
        it('should serialize from Buffer input', () => {
            const buffer = Buffer.from([0x12, 0x34]);
            const result = uint16_t.serialize(uint16_t, buffer);
            expect(result.length).toBe(2);
        });

        it('should throw for invalid value type', () => {
            expect(() => uint8_t.serialize(uint8_t, 'invalid' as any)).toThrow(TypeError);
        });
    });

    describe('LVBytes', () => {
        it('should serialize length-prefixed bytes from array', () => {
            const result = LVBytes.serialize(LVBytes, [0x01, 0x02, 0x03]);
            expect(result).toEqual(Buffer.from([0x03, 0x01, 0x02, 0x03]));
        });

        it('should serialize length-prefixed bytes from Buffer', () => {
            const result = LVBytes.serialize(LVBytes, Buffer.from([0xAB, 0xCD]));
            expect(result).toEqual(Buffer.from([0x02, 0xAB, 0xCD]));
        });

        it('should serialize Buffer without Buffer.concat', () => {
            expectWithoutBufferConcat(
                () => LVBytes.serialize(LVBytes, Buffer.from([0xAB, 0xCD])),
                Buffer.from([0x02, 0xAB, 0xCD]),
            );
        });

        it('should serialize array input without cloning it through Buffer.from', () => {
            const value = [0xAB, 0xCD];
            const expected = Buffer.of(0x02, 0xAB, 0xCD);
            const originalFrom = Buffer.from;
            const fromSpy = vi.spyOn(Buffer, 'from').mockImplementation(((input: unknown, ...args: unknown[]) => {
                if (input === value) {
                    throw new Error('array input clone used');
                }

                return (originalFrom as (...parameters: unknown[]) => Buffer)(input, ...args);
            }) as typeof Buffer.from);

            try {
                expect(LVBytes.serialize(LVBytes, value)).toEqual(expected);
                expect(fromSpy).not.toHaveBeenCalledWith(value);
            } finally {
                fromSpy.mockRestore();
            }
        });

        it('should deserialize length-prefixed bytes', () => {
            const [value, remaining] = LVBytes.deserialize(LVBytes, Buffer.from([0x02, 0xAB, 0xCD, 0xEF]));
            expect(value).toEqual(Buffer.from([0xAB, 0xCD]));
            expect(remaining).toEqual(Buffer.from([0xEF]));
        });

        it('should reject truncated length-prefixed bytes', () => {
            expect(() => LVBytes.deserialize(LVBytes, Buffer.from([0x02, 0xAB]))).toThrow(RangeError);
        });

        it('should reject a missing length prefix when deserializing length-prefixed bytes', () => {
            expect(() => LVBytes.deserialize(LVBytes, Buffer.alloc(0))).toThrow('Expected at least 1 byte');
        });

        it('should handle empty bytes', () => {
            const result = LVBytes.serialize(LVBytes, []);
            expect(result).toEqual(Buffer.from([0x00]));
        });
    });

    describe('Bytes', () => {
        it('should serialize bytes', () => {
            const result = Bytes.serialize(Bytes, [0x01, 0x02, 0x03]);
            expect(result).toEqual(Buffer.from([0x01, 0x02, 0x03]));
        });

        it('should serialize array input without cloning it through Buffer.from', () => {
            const input = [0x01, 0x02, 0x03];
            const expected = Buffer.of(0x01, 0x02, 0x03);
            const originalFrom = Buffer.from;
            const fromSpy = vi.spyOn(Buffer, 'from').mockImplementation(((value: unknown, ...args: unknown[]) => {
                if (value === input) {
                    throw new Error('array input clone used');
                }

                return (originalFrom as (...parameters: unknown[]) => Buffer)(value, ...args);
            }) as typeof Buffer.from);

            try {
                expect(Bytes.serialize(Bytes, input)).toEqual(expected);
                expect(fromSpy).not.toHaveBeenCalledWith(input);
            } finally {
                fromSpy.mockRestore();
            }
        });

        it('should serialize Buffer input without cloning it first', () => {
            const input = Buffer.from([0x01, 0x02, 0x03]);
            const originalFrom = Buffer.from;
            const fromSpy = vi.spyOn(Buffer, 'from').mockImplementation(((value: unknown, ...args: unknown[]) => {
                if (value === input) {
                    throw new Error('Buffer.from input clone used');
                }

                return (originalFrom as (...parameters: unknown[]) => Buffer)(value, ...args);
            }) as typeof Buffer.from);

            try {
                const result = Bytes.serialize(Bytes, input);

                expect(result).toBe(input);
                expect(fromSpy).not.toHaveBeenCalledWith(input);
            } finally {
                fromSpy.mockRestore();
            }
        });

        it('should deserialize remaining bytes', () => {
            const [value, remaining] = Bytes.deserialize(Bytes, Buffer.from([0x01, 0x02, 0x03]));
            expect(value).toEqual(Buffer.from([0x01, 0x02, 0x03]));
            expect(remaining).toEqual(Buffer.alloc(0));
        });

        it('should deserialize terminal bytes without allocating a new empty remainder', () => {
            const data = Buffer.from([0x01, 0x02, 0x03]);
            const allocSpy = vi.spyOn(Buffer, 'alloc').mockImplementation(() => {
                throw new Error('Buffer.alloc used');
            });

            try {
                const [value, remaining] = Bytes.deserialize(Bytes, data);

                expect(value).toBe(data);
                expect(remaining.length).toBe(0);
                expect(allocSpy).not.toHaveBeenCalled();
            } finally {
                allocSpy.mockRestore();
            }
        });
    });

    describe('Fixed16Bytes', () => {
        it('should serialize exactly 16 bytes', () => {
            const input = Buffer.alloc(16, 0xAB);
            const result = Fixed16Bytes.serialize(Fixed16Bytes, input);
            expect(result.length).toBe(16);
            expect(result).toEqual(input);
        });

        it('should serialize fixed Buffer input without cloning it first', () => {
            const input = Buffer.alloc(16, 0xAB);
            const originalFrom = Buffer.from;
            const fromSpy = vi.spyOn(Buffer, 'from').mockImplementation(((value: unknown, ...args: unknown[]) => {
                if (value === input) {
                    throw new Error('Buffer.from input clone used');
                }

                return (originalFrom as (...parameters: unknown[]) => Buffer)(value, ...args);
            }) as typeof Buffer.from);

            try {
                const result = Fixed16Bytes.serialize(Fixed16Bytes, input);

                expect(result).toBe(input);
                expect(fromSpy).not.toHaveBeenCalledWith(input);
            } finally {
                fromSpy.mockRestore();
            }
        });

        it('should throw for wrong size buffer', () => {
            const input = Buffer.alloc(10, 0xAB);
            expect(() => Fixed16Bytes.serialize(Fixed16Bytes, input)).toThrow();
        });

        it('should deserialize exactly 16 bytes', () => {
            const input = Buffer.alloc(20, 0xAB);
            const [value, remaining] = Fixed16Bytes.deserialize(Fixed16Bytes, input);
            expect(value.length).toBe(16);
            expect(remaining.length).toBe(4);
        });

        it('should throw if buffer too small', () => {
            const input = Buffer.alloc(10, 0xAB);
            expect(() => Fixed16Bytes.deserialize(Fixed16Bytes, input)).toThrow(RangeError);
        });
    });

    describe('WordList', () => {
        it('should serialize list of uint16', () => {
            const result = WordList.serialize(WordList, [0x1234, 0x5678]);
            expect(result).toEqual(Buffer.from([0x34, 0x12, 0x78, 0x56]));
        });

        it('should serialize without Buffer.concat', () => {
            expectWithoutBufferConcat(
                () => WordList.serialize(WordList, [0x1234, 0x5678]),
                Buffer.from([0x34, 0x12, 0x78, 0x56]),
            );
        });
    });

    describe('Generic lists', () => {
        it('should serialize using the declared item type', () => {
            const Uint16List = list(uint16_t);

            const result = Uint16List.serialize(Uint16List, [0x1234, 0x5678]);

            expect(result).toEqual(Buffer.from([0x34, 0x12, 0x78, 0x56]));
        });

        it('should serialize without Array.map', () => {
            const Uint16List = list(uint16_t);

            expectWithoutArrayMap(
                () => Uint16List.serialize(Uint16List, [0x1234, 0x5678]),
                Buffer.from([0x34, 0x12, 0x78, 0x56]),
            );
        });

        it('should serialize length-prefixed lists using the item count', () => {
            const Uint16List = LVList(uint16_t);

            const result = Uint16List.serialize(Uint16List, [0x1234, 0x5678]);

            expect(result).toEqual(Buffer.from([0x02, 0x34, 0x12, 0x78, 0x56]));
        });

        it('should deserialize length-prefixed lists into a preallocated result array', () => {
            const Uint16List = LVList(uint16_t);
            const source = fs.readFileSync('src/adapter/blz/driver/types/basic.ts', 'utf8');

            const [value, remaining] = Uint16List.deserialize(Uint16List, Buffer.from([0x02, 0x34, 0x12, 0x78, 0x56, 0xff]));

            expect(value).toEqual([0x1234, 0x5678]);
            expect(remaining).toEqual(Buffer.from([0xff]));
            expect(source).toContain('new Array(length)');
            expect(source).toContain('r[i] = item');
        });

        it('should reject a missing length prefix when deserializing length-prefixed lists', () => {
            const Uint16List = LVList(uint16_t);

            expect(() => Uint16List.deserialize(Uint16List, Buffer.alloc(0))).toThrow(RangeError);
        });
    });

    describe('Fixed lists', () => {
        it('should serialize every byte from the declared item type', () => {
            const FixedUint16List = fixed_list(2, uint16_t);

            const result = FixedUint16List.serialize(FixedUint16List, [0x1234, 0x5678]);

            expect(result).toEqual(Buffer.from([0x34, 0x12, 0x78, 0x56]));
        });

        it('should reject values with the wrong item count', () => {
            const FixedUint16List = fixed_list(2, uint16_t);

            expect(() => FixedUint16List.serialize(FixedUint16List, [0x1234])).toThrow('Incorrect list length');
        });

        it('should deserialize fixed lists into a preallocated result array', () => {
            const FixedUint16List = fixed_list(2, uint16_t);
            const source = fs.readFileSync('src/adapter/blz/driver/types/basic.ts', 'utf8');

            const [value, remaining] = FixedUint16List.deserialize(FixedUint16List, Buffer.from([0x34, 0x12, 0x78, 0x56, 0xff]));

            expect(value).toEqual([0x1234, 0x5678]);
            expect(remaining).toEqual(Buffer.from([0xff]));
            expect(source).toContain('new Array(cls._length)');
            expect(source).toContain('r[i] = item');
        });

        it('should serialize without Array.map', () => {
            const FixedUint16List = fixed_list(2, uint16_t);

            expectWithoutArrayMap(
                () => FixedUint16List.serialize(FixedUint16List, [0x1234, 0x5678]),
                Buffer.from([0x34, 0x12, 0x78, 0x56]),
            );
        });
    });

    describe('Structured serialization', () => {
        it('should serialize empty schemas without allocating a new empty buffer', () => {
            const allocUnsafeSpy = vi.spyOn(Buffer, 'allocUnsafe').mockImplementation(() => {
                throw new Error('Buffer.allocUnsafe used');
            });

            try {
                const result = serializeSchema([], []);

                expect(result.length).toBe(0);
                expect(allocUnsafeSpy).not.toHaveBeenCalled();
            } finally {
                allocUnsafeSpy.mockRestore();
            }
        });

        it('should deserialize schemas without dynamic result array growth', () => {
            const result = deserializeSchema(Buffer.from([0x34, 0x12, 0x56]), [uint16_t, uint8_t]);
            const source = fs.readFileSync('src/adapter/blz/driver/types/index.ts', 'utf8');

            expect(result).toEqual([0x1234, 0x56]);
            expect(source).not.toContain('result.push(value)');
            expect(source).toContain('new Array(schema.length)');
        });

        it('should serialize schemas without Buffer.concat', () => {
            expectWithoutBufferConcat(
                () => serializeSchema([0x1234, 0x56], [uint16_t, uint8_t]),
                Buffer.from([0x34, 0x12, 0x56]),
            );
        });

        it('should serialize schemas without Array.map', () => {
            expectWithoutArrayMap(
                () => serializeSchema([0x1234, 0x56], [uint16_t, uint8_t]),
                Buffer.from([0x34, 0x12, 0x56]),
            );
        });

        it('should serialize structs without Buffer.concat', () => {
            const frame = new BlzApsFrame();
            frame.profileId = 0x0104;
            frame.clusterId = 0x0006;
            frame.sourceEndpoint = 1;
            frame.destinationEndpoint = 2;
            frame.options = BlzApsOption.ZB_APS_TX_OPTIONS_NONE;
            frame.groupId = 0x1234;
            frame.sequence = 0x77;

            expectWithoutBufferConcat(
                () => BlzApsFrame.serialize(BlzApsFrame, frame),
                Buffer.from([0x04, 0x01, 0x06, 0x00, 0x01, 0x02, 0x00, 0x00, 0x34, 0x12, 0x77]),
            );
        });

        it('should serialize structs without Array.map', () => {
            const frame = new BlzApsFrame();
            frame.profileId = 0x0104;
            frame.clusterId = 0x0006;
            frame.sourceEndpoint = 1;
            frame.destinationEndpoint = 2;
            frame.options = BlzApsOption.ZB_APS_TX_OPTIONS_NONE;
            frame.groupId = 0x1234;
            frame.sequence = 0x77;

            expectWithoutArrayMap(
                () => BlzApsFrame.serialize(BlzApsFrame, frame),
                Buffer.from([0x04, 0x01, 0x06, 0x00, 0x01, 0x02, 0x00, 0x00, 0x34, 0x12, 0x77]),
            );
        });

    });

    describe('int_t valueToName', () => {
        it('should convert value to name', () => {
            const name = int_t.valueToName(BlzStatus, 0);
            expect(name).toBe('BlzStatus.SUCCESS');
        });

        it('should return empty string for unknown value', () => {
            const name = int_t.valueToName(BlzStatus, 999);
            expect(name).toBe('');
        });
    });

    describe('Named Types', () => {
        describe('BlzEUI64', () => {
            it('should create from hex string', () => {
                const eui = new BlzEUI64('0102030405060708');
                expect(eui.toString()).toBe('0102030405060708');
            });

            it('should create from hex string with 0x prefix', () => {
                const eui = new BlzEUI64('0x0102030405060708');
                expect(eui.toString()).toBe('0102030405060708');
            });

            it('should create from hex string without Buffer.from', () => {
                const fromSpy = vi.spyOn(Buffer, 'from').mockImplementation(() => {
                    throw new Error('Buffer.from used');
                });

                try {
                    const eui = new BlzEUI64('0102030405060708');

                    expect(eui.toString()).toBe('0102030405060708');
                    expect(fromSpy).not.toHaveBeenCalled();
                } finally {
                    fromSpy.mockRestore();
                }
            });

            it('should create from array', () => {
                const eui = new BlzEUI64([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
                expect(eui.toString()).toBe('0102030405060708');
            });

            it('should not expose mutable value storage', () => {
                const eui = new BlzEUI64('0102030405060708');
                const value = eui.value;
                value[0] = 0xff;

                expect(eui.toString()).toBe('0102030405060708');
            });

            it('should expose value copies without cloning the backing buffer through Buffer.from', () => {
                const eui = new BlzEUI64('0102030405060708');
                const fromSpy = vi.spyOn(Buffer, 'from').mockImplementation(() => {
                    throw new Error('Buffer.from used');
                });

                try {
                    const value = eui.value;
                    value[0] = 0xff;

                    expect(value).toEqual(Buffer.of(0xff, 2, 3, 4, 5, 6, 7, 8));
                    expect(eui.toString()).toBe('0102030405060708');
                    expect(fromSpy).not.toHaveBeenCalled();
                } finally {
                    fromSpy.mockRestore();
                }
            });

            it('should not retain mutable constructor input storage', () => {
                const value = Buffer.of(0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08);
                const eui = new BlzEUI64(value);
                value[0] = 0xff;

                expect(eui.toString()).toBe('0102030405060708');
            });

            it('should copy constructor buffer input without cloning it through Buffer.from', () => {
                const value = Buffer.of(0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08);
                const originalFrom = Buffer.from;
                const fromSpy = vi.spyOn(Buffer, 'from').mockImplementation(((input: unknown, ...args: unknown[]) => {
                    if (input === value) {
                        throw new Error('constructor input clone used');
                    }

                    return (originalFrom as (...parameters: unknown[]) => Buffer)(input, ...args);
                }) as typeof Buffer.from);

                try {
                    const eui = new BlzEUI64(value);
                    value[0] = 0xff;

                    expect(eui.toString()).toBe('0102030405060708');
                    expect(fromSpy).not.toHaveBeenCalledWith(value);
                } finally {
                    fromSpy.mockRestore();
                }
            });

            it('should copy constructor EUI64 input without cloning its value through Buffer.from', () => {
                const source = new BlzEUI64('0102030405060708');
                const fromSpy = vi.spyOn(Buffer, 'from').mockImplementation(() => {
                    throw new Error('Buffer.from used');
                });

                try {
                    const copy = new BlzEUI64(source);

                    expect(copy.toString()).toBe('0102030405060708');
                    expect(fromSpy).not.toHaveBeenCalled();
                } finally {
                    fromSpy.mockRestore();
                }
            });

            it('should convert to string without copying the backing buffer', () => {
                const eui = new BlzEUI64('0102030405060708');
                const fromSpy = vi.spyOn(Buffer, 'from').mockImplementation(() => {
                    throw new Error('Buffer.from used');
                });

                try {
                    expect(eui.toString()).toBe('0102030405060708');
                    expect(fromSpy).not.toHaveBeenCalled();
                } finally {
                    fromSpy.mockRestore();
                }
            });

            it('should throw for invalid string length', () => {
                expect(() => new BlzEUI64('0102030405')).toThrow('Incorrect value passed');
            });

            it('should throw for invalid array length', () => {
                expect(() => new BlzEUI64([0x01, 0x02])).toThrow('Incorrect value passed');
            });

            it('should serialize EUI64', () => {
                const eui = new BlzEUI64('0102030405060708');
                const result = BlzEUI64.serialize(BlzEUI64, eui);
                expect(result.length).toBe(8);
            });

            it('should serialize EUI64 without per-byte integer serialization churn', () => {
                const eui = new BlzEUI64('0102030405060708');
                const serializeSpy = vi.spyOn(uint8_t, 'serialize').mockImplementation(() => {
                    throw new Error('uint8_t.serialize used');
                });

                try {
                    expect(BlzEUI64.serialize(BlzEUI64, eui)).toEqual(
                        Buffer.from([0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]),
                    );
                    expect(serializeSpy).not.toHaveBeenCalled();
                } finally {
                    serializeSpy.mockRestore();
                }
            });

            it('should serialize EUI64 instances without copying through the public value getter', () => {
                const eui = new BlzEUI64('0102030405060708');
                const expected = Buffer.from([0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]);
                const fromSpy = vi.spyOn(Buffer, 'from').mockImplementation(() => {
                    throw new Error('Buffer.from used');
                });

                try {
                    expect(BlzEUI64.serialize(BlzEUI64, eui)).toEqual(expected);
                    expect(fromSpy).not.toHaveBeenCalled();
                } finally {
                    fromSpy.mockRestore();
                }
            });

            it('should serialize from array', () => {
                const result = BlzEUI64.serialize(BlzEUI64, [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
                expect(result.length).toBe(8);
            });

            it('should deserialize and reverse bytes', () => {
                const buffer = Buffer.from([0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01, 0xAB]);
                const [value, remaining] = BlzEUI64.deserialize(BlzEUI64, buffer);
                expect(value).toEqual(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]));
                expect(remaining).toEqual(Buffer.from([0xAB]));
            });

            it('should deserialize EUI64 without copying through Buffer.from', () => {
                const buffer = Buffer.from([0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01, 0xAB]);
                const expectedValue = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
                const expectedRemaining = buffer.subarray(8);
                const fromSpy = vi.spyOn(Buffer, 'from').mockImplementation(() => {
                    throw new Error('Buffer.from used');
                });

                try {
                    const [value, remaining] = BlzEUI64.deserialize(BlzEUI64, buffer);
                    expect(value).toEqual(expectedValue);
                    expect(remaining).toEqual(expectedRemaining);
                    expect(fromSpy).not.toHaveBeenCalled();
                } finally {
                    fromSpy.mockRestore();
                }
            });
        });

        describe('BlzValueId', () => {
            it('should have defined value IDs', () => {
                expect(BlzValueId.BLZ_VALUE_ID_BLZ_VERSION).toBe(0x00);
                expect(BlzValueId.BLZ_VALUE_ID_STACK_VERSION).toBe(0x01);
                expect(BlzValueId.BLZ_VALUE_ID_MAC_ADDRESS).toBe(0x20);
            });
        });

        describe('BlzStatus', () => {
            it('should have SUCCESS and GENERAL_ERROR', () => {
                expect(BlzStatus.SUCCESS).toBe(0x00);
                expect(BlzStatus.GENERAL_ERROR).toBe(0x01);
            });
        });

        describe('BlzNodeType', () => {
            it('should have node types', () => {
                expect(BlzNodeType.COORDINATOR).toBe(0x00);
                expect(BlzNodeType.ROUTER).toBe(0x01);
                expect(BlzNodeType.END_DEVICE).toBe(0x02);
            });
        });

        describe('BlzOutgoingMessageType', () => {
            it('should have message types', () => {
                expect(BlzOutgoingMessageType.BLZ_MSG_TYPE_UNICAST).toBe(0x01);
                expect(BlzOutgoingMessageType.BLZ_MSG_TYPE_MULTICAST).toBe(0x02);
                expect(BlzOutgoingMessageType.BLZ_MSG_TYPE_BROADCAST).toBe(0x03);
            });
        });

        describe('BlzApsOption', () => {
            it('should have APS options', () => {
                expect(BlzApsOption.ZB_APS_TX_OPTIONS_NONE).toBe(0x00);
                expect(BlzApsOption.ZB_APS_TX_OPTIONS_SEC_EN_TRANS).toBe(0x01);
                expect(BlzApsOption.ZB_APS_TX_OPTIONS_ACK_TRANS).toBe(0x04);
            });
        });

    });
});
