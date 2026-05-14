/* istanbul ignore file */
const EMPTY_BUFFER = Buffer.alloc(0);

export function serializeMappedBufferSegments<T>(items: ArrayLike<T>, serialize: (item: T, index: number) => Buffer): Buffer {
    if (items.length === 0) {
        return EMPTY_BUFFER;
    }

    const segments: Buffer[] = new Array(items.length);
    let length = 0;

    for (let i = 0; i < items.length; i++) {
        const segment = serialize(items[i], i);
        segments[i] = segment;
        length += segment.length;
    }

    const result = Buffer.allocUnsafe(length);
    let offset = 0;

    for (const segment of segments) {
        offset += segment.copy(result, offset);
    }

    return result;
}

export class int_t {
    static _signed = true;

    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    static serialize(cls: any, value: number | bigint | Buffer): Buffer {
        if (cls._size > 8) {
            throw new Error(`Unsupported size: ${cls._size}`);
        }
    
        // If value is a Buffer, convert to a number or BigInt
        if (Buffer.isBuffer(value)) {
            if (cls._size <= 6) {
                value = cls._signed ? value.readIntLE(0, cls._size) : value.readUIntLE(0, cls._size);
            } else if (cls._size === 8) {
                value = cls._signed ? value.readBigInt64LE(0) : value.readBigUInt64LE(0);
            } else {
                throw new Error(`Unsupported size for Buffer conversion: ${cls._size}`);
            }
        }
    
        // Ensure value is a valid number or BigInt
        if (typeof value !== 'number' && typeof value !== 'bigint') {
            throw new TypeError(`Value must be a number, BigInt, or Buffer. Received: ${typeof value}`);
        }
    
        const buffer = Buffer.allocUnsafe(cls._size);
    
        if (cls._size <= 6) {
            if (cls._signed) {
                buffer.writeIntLE(Number(value), 0, cls._size);
            } else {
                buffer.writeUIntLE(Number(value), 0, cls._size);
            }
        } else if (cls._size === 8) {
            if (typeof value !== 'bigint') {
                value = BigInt(value); // Convert number to BigInt if necessary
            }
            if (cls._signed) {
                buffer.writeBigInt64LE(value, 0);
            } else {
                buffer.writeBigUInt64LE(value, 0);
            }
        }
    
        return buffer;
    }
    

    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    static deserialize(cls: any, data: Buffer): any[] {
        if (data.length < cls._size) {
            throw new RangeError(
                `Buffer too small. Expected at least ${cls._size} bytes, received ${data.length}`
            );
        }
    
        let value;
        if (cls._size <= 6) {
            // Use native readIntLE or readUIntLE for sizes up to 6 bytes
            value = cls._signed ? data.readIntLE(0, cls._size) : data.readUIntLE(0, cls._size);
        } else if (cls._size === 8) {
            // hotfix for 64-bit integers
            // Use BigInt for 64-bit integers
            value = cls._signed
                ? BigInt.asIntN(64, data.readBigInt64LE(0))
                : BigInt.asUintN(64, data.readBigUInt64LE(0));
        } else {
            throw new Error(`Unsupported size: ${cls._size}`);
        }
    
        return [value, data.subarray(cls._size)];
    }
    

    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    static valueToName(cls: any, value: any): string {
        for (const prop of Object.getOwnPropertyNames(cls)) {
            const desc = Object.getOwnPropertyDescriptor(cls, prop);
            if (desc !== undefined && desc.enumerable && desc.writable && value == desc.value) {
                return `${cls.name}.${prop}`;
            }
        }
        return '';
    }

    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    static valueName(cls: any, value: any): string {
        for (const prop of Object.getOwnPropertyNames(cls)) {
            const desc = Object.getOwnPropertyDescriptor(cls, prop);
            if (desc !== undefined && desc.enumerable && desc.writable && value == desc.value) {
                return `${prop}`;
            }
        }
        return '';
    }
}

export class int8s extends int_t {
    static _size = 1;
}

export class int16s extends int_t {
    static _size = 2;
}

export class int24s extends int_t {
    static _size = 3;
}

export class int32s extends int_t {
    static _size = 4;
}

export class int64s extends int_t {
    static _size = 8;
}

export class uint_t extends int_t {
    static _signed = false;
}

export class uint8_t extends uint_t {
    static _size = 1;
}

export class uint16_t extends uint_t {
    static _size = 2;
}

export class uint24_t extends uint_t {
    static _size = 3;
}

export class uint32_t extends uint_t {
    static _size = 4;
}

export class uint64_t extends uint_t {
    static _size = 8;
}

