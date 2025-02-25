/* istanbul ignore file */

import * as basic from './basic';
import {fixed_list} from './basic';

const NS = 'zh:blz:named';

export class BlzNodeId extends basic.uint16_t {}
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
            this._value = _value;
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
    static serialize(cls: any, value: number[] | BlzEUI64): Buffer {
        if (value instanceof BlzEUI64) {
            value = (value as BlzEUI64).value as number[];
        }
        const val = Buffer.from(value)
            .reverse()
            .map((i) => basic.uint8_t.serialize(basic.uint8_t, i)[0]);
        return Buffer.from(val);
    }

    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    public get value(): any {
        return this._value;
    }

    public toString(): string {
        /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
        return Buffer.from(this._value as any).toString('hex');
    }
}
export class Bool extends basic.uint8_t {
    static false = 0x00; // An alias for zero, used for clarity.
    static true = 0x01; // An alias for one, used for clarity.
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

export class BlzApsOption extends basic.uint16_t {
    // Options to use when sending a message.

    // No options.
    static APS_OPTION_NONE = 0x0000;
    // UNKNOWN: Discovered while receiving data
    static APS_OPTION_UNKNOWN = 0x0008;
    // Send the message using APS Encryption, using the Link Key shared with the
    // destination node to encrypt the data at the APS Level.
    static APS_OPTION_ENCRYPTION = 0x0020;
    // Resend the message using the APS retry mechanism.
    static APS_OPTION_RETRY = 0x0040;
    // Causes a route discovery to be initiated if no route to the destination
    // is known.
    static APS_OPTION_ENABLE_ROUTE_DISCOVERY = 0x0100;
    // Causes a route discovery to be initiated even if one is known.
    static APS_OPTION_FORCE_ROUTE_DISCOVERY = 0x0200;
    // Include the source EUI64 in the network frame.
    static APS_OPTION_SOURCE_EUI64 = 0x0400;
    // Include the destination EUI64 in the network frame.
    static APS_OPTION_DESTINATION_EUI64 = 0x0800;
    // Send a ZDO request to discover the node ID of the destination, if it is
    // not already know.
    static APS_OPTION_ENABLE_ADDRESS_DISCOVERY = 0x1000;
    // Reserved.
    static APS_OPTION_POLL_RESPONSE = 0x2000;
    // This incoming message is a ZDO request not handled by the BlzZNet
    // stack, and the application is responsible for sending a ZDO response.
    // This flag is used only when the ZDO is configured to have requests
    // handled by the application. See the CONFIG_APPLICATION_ZDO_FLAGS
    // configuration parameter for more information.
    static APS_OPTION_ZDO_RESPONSE_REQUIRED = 0x4000;
    // This message is part of a fragmented message. This option may only be set
    // for unicasts. The groupId field gives the index of this fragment in the
    // low-order byte. If the low-order byte is zero this is the first fragment
    // and the high-order byte contains the number of fragments in the message.
    static APS_OPTION_FRAGMENT = 0x8000;
}

export class BlzKeyStructBitmask extends basic.uint16_t {
    // Describes the presence of valid data within the BlzKeyStruct structure.

    // The key has a sequence number associated with it.
    static KEY_HAS_SEQUENCE_NUMBER = 0x0001;
    // The key has an outgoing frame counter associated with it.
    static KEY_HAS_OUTGOING_FRAME_COUNTER = 0x0002;
    // The key has an incoming frame counter associated with it.
    static KEY_HAS_INCOMING_FRAME_COUNTER = 0x0004;
    // The key has a Partner IEEE address associated with it.
    static KEY_HAS_PARTNER_EUI64 = 0x0008;
}

export class BlzJoinMethod extends basic.uint8_t {
    // The type of method used for joining.

    // Normally devices use MAC Association to join a network, which respects
    // the "permit joining" flag in the MAC Beacon. For mobile nodes this value
    // causes the device to use an Blz Mobile Node Join, which is functionally
    // equivalent to a MAC association. This value should be used by default.
    static USE_MAC_ASSOCIATION = 0x0;
    // For those networks where the "permit joining" flag is never turned on,
    // they will need to use a ZigBee NWK Rejoin. This value causes the rejoin
    // to be sent without NWK security and the Trust Center will be asked to
    // send the NWK key to the device. The NWK key sent to the device can be
    // encrypted with the device's corresponding Trust Center link key. That is
    // determined by the ::BlzJoinDecision on the Trust Center returned by the
    // ::emberTrustCenterJoinHandler(). For a mobile node this value will cause
    // it to use an Blz Mobile node rejoin, which is functionally equivalent.
    static USE_NWK_REJOIN = 0x1;
    // For those networks where the "permit joining" flag is never turned on,
    // they will need to use a NWK Rejoin. If those devices have been
    // preconfigured with the NWK key (including sequence number) they can use a
    // secured rejoin. This is only necessary for end devices since they need a
    // parent. Routers can simply use the ::USE_NWK_COMMISSIONING join method
    // below.
    static USE_NWK_REJOIN_HAVE_NWK_KEY = 0x2;
    // For those networks where all network and security information is known
    // ahead of time, a router device may be commissioned such that it does not
    // need to send any messages to begin communicating on the network.
    static USE_NWK_COMMISSIONING = 0x3;
}

export class BlzZdoConfigurationFlags extends basic.uint8_t {
    // Flags for controlling which incoming ZDO requests are passed to the
    // application. To see if the application is required to send a ZDO response
    // to an incoming message, the application must check the APS options
    // bitfield within the incomingMessageHandler callback to see if the
    // APS_OPTION_ZDO_RESPONSE_REQUIRED flag is set.

