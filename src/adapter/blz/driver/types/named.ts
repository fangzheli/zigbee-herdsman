/* istanbul ignore file */

import * as basic from './basic';
import {fixed_list} from './basic';

export class BlzEUI64 extends fixed_list(8, basic.uint8_t) {
    constructor(private _value: ArrayLike<number> | string) {
        super();
        if (typeof _value === 'string') {
            if (_value.startsWith('0x')) _value = _value.slice(2);
            if ((_value as string).length !== 16) {
                throw new Error('Incorrect value passed');
            }
            this._value = Buffer.from(_value, 'hex');
        } else {
            if (_value.length !== 8) {
                throw new Error('Incorrect value passed');
            }
            this._value = Buffer.from(_value);
        }
    }

    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    static deserialize(cls: any, data: Buffer): any[] {
        const arr = super.deserialize(cls, data);
        const r = arr[0];
        data = arr[1] as Buffer;
        return [Buffer.from(r).reverse(), data];
    }

    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    static serialize(cls: any, value: ArrayLike<number> | BlzEUI64): Buffer {
        if (value instanceof BlzEUI64) {
            value = (value as BlzEUI64).value as Buffer;
        }
        if (value.length !== 8) {
            throw new Error('Incorrect value passed');
        }

        const result = Buffer.allocUnsafe(8);
        for (let i = 0; i < 8; i++) {
            result[i] = value[7 - i];
        }
        return result;
    }

    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    public get value(): any {
        return Buffer.from(this._value as ArrayLike<number>);
    }

    public toString(): string {
        /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
        return Buffer.from(this._value as any).toString('hex');
    }
}

export class BlzValueId extends basic.uint8_t {
    // BLZ Value ID enumeration.

    // BLZ version
    static BLZ_VALUE_ID_BLZ_VERSION = 0x00;
    // Stack version
    static BLZ_VALUE_ID_STACK_VERSION = 0x01;
    // Neighbor table size
    static BLZ_VALUE_ID_NEIGHBOR_TABLE_SIZE = 0x02;
    // Source route table size
    static BLZ_VALUE_ID_SOURCE_ROUTE_TABLE_SIZE = 0x03;
    // Routing table size
    static BLZ_VALUE_ID_ROUTE_TABLE_SIZE = 0x04;
    // Route discovery table size
    static BLZ_VALUE_ID_DISCOVERY_TABLE_SIZE = 0x05;
    // Address map table size
    static BLZ_VALUE_ID_ADDRESS_TABLE_SIZE = 0x06;
    // Group table size
    static BLZ_VALUE_ID_MULTICAST_TABLE_SIZE = 0x07;
    // Broadcast table size
    static BLZ_VALUE_ID_BROADCAST_TABLE_SIZE = 0x08;
    // Binding table size
    static BLZ_VALUE_ID_BINDING_TABLE_SIZE = 0x09;
    // Max end device supported
    static BLZ_VALUE_ID_MAX_END_DEVICE_CHILDREN = 0x0A;
    // Indirect message timeout value
    static BLZ_VALUE_ID_INDIRECT_TRANSMISSION_TIMEOUT = 0x0B;
    // End device timeout value
    static BLZ_VALUE_ID_END_DEVICE_BIND_TIMEOUT = 0x0C;
    // Device Unique TC Link key table size
    static BLZ_VALUE_ID_UNIQUE_TC_LINK_KEY_TABLE_SIZE = 0x0D;
    // Trust center address
    static BLZ_VALUE_ID_TRUST_CENTER_ADDRESS = 0x0F;
    // MAC address of NCP
    static BLZ_VALUE_ID_MAC_ADDRESS = 0x20;
}

export class BlzStatus extends basic.uint8_t {
    // Success.
    static SUCCESS = 0x00;
    // TODO: General error.
    static GENERAL_ERROR = 0x01;
}

export class BlzNodeType extends basic.uint8_t {
    // The type of the node.
    static COORDINATOR = 0x00;
    // Will relay messages and can act as a parent to other nodes.
    static ROUTER = 0x01;
    // Communicates only with its parent and will not relay messages.
    static END_DEVICE = 0x02;
}

export class BlzOutgoingMessageType extends basic.uint8_t {
    // Message types.
    // Unicast message type.
    static BLZ_MSG_TYPE_UNICAST = 0x01;
    // Multicast message type.
    static BLZ_MSG_TYPE_MULTICAST = 0x02;
    // Broadcast message type.
    static BLZ_MSG_TYPE_BROADCAST = 0x03;
}

// Options to use when sending a message.
export class BlzApsOption extends basic.uint16_t {

    // No options.
    static ZB_APS_TX_OPTIONS_NONE = 0x00;
    // Send the message using APS Encryption, using the Link Key shared with the
    // destination node to encrypt the data at the APS Level.
    static ZB_APS_TX_OPTIONS_SEC_EN_TRANS = 0x01;
    // Use the network key to encrypt the data at the APS Level.
    static ZB_APS_TX_OPTIONS_USE_NWK_KEY = 0x02;
    // Use the APS ACK mechanism to confirm that the message was received.
    static ZB_APS_TX_OPTIONS_ACK_TRANS = 0x04;
    static ZB_APS_TX_OPTIONS_FRAG_PERMIT = 0x08;
    static ZB_APS_TX_OPTIONS_EXT_NONCE = 0x10;
}
