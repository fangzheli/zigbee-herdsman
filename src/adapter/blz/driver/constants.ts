import {ClusterId as ZdoClusterId} from '../../../zspec/zdo';

export enum ADDRESS_MODE {
    bound = 0x00, //Use one or more bound nodes/endpoints, with acknowledgements
    group = 0x01, //Use a pre-defined group address, with acknowledgements
    short = 0x02, //Use a 16-bit network address, with acknowledgements
    ieee = 0x03, //Use a 64-bit IEEE/MAC address, with acknowledgements
    broadcast = 0x04, //Perform a broadcast
    no_transmit = 0x05, //Do not transmit
    bound_no_ack = 0x06, //Perform a bound transmission, with no acknowledgements
    short_no_ack = 0x07, //Perform a transmission using a 16-bit network address, with no acknowledgements
    ieee_no_ack = 0x08, //Perform a transmission using a 64-bit IEEE/MAC address, with no acknowledgements
    bound_non_blocking = 0x09, //Perform a non-blocking bound transmission, with acknowledgements
    bound_non_blocking_no_ack = 10, //Perform a non-blocking bound transmission, with no acknowledgements
}

export enum DEVICE_TYPE {
    coordinator = 0,
    router = 1,
    legacy_router = 2,
}

export enum BOOLEAN {
    false = 0x00,
    true = 0x01,
}

export enum LOG_LEVEL {
    'EMERG',
    'ALERT',
    'CRIT ',
    'ERROR',
    'WARN ',
    'NOT  ',
    'INFO ',
    'DEBUG',
}

export enum NODE_LOGICAL_TYPE {
    coordinator = 0x00,
    router = 0x01,
    end_device = 0x02,
}

export enum STATUS {
    E_SL_MSG_STATUS_SUCCESS,
    E_SL_MSG_STATUS_INCORRECT_PARAMETERS,
    E_SL_MSG_STATUS_UNHANDLED_COMMAND,
    E_SL_MSG_STATUS_BUSY,
    E_SL_MSG_STATUS_STACK_ALREADY_STARTED,
}

export enum PERMIT_JOIN_STATUS {
    on = 1, // devices are allowed to join network
    off = 0, // devices are not allowed join the network
}

export enum NETWORK_JOIN_STATUS {
    joined_existing_network = 0,
    formed_new_network = 1,
}

export enum ON_OFF_STATUS {
    on = 1,
    off = 0,
}

export enum RESTART_STATUS {
    startup = 0,
    nfn_start = 2,
    running = 6,
}

/**
 * BLZ Command Codes
 * These represent the different command requests that can be sent to the device.
 */
export enum BlzCommandCode {
    // Control Commands
    Reset = 0x0003,
    GetValue = 0x0010,
    SetValue = 0x0011,
    GetNodeIdByEUI64 = 0x0012,
    GetEUI64ByNodeId = 0x0013,
    GetNextZdpSequenceNum = 0x0014,
    AddEndpoint = 0x0015,

    // Networking Commands
    GetNetworkState = 0x0020,
    StartScan = 0x0021,
    StopScan = 0x0025,
    FormNetwork = 0x0026,
    JoinNetwork = 0x0027,
    LeaveNetwork = 0x0028,
    PermitJoining = 0x0029,
    EnergyScanRequest = 0x002A,
    GetNetworkParameters = 0x002B,

    // APS Data Commands
    SendApsData = 0x0080,

    // Security Commands
    GetNwkSecurityInfos = 0x0050,
    SetNwkSecurityInfos = 0x0051,
    GetGlobalTcLinkKey = 0x0052,
    SetGlobalTcLinkKey = 0x0053,
    GetUniqueTcLinkKey = 0x0054,
    SetUniqueTcLinkKey = 0x0055,

    // Other Commands
    SetConcentrator = 0x0033,
    NetworkInit = 0x0034,
    SetBootEntry = 0x0090
}

export enum ZiGateCommandCode {
    GetNetworkState = 0x0009,
    RawMode = 0x0002,
    SetExtendedPANID = 0x0020,
    SetChannelMask = 0x0021,
    GetVersion = 0x0010,
    Reset = 0x0011,
    ErasePersistentData = 0x0012,
    RemoveDevice = 0x0026,
    RawAPSDataRequest = 0x0530,
    GetTimeServer = 0x0017,
    SetTimeServer = 0x0016,
    PermitJoinStatus = 0x0014,
    GetDevicesList = 0x0015,