    // Set this flag in order to receive supported ZDO request messages via the
    // incomingMessageHandler callback. A supported ZDO request is one that is
    // handled by the BlzZNet stack. The stack will continue to handle the
    // request and send the appropriate ZDO response even if this configuration
    // option is enabled.
    static APP_RECEIVES_SUPPORTED_ZDO_REQUESTS = 0x01;
    // Set this flag in order to receive unsupported ZDO request messages via
    // the incomingMessageHandler callback. An unsupported ZDO request is one
    // that is not handled by the BlzZNet stack, other than to send a 'not
    // supported' ZDO response. If this configuration option is enabled, the
    // stack will no longer send any ZDO response, and it is the application's
    // responsibility to do so.
    static APP_HANDLES_UNSUPPORTED_ZDO_REQUESTS = 0x02;
    // Set this flag in order to receive the following ZDO request messages via
    // the incomingMessageHandler callback: SIMPLE_DESCRIPTOR_REQUEST,
    // MATCH_DESCRIPTORS_REQUEST, and ACTIVE_ENDPOINTS_REQUEST. If this
    // configuration option is enabled, the stack will no longer send any ZDO
    // response for these requests, and it is the application's responsibility
    // to do so.
    static APP_HANDLES_ZDO_ENDPOINT_REQUESTS = 0x04;
    // Set this flag in order to receive the following ZDO request messages via
    // the incomingMessageHandler callback: BINDING_TABLE_REQUEST, BIND_REQUEST,
    // and UNBIND_REQUEST. If this configuration option is enabled, the stack
    // will no longer send any ZDO response for these requests, and it is the
    // application's responsibility to do so.
    static APP_HANDLES_ZDO_BINDING_REQUESTS = 0x08;
}


export class BlzZDOCmd extends basic.uint16_t {
    // Device and Service Discovery Server Requests
    static NWK_addr_req = 0x0000;
    static IEEE_addr_req = 0x0001;
    static Node_Desc_req = 0x0002;
    static Power_Desc_req = 0x0003;
    static Simple_Desc_req = 0x0004;
    static Active_EP_req = 0x0005;
    static Match_Desc_req = 0x0006;
    static Complex_Desc_req = 0x0010;
    static User_Desc_req = 0x0011;
    static Discovery_Cache_req = 0x0012;
    static Device_annce = 0x0013;
    static User_Desc_set = 0x0014;
    static System_Server_Discovery_req = 0x0015;
    static Discovery_store_req = 0x0016;
    static Node_Desc_store_req = 0x0017;
    static Active_EP_store_req = 0x0019;
    static Simple_Desc_store_req = 0x001a;
    static Remove_node_cache_req = 0x001b;
    static Find_node_cache_req = 0x001c;
    static Extended_Simple_Desc_req = 0x001d;
    static Extended_Active_EP_req = 0x001e;
    static Parent_annce = 0x001f;
    //  Bind Management Server Services Responses
    static End_Device_Bind_req = 0x0020;
    static Bind_req = 0x0021;
    static Unbind_req = 0x0022;
    // Network Management Server Services Requests
    // ... TODO optional stuff ...
    static Mgmt_Lqi_req = 0x0031;
    static Mgmt_Rtg_req = 0x0032;
    // ... TODO optional stuff ...
    static Mgmt_Leave_req = 0x0034;
    static Mgmt_Permit_Joining_req = 0x0036;
    static Mgmt_NWK_Update_req = 0x0038;
    // ... TODO optional stuff ...

    // Responses
    // Device and Service Discovery Server Responses
    static NWK_addr_rsp = 0x8000;
    static IEEE_addr_rsp = 0x8001;
    static Node_Desc_rsp = 0x8002;
    static Power_Desc_rsp = 0x8003;
    static Simple_Desc_rsp = 0x8004;
    static Active_EP_rsp = 0x8005;
    static Match_Desc_rsp = 0x8006;
    static Complex_Desc_rsp = 0x8010;
    static User_Desc_rsp = 0x8011;
    static Discovery_Cache_rsp = 0x8012;
    static User_Desc_conf = 0x8014;
    static System_Server_Discovery_rsp = 0x8015;
    static Discovery_Store_rsp = 0x8016;
    static Node_Desc_store_rsp = 0x8017;
    static Power_Desc_store_rsp = 0x8018;
    static Active_EP_store_rsp = 0x8019;
    static Simple_Desc_store_rsp = 0x801a;
    static Remove_node_cache_rsp = 0x801b;
    static Find_node_cache_rsp = 0x801c;
    static Extended_Simple_Desc_rsp = 0x801d;
    static Extended_Active_EP_rsp = 0x801e;
    static Parent_annce_rsp = 0x801f;
    //  Bind Management Server Services Responses
    static End_Device_Bind_rsp = 0x8020;
    static Bind_rsp = 0x8021;
    static Unbind_rsp = 0x8022;
    // ... TODO optional stuff ...
    // Network Management Server Services Responses
    static Mgmt_Lqi_rsp = 0x8031;
    static Mgmt_Rtg_rsp = 0x8032;
    // ... TODO optional stuff ...
    static Mgmt_Leave_rsp = 0x8034;
    static Mgmt_Permit_Joining_rsp = 0x8036;
    // ... TODO optional stuff ...
    static Mgmt_NWK_Update_rsp = 0x8038;
}