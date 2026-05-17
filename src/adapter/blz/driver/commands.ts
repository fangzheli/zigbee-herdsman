/* istanbul ignore file */
// biome-ignore-all lint/suspicious/noExplicitAny: BLZ command schemas use dynamic runtime field descriptors.

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

import {BlzStatus, BlzValueId, Bytes, int8s, uint8_t, uint16_t, uint32_t, uint64_t, WordList} from "./types";
import {Fixed16Bytes} from "./types/basic";

export const FRAMES: {[key: string]: BLZFrameDesc} = {
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

    getNodeIdByEui64: {
        ID: 0x0012,
        request: {
            eui64: uint64_t,
        },
        response: {
            status: BlzStatus,
            nodeId: uint16_t,
        },
    },
    getEui64ByNodeId: {
        ID: 0x0013,
        request: {
            nodeId: uint16_t,
        },
        response: {
            status: BlzStatus,
            eui64: uint64_t,
        },
    },
    getNextZdpSequenceNum: {
        ID: 0x0014,
        request: {}, // No request data
        response: {
            status: BlzStatus,
            seqNum: uint8_t,
        },
    },

    // Endpoint Management
    addEndpoint: {
        ID: 0x0015,
        request: {
            endpoint: uint8_t,
            profileId: uint16_t,
            deviceId: uint16_t,
            appFlags: uint8_t,
            inputClusterCount: uint8_t,
            outputClusterCount: uint8_t,
            inputClusterList: WordList,
            outputClusterList: WordList,
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
    getNetworkParameters: {
        ID: 0x002b,
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
    networkInit: {
        ID: 0x0034,
        request: {}, // No request data
        response: {
            status: BlzStatus,
        },
    },
    stackStatusHandler: {
        ID: 0x0035,
        request: {}, // No request data
        response: {
            status: BlzStatus,
        },
    },
    deviceJoinCallback: {
        ID: 0x0036,
        request: {}, // No request data
        response: {
            eui64: uint64_t,
            nodeId: uint16_t,
            status: uint8_t,
        },
    },
    getNwkPayloadLimit: {
        ID: 0x0037,
        request: {
            dstAddr: uint16_t,
        },
        response: {
            status: BlzStatus,
            payloadLimit: uint8_t,
        },
    },
    nwkStatusCallback: {
        ID: 0x0038,
        request: {}, // No request data
        response: {
            status: BlzStatus,
            valueLength: uint8_t,
            value: Bytes,
        },
    },

    // Security Frames
    getNwkSecurityInfos: {
        ID: 0x0050,
        request: {}, // No request data
        response: {
            status: BlzStatus,
            nwkKey: Fixed16Bytes,
            outgoingFrameCounter: uint32_t,
            nwkKeySeqNum: uint8_t,
        },
    },
    setNwkSecurityInfos: {
        ID: 0x0051,
        request: {
            nwkKey: Fixed16Bytes,
            outgoingFrameCounter: uint32_t,
            nwkKeySeqNum: uint8_t,
        },
        response: {
            status: BlzStatus,
        },
    },
    getGlobalTcLinkKey: {
        ID: 0x0052,
        request: {}, // No request data
        response: {
            status: BlzStatus,
            linkKey: Fixed16Bytes,
            outgoingFrameCounter: uint32_t,
            trustCenterAddress: uint64_t,
        },
    },
    setGlobalTcLinkKey: {
        ID: 0x0053,
        request: {
            linkKey: Fixed16Bytes,
            outgoingFrameCounter: uint32_t,
        },
        response: {
            status: BlzStatus,
        },
    },
    getUniqueTcLinkKey: {
        ID: 0x0054,
        request: {
            index: uint16_t,
        },
        response: {
            status: BlzStatus,
            linkKey: Fixed16Bytes,
            outgoingFrameCounter: uint32_t,
            deviceIeeeAddress: uint64_t,
        },
    },
    setUniqueTcLinkKey: {
        ID: 0x0055,
        request: {
            eui64: uint64_t,
            uniqueTcLinkKey: Fixed16Bytes,
        },
        response: {
            status: BlzStatus,
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
