import {logger} from "../../../utils/logger";
import {formatUnknownError} from "../errorUtils";
import {type BLZFrameDesc, FRAME_NAMES_BY_ID, FRAMES, type ParamsDesc} from "./commands";
import {Bytes, WordList} from "./types";
import {serializeMappedBufferSegments} from "./types/basic";

const NS = "zh:blz:blz";
const BYTE_FIELD_LENGTHS: Record<string, string> = {
    value: "valueLength",
    payload: "payloadLen",
    message: "messageLength",
};
const WORD_LIST_FIELD_LENGTHS: Record<string, string> = {
    inputClusterList: "inputClusterCount",
    outputClusterList: "outputClusterCount",
};

export class BLZFrameData {
    _cls_: string;
    _id_: number;
    _isRequest_: boolean;
    // biome-ignore lint/suspicious/noExplicitAny: BLZ frame schemas attach dynamic typed fields by frame name.
    [name: string]: any;

    static createFrame(frameId: number, isRequest: boolean, params: ParamsDesc | Buffer): BLZFrameData | undefined {
        const names = FRAME_NAMES_BY_ID[frameId];
        if (!names) {
            throw new Error(`Unrecognized frame FrameID ${frameId}`);
        }

        for (const frameName of names) {
            try {
                return new BLZFrameData(frameName, isRequest, params);
            } catch (error) {
                logger.error(`Frame ${frameName} parsing error: ${formatUnknownError(error)}`, NS);
            }
        }

        return undefined;
    }

    static getFrame(name: string): BLZFrameDesc {
        const frameDesc = FRAMES[name];
        if (!frameDesc) {
            throw new Error(`Unrecognized frame from FrameID ${name}`);
        }
        return frameDesc;
    }

    constructor(key: string, isRequest: boolean, params: ParamsDesc | Buffer | undefined) {
        this._cls_ = key;
        this._id_ = FRAMES[this._cls_].ID;

        this._isRequest_ = isRequest;
        const frame = BLZFrameData.getFrame(key);
        const frameDesc = this._isRequest_ ? frame.request || {} : frame.response || {};
        if (Buffer.isBuffer(params)) {
            let data = params;
            for (const prop of Object.getOwnPropertyNames(frameDesc)) {
                const fieldType = frameDesc[prop];
                const byteLength = getDeclaredByteFieldLength(prop, this);
                if (fieldType === Bytes && byteLength !== undefined) {
                    if (data.length < byteLength) {
                        throw new RangeError(`Byte field ${prop} expected ${byteLength} bytes, received ${data.length}`);
                    }

                    [this[prop]] = fieldType.deserialize(fieldType, data.subarray(0, byteLength));
                    data = data.subarray(byteLength);
                } else if (fieldType === WordList) {
                    const itemCount = getDeclaredWordListItemCount(prop, this);
                    if (itemCount !== undefined) {
                        [this[prop], data] = deserializeCountedWordList(prop, itemCount, data);
                    } else {
                        [this[prop], data] = fieldType.deserialize(fieldType, data);
                    }
                } else {
                    [this[prop], data] = fieldType.deserialize(fieldType, data);
                }
            }

            if (data.length > 0) {
                throw new RangeError(`Unexpected trailing data after ${key} frame: ${data.length} bytes`);
            }
        } else {
            const values = params ?? {};
            for (const prop of Object.getOwnPropertyNames(frameDesc)) {
                this[prop] = values[prop];
            }
        }
    }

    serialize(): Buffer {
        const frame = BLZFrameData.getFrame(this._cls_);
        const frameDesc = this._isRequest_ ? frame.request || {} : frame.response || {};
        return serializeFrameFields(frameDesc, this);
    }

    get name(): string {
        return this._cls_;
    }

    toJSON(): Record<string, unknown> {
        const result: Record<string, unknown> = {};

        for (const key of Object.keys(this)) {
            const value = (this as Record<string, unknown>)[key];
            result[key] = typeof value === "bigint" ? `0x${value.toString(16)}` : value;
        }

        return result;
    }

    get id(): number {
        return this._id_;
    }
}

function serializeFrameFields(frameDesc: ParamsDesc, values: Record<string, unknown>): Buffer {
    const fields = Object.getOwnPropertyNames(frameDesc);
    return serializeMappedBufferSegments(fields, (prop) => {
        validateDeclaredFieldLength(prop, values);
        return frameDesc[prop].serialize(frameDesc[prop], values[prop]);
    });
}

function validateDeclaredFieldLength(fieldName: string, values: Record<string, unknown>): void {
    const byteLength = getDeclaredByteFieldLength(fieldName, values);
    if (byteLength !== undefined) {
        const value = values[fieldName] as ArrayLike<number> | undefined;
        const actualLength = value?.length ?? 0;
        if (actualLength !== byteLength) {
            throw new RangeError(`Byte field ${fieldName} expected ${byteLength} bytes, received ${actualLength}`);
        }
    }

    const itemCount = getDeclaredWordListItemCount(fieldName, values);
    if (itemCount !== undefined) {
        const value = values[fieldName] as ArrayLike<number> | undefined;
        const actualCount = value?.length ?? 0;
        if (actualCount !== itemCount) {
            throw new RangeError(`WordList field ${fieldName} expected ${itemCount} items, received ${actualCount}`);
        }
    }
}

function getDeclaredByteFieldLength(fieldName: string, values: Record<string, unknown>): number | undefined {
    const lengthField = BYTE_FIELD_LENGTHS[fieldName];
    if (lengthField === undefined) {
        return undefined;
    }

    const value = values[lengthField];
    return typeof value === "number" ? value : undefined;
}

function getDeclaredWordListItemCount(fieldName: string, values: Record<string, unknown>): number | undefined {
    const lengthField = WORD_LIST_FIELD_LENGTHS[fieldName];
    if (lengthField === undefined) {
        return undefined;
    }

    const value = values[lengthField];
    return typeof value === "number" ? value : undefined;
}

function deserializeCountedWordList(fieldName: string, itemCount: number, data: Buffer): [number[], Buffer] {
    const byteLength = itemCount * 2;
    if (data.length < byteLength) {
        throw new RangeError(`WordList field ${fieldName} expected ${itemCount} items (${byteLength} bytes), received ${data.length} bytes`);
    }

    const [values] = WordList.deserialize(WordList, data.subarray(0, byteLength));

    return [values, data.subarray(byteLength)];
}
