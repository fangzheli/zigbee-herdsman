/* istanbul ignore file */

import {Buffalo} from '../../../buffalo';
import {EUI64} from '../../../zspec/tstypes';
import {BuffaloZclOptions} from '../../../zspec/zcl/definition/tstype';
import {getMacCapFlags} from '../../../zspec/zdo/utils';
import {LOG_LEVEL} from './constants';
import ParameterType from './parameterType';

export interface BuffaloBlzOptions extends BuffaloZclOptions {
    startIndex?: number;
}

class BuffaloBlz extends Buffalo {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
    public write(type: ParameterType, value: any, options: BuffaloBlzOptions): void {
        switch (type) {
            case ParameterType.UINT8: {
                return this.writeUInt8(value);
            }
            case ParameterType.UINT16: {
                return this.writeUInt16LE(value);
            }
            case ParameterType.UINT32: {
                return this.writeUInt32LE(value);
            }
            case ParameterType.IEEEADDR: {
                return this.writeIeeeAddrLE(value);
            }
            case ParameterType.BUFFER: {
                return this.writeBuffer(value, value.length);
            }
            case ParameterType.BUFFER8: {
                return this.writeBuffer(value, 8);
            }
            case ParameterType.BUFFER16: {
                return this.writeBuffer(value, 16);
            }
            case ParameterType.BUFFER18: {
                return this.writeBuffer(value, 18);
            }
            case ParameterType.BUFFER32: {
                return this.writeBuffer(value, 32);
            }
            case ParameterType.BUFFER42: {
                return this.writeBuffer(value, 42);
            }
            case ParameterType.BUFFER100: {
                return this.writeBuffer(value, 100);
            }
            case ParameterType.LIST_UINT8: {
                return this.writeListUInt8(value);
            }
            case ParameterType.LIST_UINT16: {
                return this.writeListUInt16LE(value);
            }
            case ParameterType.INT8: {
                return this.writeInt8(value);
            }
            case ParameterType.ADDRESS_WITH_TYPE_DEPENDENCY: {
                const addressMode = this.buffer.readUInt8(this.position - 1);
                return addressMode == 3 ? this.writeIeeeAddrLE(value) : this.writeUInt16LE(value);
            }
            case ParameterType.RAW: {
                return this.writeRaw(value);
            }
        }

        throw new Error(`Write for '${type}' not available`);
    }

    public read(type: ParameterType, options: BuffaloBlzOptions): unknown {
        switch (type) {
            case ParameterType.UINT8: {
                return this.readUInt8();
            }
            case ParameterType.UINT16: {
                return this.readUInt16LE();
            }
            case ParameterType.UINT32: {
                return this.readUInt32LE();
            }
            case ParameterType.IEEEADDR: {
                return this.readIeeeAddrLE();
            }
            case ParameterType.BUFFER: {
                // if length option not specified, read the whole buffer
                return this.readBuffer(options.length ?? this.buffer.length);
            }
            case ParameterType.BUFFER8: {
                return this.readBuffer(8);
            }
            case ParameterType.BUFFER16: {
                return this.readBuffer(16);
            }
            case ParameterType.BUFFER18: {
                return this.readBuffer(18);
            }
            case ParameterType.BUFFER32: {
                return this.readBuffer(32);
            }
            case ParameterType.BUFFER42: {
                return this.readBuffer(42);
            }
            case ParameterType.BUFFER100: {
                return this.readBuffer(100);
            }
            case ParameterType.LIST_UINT8: {
                return this.readListUInt8(options.length ?? 0); // XXX: should always be valid?
            }
            case ParameterType.LIST_UINT16: {
                return this.readListUInt16LE(options.length ?? 0); // XXX: should always be valid?
            }
            case ParameterType.INT8: {
                return this.readInt8();
            }
            case ParameterType.MACCAPABILITY: {
                return getMacCapFlags(this.readUInt8());
            }
            case ParameterType.ADDRESS_WITH_TYPE_DEPENDENCY: {
                const addressMode = this.buffer.readUInt8(this.position - 1);
                return addressMode == 3 ? this.readIeeeAddrLE() : this.readUInt16LE();
            }
            case ParameterType.BUFFER_RAW: {
                const buffer = this.buffer.subarray(this.position);
                this.position += buffer.length;
                return buffer;
            }
            case ParameterType.STRING: {
                const buffer = this.buffer.subarray(this.position);
                this.position += buffer.length;
                return unescape(buffer.toString());
            }
            case ParameterType.LOG_LEVEL: {
                return LOG_LEVEL[this.readUInt8()];
            }
            case ParameterType.MAYLE_UINT8: {
                return this.isMore() ? this.readUInt8() : null;
            }
        }

        throw new Error(`Read for '${type}' not available`);
    }

    public writeRaw(value: Buffer): void {
        this.buffer.set(value, this.position);
        this.position += value.length;
    }

    public readUInt16LE(): number {
        const value = this.buffer.readUInt16LE(this.position);
        this.position += 2;
        return value;
    }
    public writeUInt16LE(value: number): void {
        this.buffer.writeUInt16LE(value, this.position);
        this.position += 2;
    }

    public readUInt32LE(): number {
        const value = this.buffer.readUInt32LE(this.position);
        this.position += 4;
        return value;
    }
    public writeUInt32LE(value: number): void {
        this.buffer.writeUInt32LE(value, this.position);
        this.position += 4;
    }

    public readListUInt16LE(length: number): number[] {
        const value: number[] = [];
        for (let i = 0; i < length; i++) {
            value.push(this.readUInt16LE());
        }

        return value;
    }
    public writeListUInt16LE(values: number[]): void {
        for (const value of values) {
            this.writeUInt16LE(value);
        }
    }

    public readIeeeAddrLE(): EUI64 {
        return `0x${this.readBuffer(8).toString('hex')}`;
    }
    public writeIeeeAddrLE(value: string /*TODO: EUI64*/): void {
        this.writeUInt32LE(parseInt(value.slice(2, 10), 16));
        this.writeUInt32LE(parseInt(value.slice(10), 16));
    }
}

export default BuffaloBlz;