    StartNetwork = 0x0024,
    StartNetworkScan = 0x0025,
    SetCertification = 0x0019,

    // ResetFactoryNew = 0x0013,
    OnOff = 0x0092,
    OnOffTimed = 0x0093,
    AttributeDiscovery = 0x0140,
    AttributeRead = 0x0100,
    AttributeWrite = 0x0110,
    DescriptorComplex = 0x0531,

    // zdo
    Bind = 0x0030,
    UnBind = 0x0031,
    NwkAddress = 0x0040,
    IEEEAddress = 0x0041,
    NodeDescriptor = 0x0042,
    SimpleDescriptor = 0x0043,
    PowerDescriptor = 0x0044,
    ActiveEndpoint = 0x0045,
    MatchDescriptor = 0x0046,
    // ManagementLeaveRequest = 0x0047, XXX: some non-standard form of LeaveRequest?
    PermitJoin = 0x0049,
    ManagementNetworkUpdate = 0x004a,
    SystemServerDiscovery = 0x004b,
    LeaveRequest = 0x004c,
    ManagementLQI = 0x004e,
    // ManagementRtg = 0x004?,
    // ManagementBind = 0x004?,

    SetDeviceType = 0x0023,
    LED = 0x0018,
    SetTXpower = 0x0806,
    SetSecurityStateKey = 0x0022,
    AddGroup = 0x0060,
}

export const ZDO_REQ_CLUSTER_ID_TO_ZIGATE_COMMAND_ID: Readonly<Partial<Record<ZdoClusterId, BlzCommandCode>>> = {
    [ZdoClusterId.NETWORK_ADDRESS_REQUEST]: ZiGateCommandCode.NwkAddress,
    [ZdoClusterId.IEEE_ADDRESS_REQUEST]: ZiGateCommandCode.IEEEAddress,
    [ZdoClusterId.NODE_DESCRIPTOR_REQUEST]: ZiGateCommandCode.NodeDescriptor,
    [ZdoClusterId.POWER_DESCRIPTOR_REQUEST]: ZiGateCommandCode.PowerDescriptor,
    [ZdoClusterId.SIMPLE_DESCRIPTOR_REQUEST]: ZiGateCommandCode.SimpleDescriptor,
    [ZdoClusterId.MATCH_DESCRIPTORS_REQUEST]: ZiGateCommandCode.MatchDescriptor,
    [ZdoClusterId.ACTIVE_ENDPOINTS_REQUEST]: ZiGateCommandCode.ActiveEndpoint,
    [ZdoClusterId.SYSTEM_SERVER_DISCOVERY_REQUEST]: ZiGateCommandCode.SystemServerDiscovery,
    [ZdoClusterId.BIND_REQUEST]: ZiGateCommandCode.Bind,
    [ZdoClusterId.UNBIND_REQUEST]: ZiGateCommandCode.UnBind,
    [ZdoClusterId.LQI_TABLE_REQUEST]: ZiGateCommandCode.ManagementLQI,
    // [ZdoClusterId.ROUTING_TABLE_REQUEST]: ZiGateCommandCode.ManagementRtg,
    // [ZdoClusterId.BINDING_TABLE_REQUEST]: ZiGateCommandCode.ManagementBind,
    [ZdoClusterId.LEAVE_REQUEST]: ZiGateCommandCode.LeaveRequest,
    [ZdoClusterId.NWK_UPDATE_REQUEST]: ZiGateCommandCode.ManagementNetworkUpdate,
    [ZdoClusterId.PERMIT_JOINING_REQUEST]: BlzCommandCode.PermitJoining,
};

/**
 * BLZ Message Codes
 * These represent the different responses, callbacks, and notifications received from the device.
 */
export enum BlzMessageCode {
    // Status and Control Messages
    Ack = 0x0001,
    Error = 0x0002,
    ResetAck = 0x0004,

    // Networking Messages
    EnergyScanResultCallback = 0x0022,
    NetworkScanResultCallback = 0x0023,
    ScanCompleteCallback = 0x0024,
    StackStatusCallback = 0x0035,
    DeviceJoinCallback = 0x0036,
    NwkStatusCallback = 0x0038,

