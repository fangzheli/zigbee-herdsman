/* istanbul ignore file */
// biome-ignore-all lint/suspicious/noExplicitAny: BLZ struct schemas use dynamic runtime field descriptors.
// biome-ignore-all lint/suspicious/noImplicitAnyLet: BLZ struct deserialization unpacks dynamically typed values.
// biome-ignore-all lint/style/useNamingConvention: TxPower and Channel mirror BLZ firmware field names.

import * as basic from "./basic";
import {serializeMappedBufferSegments} from "./basic";
import * as named from "./named";

export class BlzStruct {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    static serialize(cls: any, obj: any): Buffer {
        return serializeFields(cls._fields, obj);
    }

    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    static deserialize(cls: any, data: Buffer): any[] {
        const r = new cls();
        for (const [field_name, field_type] of cls._fields) {
            let v;
            [v, data] = field_type.deserialize(field_type, data);
            r[field_name] = v;
        }
        return [r, data];
    }

    public toString(): string {
        return `${this.constructor.name}: ${JSON.stringify(this)}`;
    }
}

export class BlzNetworkParameters extends BlzStruct {
    // @ts-expect-error set via _fields
    public extendedPanId: Buffer;
    // @ts-expect-error set via _fields
    public panId: number;
    // @ts-expect-error set via _fields
    public TxPower: number;
    // @ts-expect-error set via _fields
    public Channel: number;
    // @ts-expect-error set via _fields
    public nwkManagerId: number;
    // @ts-expect-error set via _fields
    public nwkUpdateId: number;
    // @ts-expect-error set via _fields
    public channels: number;

    static _fields = [
        // The network's extended PAN identifier.
        ["extendedPanId", basic.fixed_list(8, basic.uint8_t)],
        // The network's PAN identifier.
        ["panId", basic.uint16_t],
        // A power setting, in dBm.
        ["TxPower", basic.uint8_t],
        // A radio channel.
        ["Channel", basic.uint8_t],
        // The method used to initially join the network.
        ["nwkManagerId", basic.uint16_t],
        // NWK Update ID. The value of the ZigBee nwkUpdateId known by the stack.
        ["nwkUpdateId", basic.uint8_t],
        // NWK channel mask.
        ["channels", basic.uint32_t],
    ];
}

export class BlzApsFrame extends BlzStruct {
    // @ts-expect-error set via _fields
    public profileId: number;
    // @ts-expect-error set via _fields
    public sequence: number;
    // @ts-expect-error set via _fields
    public clusterId: number;
    // @ts-expect-error set via _fields
    public sourceEndpoint: number;
    // @ts-expect-error set via _fields
    public destinationEndpoint: number;
    public groupId?: number;
    public options?: named.BlzApsOption;

    static _fields = [
        // The application profile ID that describes the format of the message.
        ["profileId", basic.uint16_t],
        // The cluster ID for this message.
        ["clusterId", basic.uint16_t],
        // The source endpoint.
        ["sourceEndpoint", basic.uint8_t],
        // The destination endpoint.
        ["destinationEndpoint", basic.uint8_t],
        // A bitmask of options.
        ["options", named.BlzApsOption],
        // The group ID for this message, if it is multicast mode.
        ["groupId", basic.uint16_t],
        // The sequence number.
        ["sequence", basic.uint8_t],
    ];
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
function serializeFields(fields: any[][], obj: any): Buffer {
    return serializeMappedBufferSegments(fields, (field: any[]) => {
        const value = obj[field[0]];
        return field[1].serialize(field[1], value);
    });
}
