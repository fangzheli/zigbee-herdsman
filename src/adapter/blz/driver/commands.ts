/* istanbul ignore file */

// import {
//     Bool,
//     EmberAesMmoHashContext,
//     EmberApsFrame,
//     EmberBindingTableEntry,
//     EmberCertificate283k1Data,
//     EmberCertificateData,
//     EmberCounterType,
//     EmberCurrentSecurityState,
//     EmberDeviceUpdate,
//     EmberEUI64,
//     EmberEventUnits,
//     EmberGpAddress,
//     EmberGpKeyType,
//     EmberGpSecurityLevel,
//     EmberIncomingMessageType,
//     EmberInitialSecurityState,
//     EmberJoinDecision,
//     EmberKeyData,
//     EmberKeyStatus,
//     EmberKeyStruct,
//     EmberKeyType,
//     EmberLibraryStatus,
//     EmberMacPassthroughType,
//     EmberMessageDigest,
//     EmberMultiAddress,
//     EmberMulticastTableEntry,
//     EmberNeighbors,
//     EmberNeighborTableEntry,
//     EmberNetworkInitStruct /* Structs */,
//     EmberNetworkParameters,
//     EmberNetworkStatus,
//     EmberNodeDescriptor /* Named Types */,
//     EmberNodeId,
//     EmberNodeType,
//     EmberOutgoingMessageType,
//     EmberPanId,
//     EmberPrivateKeyData,
//     EmberPublicKey283k1Data,
//     EmberPublicKeyData,
//     EmberRouteTableEntry,
//     EmberRoutingTable,
//     EmberSecurityManagerContext,
//     EmberSecurityManagerNetworkKeyInfo,
//     EmberSignature283k1Data,
//     EmberSignatureData,
//     EmberSimpleDescriptor,
//     EmberSmacData,
//     EmberStackError,
//     EmberStatus,
//     EmberTokTypeStackZllData,
//     EmberTokTypeStackZllSecurity,
//     EmberZigbeeNetwork,
//     EmberZllAddressAssignment,
//     EmberZllDeviceInfoRecord,
//     EmberZllInitialSecurityState,
//     EmberZllNetwork,
//     BlzConfigId,
//     BlzDecisionId,
//     BlzExtendedValueId,
//     BlzMfgTokenId,
//     BlzNetworkScanType,
//     BlzPolicyId,
//     BlzStatus,
//     BlzValueId,
//     BlzZllNetworkOperation,
//     fixed_list /* Basic Types */,
//     int8s,
//     LVBytes,
//     SecureBlzRandomNumber,
//     SecureBlzSecurityLevel,
//     SecureBlzSecurityType,
//     SLStatus,
//     uint8_t,
//     uint16_t,
//     uint32_t,
//     WordList,
// } from './types';

export interface ParamsDesc {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    [s: string]: any;
}

export interface BLZFrameDesc {
    ID: number;
    request?: ParamsDesc;
    response?: ParamsDesc;
    minV?: number;
    maxV?: number;
}

import { uint8_t, uint16_t, uint32_t, uint64_t, int8s, Bytes, WordList, LVBytes } from './types';
import { BlzStatus, BlzValueId, BlzPolicyId, BlzDecisionId } from './types';