    // APS Data Messages
    ApsDataIndication = 0x0082,
    ApsDataConfirm = 0x0081,
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ZiGateObjectPayload = any;

export enum ZPSNwkKeyState {
    ZPS_ZDO_NO_NETWORK_KEY,
    ZPS_ZDO_PRECONFIGURED_LINK_KEY,
    ZPS_ZDO_DISTRIBUTED_LINK_KEY,
    ZPS_ZDO_PRECONFIGURED_INSTALLATION_CODE,
}

export enum ZPSNwkKeyType {
    ZPS_APS_UNIQUE_LINK_KEY /*Initial key*/,
    ZPS_APS_GLOBAL_LINK_KEY,
}


/* istanbul ignore next */
const coordinatorEndpoints: readonly {ID: number; profileID: number; deviceID: number; inputClusters: number[]; outputClusters: number[]}[] = [
    {
        ID: 0x01,
        profileID: 0x0104,
        deviceID: 0x0840,
        inputClusters: [0x0000, 0x0003, 0x0019, 0x0204, 0x000f],
        outputClusters: [
            0x0b03, 0x0000, 0x0300, 0x0004, 0x0003, 0x0008, 0x0006, 0x0005, 0x0101, 0x0702, 0x0500, 0x0019, 0x0201, 0x0401, 0x0400, 0x0406, 0x0403,
            0x0405, 0x0402, 0x0204, 0x0001, 0x0b05, 0x1000,
        ],
    },
    {
        ID: 0x0a,
        profileID: 0x0104,
        deviceID: 0x0840,
        inputClusters: [0x0000, 0x0003, 0x0019, 0x0204, 0x000f],
        outputClusters: [
            0x0b03, 0x0000, 0x0300, 0x0004, 0x0003, 0x0008, 0x0006, 0x0005, 0x0101, 0x0702, 0x0500, 0x0019, 0x0201, 0x0401, 0x0400, 0x0406, 0x0403,
            0x0405, 0x0402, 0x0204, 0x0001, 0x0b05, 0x1000,
        ],
    },
];

export {coordinatorEndpoints};


export enum BlzTransmitOptions {
    NONE = 0x00,
    SECURITY_ENABLED = 0x01,
    ACK_ENABLED = 0x04
}

export enum BlzMsgType {
    UNICAST = 0x01,
    MULTICAST = 0x02,
    BROADCAST = 0x03
}

export enum BlzDeviceRole {
    COORDINATOR = 0x00,
    ROUTER = 0x01,
    NONSLEEPY_ENDDEVICE = 0x02, // rx on when idle = true
    LOWPOWER_ROUTER = 0x81,
    SLEEPY_ENDDEVICE = 0x82,
    INVALID = 0xff
}

export enum Status {
    SUCCESS = 0,
    FAILURE = 1,
    TIMEOUT = 2
}

export enum NetworkState {
    OFFLINE = 0,
    CONNECTED = 1
}

export enum BlzValueId {
    BLZ_VERSION = 0x00,
    STACK_VERSION = 0x01,
    NEIGHBOR_TABLE_SIZE = 0x02,
    SOURCE_ROUTE_TABLE_SIZE = 0x03,
    ROUTE_TABLE_SIZE = 0x04,
    DISCOVERY_TABLE_SIZE = 0x05,
    ADDRESS_TABLE_SIZE = 0x06,
    MULTICAST_TABLE_SIZE = 0x07,
    BROADCAST_TABLE_SIZE = 0x08,
    BINDING_TABLE_SIZE = 0x09,
    MAX_END_DEVICE_CHILDREN = 0x0A,
    INDIRECT_TRANSMISSION_TIMEOUT = 0x0B,
    END_DEVICE_BIND_TIMEOUT = 0x0C,
    UNIQUE_TC_LINK_KEY_TABLE_SIZE = 0x0D,
    TRUST_CENTER_ADDRESS = 0x0F,
    MAC_ADDRESS = 0x20,
    APP_VERSION = 0x21
}

export class FirmwareVersion {
    major: number;
    minor: number;
    patch: number;
    reserved: number;

    constructor(major: number, minor: number, patch: number, reserved: number) {
        this.major = major;
        this.minor = minor;
        this.patch = patch;
        this.reserved = reserved;
    }
}

