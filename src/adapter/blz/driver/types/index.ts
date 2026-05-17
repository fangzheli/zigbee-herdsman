/* istanbul ignore file */

import {
    Bytes,
    fixed_list,
    int8s,
    LVBytes,
    LVList,
    list,
    serializeMappedBufferSegments,
    uint_t,
    uint8_t,
    uint16_t,
    uint24_t,
    uint32_t,
    uint64_t,
    WordList,
} from "./basic";
import {BlzApsOption, BlzEUI64, BlzNodeType, BlzOutgoingMessageType, BlzStatus, BlzValueId} from "./named";
import {BlzApsFrame, BlzNetworkParameters, BlzStruct} from "./struct";

interface SchemaType {
    deserialize: (type: unknown, data: Buffer) => [unknown, Buffer];
    serialize: (schema: unknown, item: unknown) => Buffer;
}

export function deserialize(payload: Buffer, schema: SchemaType[]): unknown[] {
    const result: unknown[] = new Array(schema.length);
    let value: unknown;
    let data = payload;
    for (let i = 0; i < schema.length; i++) {
        const type = schema[i];
        [value, data] = type.deserialize(type, data);
        result[i] = value;
    }
    return result;
}

export function serialize(data: unknown[], schema: SchemaType[]): Buffer {
    return serializeMappedBufferSegments(schema, (s, idx) => s.serialize(s, data[idx]));
}

export {
    BlzApsFrame,
    BlzApsOption,
    /* Named Types */
    BlzEUI64,
    BlzNetworkParameters,
    BlzNodeType,
    BlzOutgoingMessageType,
    BlzStatus,
    /* Structs */
    BlzStruct,
    BlzValueId,
    Bytes,
    fixed_list,
    /* Basic Types */
    int8s,
    LVBytes,
    LVList,
    list,
    uint_t,
    uint8_t,
    uint16_t,
    uint24_t,
    uint32_t,
    uint64_t,
    WordList,
};
