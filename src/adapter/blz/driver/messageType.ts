import {BlzMessageCode} from './constants';
import ParameterType from './parameterType';

export interface BlzMessageParameter {
    name: string;
    parameterType: ParameterType;
    options?: object;
}

export interface BlzMessageType {
    response: BlzMessageParameter[];
}


/* istanbul ignore next */
export const BlzMessage: {[k: number]: BlzMessageType} = {
    [BlzMessageCode.Ack]: {
        response: [
            {name: 'ackId', parameterType: ParameterType.UINT16}, // <ackId: uint16_t>
        ],
    },
    [BlzMessageCode.Error]: {
        response: [
            {name: 'errorCode', parameterType: ParameterType.UINT8}, // <errorCode: uint8_t>
        ],
    },
    [BlzMessageCode.ResetAck]: {
        response: [
            {name: 'resetReason', parameterType: ParameterType.UINT8}, // <resetReason: uint8_t>
        ],
    },
    [BlzMessageCode.EnergyScanResultCallback]: {
        response: [
            {name: 'channel', parameterType: ParameterType.UINT8}, // <channel: uint8_t>
            {name: 'rssi', parameterType: ParameterType.INT8}, // <rssi: int8_t>
        ],
    },
    [BlzMessageCode.NetworkScanResultCallback]: {
        response: [
            {name: 'channel', parameterType: ParameterType.UINT8}, // <channel: uint8_t>
            {name: 'panId', parameterType: ParameterType.UINT16}, // <panId: uint16_t>
            {name: 'extendedPanId', parameterType: ParameterType.UINT64}, // <extendedPanId: uint64_t>
            {name: 'associationPermit', parameterType: ParameterType.UINT8}, // <associationPermit: uint8_t>
            {name: 'stackProfile', parameterType: ParameterType.UINT8}, // <stackProfile: uint8_t>
            {name: 'nwkUpdateId', parameterType: ParameterType.UINT8}, // <nwkUpdateId: uint8_t>
            {name: 'beaconLqi', parameterType: ParameterType.UINT8}, // <beaconLqi: uint8_t>
            {name: 'beaconRssi', parameterType: ParameterType.INT8}, // <beaconRssi: int8_t>
        ],
    },
    [BlzMessageCode.ScanCompleteCallback]: {
        response: [
            {name: 'status', parameterType: ParameterType.UINT8}, // <status: uint8_t>
        ],
    },
    [BlzMessageCode.StackStatusCallback]: {
        response: [
            {name: 'status', parameterType: ParameterType.UINT8}, // <status: uint8_t>
        ],
    },
    [BlzMessageCode.DeviceJoinCallback]: {
        response: [
            {name: 'eui64', parameterType: ParameterType.IEEEADDR}, // <eui64: uint64_t>
            {name: 'nodeId', parameterType: ParameterType.UINT16}, // <nodeId: uint16_t>
            {name: 'status', parameterType: ParameterType.UINT8}, // <status: uint8_t>
        ],
    },
    [BlzMessageCode.NwkStatusCallback]: {
        response: [
            {name: 'status', parameterType: ParameterType.UINT8}, // <status: uint8_t>
            {name: 'networkAddress', parameterType: ParameterType.UINT16}, // <networkAddress: uint16_t>
            {name: 'ieeeAddress', parameterType: ParameterType.IEEEADDR}, // <ieeeAddress:
