import {BlzCommandCode, BlzMessageCode, BlzObjectPayload} from './constants';
import ParameterType from './parameterType';

export interface PermitJoinPayload extends BlzObjectPayload {
    targetShortAddress: number;
    interval: number;
    TCsignificance?: number;
}

export interface RawAPSDataRequestPayload extends BlzObjectPayload {
    addressMode: number;
    targetShortAddress: number;
    sourceEndpoint: number;
    destinationEndpoint: number;
    profileID: number;
    clusterID: number;
    securityMode: number;
    radius: number;
    dataLength: number;
    data: Buffer;
}

export interface BlzCommandParameter {
    name: string;
    parameterType: ParameterType;
}

export interface BlzCommandType {
    request: BlzCommandParameter[];
    response?: BlzResponseMatcher[];
    waitStatus?: boolean;
}

export interface BlzResponseMatcherRule {
    receivedProperty: string;
    matcher: (expected: string | number, received: string | number) => boolean;
    expectedProperty?: string;
    expectedExtraParameter?: string;
    value?: string | number;
}

export function equal(expected: string | number, received: string | number): boolean {
    return expected === received;
}

export type BlzResponseMatcher = BlzResponseMatcherRule[];

export const BlzCommand: {[key: string]: BlzCommandType} = {
    [BlzCommandCode.Reset]: {
        request: [],
        response: [
            // [
            //     {receivedProperty: 'code', matcher: equal, value: 0x02}, // RESET_COMPLETE
            // ],
        ],
    },
    [BlzCommandCode.GetValue]: {
        request: [
            {name: 'valueId', parameterType: ParameterType.UINT8},
        ],
        response: [
            [
                {receivedProperty: 'status', matcher: equal, value: 0x00}, // STATUS.SUCCESS
                {receivedProperty: 'value', matcher: equal, expectedProperty: 'value'},
            ],
        ],
    },
    [BlzCommandCode.SetValue]: {
        request: [
            {name: 'valueId', parameterType: ParameterType.UINT8},
            {name: 'valueLength', parameterType: ParameterType.UINT8},
            {name: 'value', parameterType: ParameterType.BUFFER},
        ],
        response: [
            [
                {receivedProperty: 'status', matcher: equal, value: 0x00}, // STATUS.SUCCESS
            ],
        ],
    },
    [BlzCommandCode.GetNetworkState]: {
        request: [],
        response: [
            [
                {receivedProperty: 'networkState', matcher: equal, value: 0x00}, // NETWORK_STATE.OFFLINE
            ],
            [
                {receivedProperty: 'networkState', matcher: equal, value: 0x01}, // NETWORK_STATE.CONNECTED
            ],
        ],
    },
    [BlzCommandCode.SendApsData]: {
        request: [
            {name: 'addressMode', parameterType: ParameterType.UINT8},
            {name: 'shortAddress', parameterType: ParameterType.UINT16},
            {name: 'sourceEndpoint', parameterType: ParameterType.UINT8},
            {name: 'destinationEndpoint', parameterType: ParameterType.UINT8},
            {name: 'profileID', parameterType: ParameterType.UINT16},
            {name: 'clusterID', parameterType: ParameterType.UINT16},
            {name: 'securityMode', parameterType: ParameterType.UINT8},
            {name: 'radius', parameterType: ParameterType.UINT8},
            {name: 'dataLength', parameterType: ParameterType.UINT8},
            {name: 'data', parameterType: ParameterType.BUFFER},
        ],
        response: [
            [
                {receivedProperty: 'status', matcher: equal, value: 0x00}, // STATUS.SUCCESS
            ],
        ],
    },
    [BlzCommandCode.GetNwkSecurityInfos]: {
        request: [],
        response: [
            [
                {receivedProperty: 'status', matcher: equal, value: 0x00}, // STATUS.SUCCESS
            ],
            [
                {receivedProperty: 'nwkKey', matcher: equal, expectedProperty: 'nwkKey'},
            ],
        ],
    },
    [BlzCommandCode.SetBootEntry]: {
        request: [
            {name: 'bootEntry', parameterType: ParameterType.BUFFER},
        ],
        response: [
            [
                {receivedProperty: 'status', matcher: equal, value: 0x00}, // STATUS.SUCCESS
            ],
        ],
    },
};

    // [BlzCommandCode.RawAPSDataRequest]: {
    //     request: [
    //         {name: 'addressMode', parameterType: ParameterType.UINT8}, // <address mode: uint8_t>
    //         {name: 'targetShortAddress', parameterType: ParameterType.UINT16}, // <target short address: uint16_t>
    //         {name: 'sourceEndpoint', parameterType: ParameterType.UINT8}, // <source endpoint: uint8_t>
    //         {name: 'destinationEndpoint', parameterType: ParameterType.UINT8}, // <destination endpoint: uint8_t>
    //         {name: 'clusterID', parameterType: ParameterType.UINT16}, // <cluster ID: uint16_t>
    //         {name: 'profileID', parameterType: ParameterType.UINT16}, // <profile ID: uint16_t>
    //         {name: 'securityMode', parameterType: ParameterType.UINT8}, // <security mode: uint8_t>
    //         {name: 'radius', parameterType: ParameterType.UINT8}, // <radius: uint8_t>
    //         {name: 'dataLength', parameterType: ParameterType.UINT8}, // <data length: uint8_t>
    //         {name: 'data', parameterType: ParameterType.BUFFER}, // <data: auint8_t>
    //     ]
    // };
    // [BlzCommandCode.NodeDescriptor]: {
    //     request: [
    //         {name: 'targetShortAddress', parameterType: ParameterType.UINT16}, // <target short address: uint16_t>
    //     ],
    //     response: [
    //         [
    //             {
    //                 receivedProperty: 'code',
    //                 matcher: equal,
    //                 value: BlzMessageCode.DataIndication,
    //             },
    //             {
    //                 receivedProperty: 'payload.sourceAddress',
    //                 matcher: equal,
    //                 expectedProperty: 'payload.targetShortAddress',
    //             },
    //             {
    //                 receivedProperty: 'payload.clusterID',
    //                 matcher: equal,
    //                 value: 0x8002,
    //             },
    //         ],
    //     ],
    // },
    // [BlzCommandCode.ActiveEndpoint]: {
    //     request: [
    //         {name: 'targetShortAddress', parameterType: ParameterType.UINT16}, // <target short address: uint16_t>
    //     ],
    //     response: [
    //         [
    //             {
    //                 receivedProperty: 'code',
    //                 matcher: equal,
    //                 value: BlzMessageCode.DataIndication,
    //             },
    //             {
    //                 receivedProperty: 'payload.sourceAddress',
    //                 matcher: equal,
    //                 expectedProperty: 'payload.targetShortAddress',
    //             },
    //             {
    //                 receivedProperty: 'payload.clusterID',
    //                 matcher: equal,
    //                 value: 0x8005,
    //             },
    //         ],
    //     ],
    // },
    // [BlzCommandCode.SimpleDescriptor]: {
    //     request: [
    //         {name: 'targetShortAddress', parameterType: ParameterType.UINT16}, // <target short address: uint16_t>
    //         {name: 'endpoint', parameterType: ParameterType.UINT8}, // <endpoint: uint8_t>
    //     ],
    //     response: [
    //         [
    //             {receivedProperty: 'code', matcher: equal, value: BlzMessageCode.DataIndication},
    //             {
    //                 receivedProperty: 'payload.sourceAddress',
    //                 matcher: equal,
    //                 expectedProperty: 'payload.targetShortAddress',
    //             },
    //             {
    //                 receivedProperty: 'payload.clusterID',
    //                 matcher: equal,
    //                 value: 0x8004,
    //             },
    //         ],
    //     ],
    // },
    // [BlzCommandCode.Bind]: {
    //     request: [
    //         {name: 'targetExtendedAddress', parameterType: ParameterType.IEEEADDR}, // <target extended address: uint64_t>
    //         {name: 'targetEndpoint', parameterType: ParameterType.UINT8}, // <target endpoint: uint8_t>
    //         {name: 'clusterID', parameterType: ParameterType.UINT16}, // <cluster ID: uint16_t>
    //         {name: 'destinationAddressMode', parameterType: ParameterType.UINT8}, // <destination address mode: uint8_t>
    //         {
    //             name: 'destinationAddress',
    //             parameterType: ParameterType.ADDRESS_WITH_TYPE_DEPENDENCY,
    //         }, // <destination address:uint16_t or uint64_t>
    //         {name: 'destinationEndpoint', parameterType: ParameterType.UINT8}, // <destination endpoint (
    //         // value ignored for group address): uint8_t>
    //     ],
    //     response: [
    //         [
    //             {
    //                 receivedProperty: 'code',
    //                 matcher: equal,
    //                 value: BlzMessageCode.DataIndication,
    //             },
    //             {
    //                 receivedProperty: 'payload.sourceAddress',
    //                 matcher: equal,
    //                 expectedExtraParameter: 'destinationNetworkAddress',
    //             },
    //             {
    //                 receivedProperty: 'payload.clusterID',
    //                 matcher: equal,
    //                 value: 0x8021,
    //             },
    //             {
    //                 receivedProperty: 'payload.profileID',
    //                 matcher: equal,
    //                 value: 0x0000,
    //             },
    //         ],
    //     ],
    // },
    // [BlzCommandCode.UnBind]: {
    //     request: [
    //         {name: 'targetExtendedAddress', parameterType: ParameterType.IEEEADDR}, // <target extended address: uint64_t>
    //         {name: 'targetEndpoint', parameterType: ParameterType.UINT8}, // <target endpoint: uint8_t>
    //         {name: 'clusterID', parameterType: ParameterType.UINT16}, // <cluster ID: uint16_t>
    //         {name: 'destinationAddressMode', parameterType: ParameterType.UINT8}, // <destination address mode: uint8_t>
    //         {
    //             name: 'destinationAddress',
    //             parameterType: ParameterType.ADDRESS_WITH_TYPE_DEPENDENCY,
    //         }, // <destination address:uint16_t or uint64_t>
    //         {name: 'destinationEndpoint', parameterType: ParameterType.UINT8}, // <destination endpoint (
    //         // value ignored for group address): uint8_t>
    //     ],
    //     response: [
    //         [
    //             {
    //                 receivedProperty: 'code',
    //                 matcher: equal,
    //                 value: BlzMessageCode.DataIndication,
    //             },
    //             {
    //                 receivedProperty: 'payload.sourceAddress',
    //                 matcher: equal,
    //                 expectedExtraParameter: 'destinationNetworkAddress',
    //             },
    //             {
    //                 receivedProperty: 'payload.clusterID',
    //                 matcher: equal,
    //                 value: 0x8022,
    //             },
    //             {
    //                 receivedProperty: 'payload.profileID',
    //                 matcher: equal,
    //                 value: 0x0000,
    //             },
    //         ],
    //     ],
    // },
    // [BlzCommandCode.AddGroup]: {
    //     request: [
    //         {name: 'addressMode', parameterType: ParameterType.UINT8}, //<device type: uint8_t>
    //         {name: 'shortAddress', parameterType: ParameterType.UINT16},
    //         {name: 'sourceEndpoint', parameterType: ParameterType.UINT8},
    //         {name: 'destinationEndpoint', parameterType: ParameterType.UINT8},
    //         {name: 'groupAddress', parameterType: ParameterType.UINT16},
    //     ],
    // },
// };