export const FRAMES: { [key: string]: BLZFrameDesc } = {
    // Control Frames
    ack: {
        ID: 0x0001,
        request: {}, // No request data
        response: {}, // No response data
    },
    error: {
        ID: 0x0002,
        request: {
            errorCode: uint8_t,
        },
        response: {}, // No response data
    },
    reset: {
        ID: 0x0003,
        request: {}, // No request data
        response: {}, // No response data
    },
    resetAck: {
        ID: 0x0004,
        request: {}, // No request data
        response: {
            resetReason: uint8_t,
        },
    },

    // Value Frames
    getValue: {
        ID: 0x0010,
        request: {
            valueId: BlzValueId,
        },
        response: {
            status: BlzStatus,
            valueLength: uint8_t,
            value: Bytes,
        },
    },
    setValue: {
        ID: 0x0011,
        request: {
            valueId: BlzValueId,
            valueLength: uint8_t,
            value: Bytes,
        },
        response: {
            status: BlzStatus,
        },
    },

    // Networking Frames
    getNetworkState: {
        ID: 0x0020,
        request: {}, // No request data
        response: {
            status: BlzStatus,
            networkState: uint8_t,
        },
    },
    formNetwork: {
        ID: 0x0026,
        request: {
            extPanId: uint64_t,
            panId: uint16_t,
            channel: uint8_t,
        },
        response: {
            status: BlzStatus,
        },
    },
    joinNetwork: {
        ID: 0x0027,
        request: {
            extPanId: uint64_t,
            panId: uint16_t,
            channel: uint8_t,
        },
        response: {
            status: BlzStatus,
        },
    },
    leaveNetwork: {
        ID: 0x0028,
        request: {}, // No request data
        response: {
            status: BlzStatus,
        },
    },
    permitJoining: {
        ID: 0x0029,
        request: {
            duration: uint8_t,
        },
        response: {
            status: BlzStatus,
        },
    },
    networkInit: {
        ID: 0x0034,
        request: {}, // No request data
        response: {
            status: BlzStatus,
        },
    },
    getNetworkParameters: {
        ID: 0x002B,
        request: {}, // No request data
        response: {
            status: BlzStatus,
            nodeType: uint8_t,
            extPanId: uint64_t,
            panId: uint16_t,
            txPower: uint8_t,
            channel: uint8_t,
            nwkManager: uint16_t,
            nwkUpdateId: uint8_t,
            channelMask: uint32_t,
        },
    },

    // APS Data Frames
    sendApsData: {
        ID: 0x0080,
        request: {
            msgType: uint8_t,
            dstShortAddr: uint16_t,
            profileId: uint16_t,
            clusterId: uint16_t,
            srcEp: uint8_t,
            dstEp: uint8_t,
            txOptions: uint8_t,
            radius: uint8_t,
            messageTag: uint32_t,
            payloadLen: uint8_t,
            payload: Bytes,
        },
        response: {
            status: BlzStatus,
        },
    },
    apsDataIndication: {
        ID: 0x0082,
        request: {}, // No request data
        response: {
            profileId: uint16_t,
            clusterId: uint16_t,
            srcShortAddr: uint16_t,
            dstShortAddr: uint16_t,
            srcEp: uint8_t,
            dstEp: uint8_t,
            msgType: uint8_t,
            lqi: uint8_t,
            rssi: int8s,
            messageLength: uint8_t,
            message: Bytes,
        },
    },
    apsDataConfirm: {
        ID: 0x0081,
        request: {}, // No request data
        response: {
            profileId: uint16_t,
            clusterId: uint16_t,
            dstShortAddr: uint16_t,
            srcEp: uint8_t,
            dstEp: uint8_t,
            msgType: uint8_t,
            status: uint8_t,
            messageTag: uint32_t,
        },
    },

    // Security Frames
    getNwkSecurityInfos: {
        ID: 0x0050,
        request: {}, // No request data
        response: {
            status: BlzStatus,
            nwkKey: Bytes,
            outgoingFrameCounter: uint32_t,
            nwkKeySeqNum: uint8_t,
        },
    },
    setNwkSecurityInfos: {
        ID: 0x0051,
        request: {
            nwkKey: Bytes,
            outgoingFrameCounter: uint32_t,
            nwkKeySeqNum: uint8_t,
        },
        response: {
            status: BlzStatus,
        },
    },
};

export const FRAME_NAMES_BY_ID: {[key: string]: string[]} = {};
for (const key of Object.getOwnPropertyNames(FRAMES)) {
    const frameDesc = FRAMES[key];
    if (FRAME_NAMES_BY_ID[frameDesc.ID]) {
        FRAME_NAMES_BY_ID[frameDesc.ID].push(key);
    } else {
        FRAME_NAMES_BY_ID[frameDesc.ID] = [key];
    }
}

interface EZSPZDOResponseFrame {
    ID: number;
    params: ParamsDesc;
}