export class LVBytes {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    static serialize(cls: any, value: any[]): Buffer {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const result = Buffer.allocUnsafe(1 + bytes.length);
        result.writeUInt8(bytes.length, 0);
        bytes.copy(result, 1);
        return result;
    }

    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    static deserialize(cls: any, data: Buffer): any[] {
        if (data.length < 1) {
            throw new RangeError(`Buffer too small. Expected at least 1 byte, received ${data.length}`);
        }

        const l = data.readIntLE(0, 1);
        if (data.length < l + 1) {
            throw new RangeError(`Buffer too small. Expected at least ${l + 1} bytes, received ${data.length}`);
        }

        const s = data.subarray(1, l + 1);
        return [s, data.subarray(l + 1)];
    }
}

export abstract class List {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    static serialize(cls: any, value: any[]): Buffer {
        return serializeMappedBufferSegments(value, (i) => cls.itemtype.serialize(cls.itemtype, i));
    }

    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    static deserialize(cls: any, data: Buffer): any[] {
        let item;
        /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
        const r: any[] = [];
        while (data.length > 0) {
            [item, data] = cls.itemtype.deserialize(cls.itemtype, data);
            r.push(item);
        }
        return [r, data];
    }
}

class _LVList extends List {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    static serialize(cls: any, value: any[]): Buffer {
        const data = super.serialize(cls, value);
        const result = Buffer.allocUnsafe(1 + data.length);
        result.writeUInt8(value.length, 0);
        data.copy(result, 1);
        return result;
    }

    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    static deserialize(cls: any, data: Buffer): any[] {
        let item, length;
        /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
        if (data.length < 1) {
            throw new RangeError(`Buffer too small. Expected at least 1 byte, received ${data.length}`);
        }

        [length, data] = [data[0], data.subarray(1)];
        const r: any[] = new Array(length);
        for (let i = 0; i < length; i++) {
            [item, data] = cls.itemtype.deserialize(cls.itemtype, data);
            r[i] = item;
        }
        return [r, data];
    }
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
export function list(itemtype: any): List {
    class ConcreteList extends List {
        static itemtype = itemtype;
    }

    return ConcreteList;
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
export function LVList(itemtype: any): List {
    class LVList extends _LVList {
        static itemtype = itemtype;
    }

    return LVList;
}

export class WordList extends List {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    static serialize(cls: any, value: any[]): Buffer {
        const result = Buffer.allocUnsafe(value.length * 2);
        for (let i = 0; i < value.length; i++) {
            result.writeUInt16LE(value[i], i * 2);
        }
        return result;
    }
}

class _FixedList extends List {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    static serialize(cls: any, value: any[]): Buffer {
        if (value.length !== cls._length) {
            throw new Error(`Incorrect list length. Expected ${cls._length}, received ${value.length}`);
        }

        return serializeMappedBufferSegments(value, (i) => cls.itemtype.serialize(cls.itemtype, i));
    }

    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    static deserialize(cls: any, data: Buffer): any[] {
        let item;
        /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
        const r: any[] = new Array(cls._length);
        for (let i = 0; i < cls._length; i++) {
            [item, data] = cls.itemtype.deserialize(cls.itemtype, data);
            r[i] = item;
        }
        return [r, data];
    }
}

/* eslint-disable @typescript-eslint/no-explicit-any*/
export function fixed_list(
    length: number,
    itemtype: any,
): {
    new (): any;
    deserialize(cls: any, data: Buffer): any;
} {
    class FixedList extends _FixedList {
        static itemtype = itemtype;
        static _length = length;
    }

    return FixedList;
}
/* eslint-enable @typescript-eslint/no-explicit-any*/

export class Bytes {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    static serialize(cls: any, value: any[]): Buffer {
        return Buffer.isBuffer(value) ? value : Buffer.from(value);
    }

    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    static deserialize(cls: any, data: Buffer): any[] {
        return [data, EMPTY_BUFFER];
    }
}

export class Fixed16Bytes extends Bytes {
    static _size = 16;  // Fixed size for this type

    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    static serialize(cls: any, value: any): Buffer {
        // Check if the input is a Buffer and has the correct length
        if (!Buffer.isBuffer(value) || value.length !== cls._size) {
            throw new Error(`Value must be a buffer with exactly ${cls._size} bytes.`);
        }
        return value;  // The enclosing frame serializer copies this into its final buffer.
    }

    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    static deserialize(cls: any, data: Buffer): any[] {
        if (data.length < cls._size) {
            throw new RangeError(
                `Buffer too small. Expected at least ${cls._size} bytes, received ${data.length}`
            );
        }

        // Extract exactly 16 bytes
        const value = data.subarray(0, cls._size);
        const remainder = data.subarray(cls._size);  // Remaining part of the buffer after the first 16 bytes
        return [value, remainder];  // Returns the 16-byte buffer and the remainder
    }
}