export const ZDOREQUESTS: {[key: string]: EZSPFrameDesc} = {
    // ZDO Device and Discovery Attributes
    nodeDescReq: {
        ID: 0x0002,
        request: {
            transId: uint8_t,
            dstaddr: EmberNodeId,
        },
        response: {
            status: EmberStatus,
        },
    },
    simpleDescReq: {
        ID: 0x0004,
        request: {
            transId: uint8_t,
            dstaddr: EmberNodeId,
            targetEp: uint8_t,
        },
        response: {
            status: EmberStatus,
        },
    },
    activeEpReq: {
        ID: 0x0005,
        request: {
            transId: uint8_t,
            dstaddr: EmberNodeId,
        },
        response: {
            status: EmberStatus,
        },
    },
    // ZDO Bind Manager Attributes
    bindReq: {
        ID: 0x0021,
        request: {
            transId: uint8_t,
            sourceEui: EmberEUI64,
            sourceEp: uint8_t,
            clusterId: uint16_t,
            destAddr: EmberMultiAddress,
        },
        response: {
            status: EmberStatus,
        },
    },
    unBindReq: {
        ID: 0x0022,
        request: {
            transId: uint8_t,
            sourceEui: EmberEUI64,
            sourceEp: uint8_t,
            clusterId: uint16_t,
            destAddr: EmberMultiAddress,
        },
        response: {
            status: EmberStatus,
        },
    },
    // ZDO network manager attributes commands
    mgmtLqiReq: {
        ID: 0x0031,
        request: {
            transId: uint8_t,
            startindex: uint8_t,
        },
        response: {
            status: EmberStatus,
        },
    },
    mgmtRtgReq: {
        ID: 0x0032,
        request: {
            transId: uint8_t,
            startindex: uint8_t,
        },
        response: {
            status: EmberStatus,
        },
    },
    mgmtLeaveReq: {
        ID: 0x0034,
        request: {
            transId: uint8_t,
            destAddr: EmberEUI64,
            removechildrenRejoin: uint8_t,
        },
        response: {
            status: EmberStatus,
        },
    },
    mgmtPermitJoinReq: {
        ID: 0x0036,
        request: {
            transId: uint8_t,
            duration: uint8_t,
            tcSignificant: Bool,
        },
        response: {
            status: EmberStatus,
        },
    },
};

export const ZDORESPONSES: {[key: string]: EZSPZDOResponseFrame} = {
    // ZDO Device and Discovery Attributes
    nodeDescRsp: {
        ID: 0x8002,
        params: {
            transId: uint8_t,
            status: EmberStatus,
            nwkaddr: EmberNodeId,
            descriptor: EmberNodeDescriptor,
        },
    },
    simpleDescRsp: {
        ID: 0x8004,
        params: {
            transId: uint8_t,
            status: EmberStatus,
            nwkaddr: EmberNodeId,
            len: uint8_t,
            descriptor: EmberSimpleDescriptor,
        },
    },
    activeEpRsp: {
        ID: 0x8005,
        params: {
            transId: uint8_t,
            status: EmberStatus,
            nwkaddr: EmberNodeId,
            activeeplist: LVBytes,
        },
    },
    // ZDO Bind Manager Attributes
    bindRsp: {
        ID: 0x8021,
        params: {
            transId: uint8_t,
            status: EmberStatus,
        },
    },
    unBindRsp: {
        ID: 0x8022,
        params: {
            transId: uint8_t,
            status: EmberStatus,
        },
    },
    // ZDO network manager attributes commands
    mgmtLqiRsp: {
        ID: 0x8031,
        params: {
            transId: uint8_t,
            status: EmberStatus,
            neighborlqilist: EmberNeighbors,
        },
    },
    mgmtRtgRsp: {
        ID: 0x8032,
        params: {
            transId: uint8_t,
            status: EmberStatus,
            routingtablelist: EmberRoutingTable,
        },
    },
    mgmtLeaveRsp: {
        ID: 0x8034,
        params: {
            transId: uint8_t,
            status: EmberStatus,
        },
    },
    mgmtPermitJoinRsp: {
        ID: 0x8036,
        params: {
            transId: uint8_t,
            status: EmberStatus,
        },
    },
};

export const ZGP: {[key: string]: EZSPZDOResponseFrame} = {};

export const ZDOREQUEST_NAME_BY_ID: {[key: string]: string} = {};
for (const key of Object.getOwnPropertyNames(ZDOREQUESTS)) {
    const frameDesc = ZDOREQUESTS[key];
    ZDOREQUEST_NAME_BY_ID[frameDesc.ID] = key;
}

export const ZDORESPONSE_NAME_BY_ID: {[key: string]: string} = {};
for (const key of Object.getOwnPropertyNames(ZDORESPONSES)) {
    const frameDesc = ZDORESPONSES[key];
    ZDORESPONSE_NAME_BY_ID[frameDesc.ID] = key;
}
