/* istanbul ignore file */

import {EventEmitter} from 'events';

import equals from 'fast-deep-equal/es6';

import {Wait, Waitress} from '../../../utils';
import {logger} from '../../../utils/logger';
import * as ZSpec from '../../../zspec';
import {Clusters} from '../../../zspec/zcl/definition/cluster';
import * as Zdo from '../../../zspec/zdo';
import {GenericZdoResponse} from '../../../zspec/zdo/definition/tstypes';
// Import BLZAdapterBackup instead of EZSPAdapterBackup
import {BLZAdapterBackup} from '../adapter/backup';
import * as TsType from './../../tstype';
import {ParamsDesc} from './commands';
// Import Blz and BLZFrameData instead of Ezsp and EZSPFrameData
import {Blz, BLZFrameData} from './blz';
// Update imports to BLZ-specific types
import {BlzApsOption, BlzJoinDecision, BlzKeyData, BlzNodeType, BlzStatus, uint8_t, uint16_t, uint32_t, Bytes} from './types';
import {
    BlzDerivedKeyType,
    BlzDeviceUpdate,
    BlzEUI64,
    BlzInitialSecurityBitmask,
    BlzJoinMethod,
    BlzKeyType,
    BlzNetworkStatus,
    BlzOutgoingMessageType,
    BlzStackError,
    BlzDecisionBitmask,
    BlzPolicyId,
    BlzValueId,
} from './types/named';
import {
    BlzAesMmoHashContext,
    BlzApsFrame,
    BlzIeeeRawFrame,
    BlzInitialSecurityState,
    BlzKeyStruct,
    BlzNetworkParameters,
    BlzRawFrame,
    BlzSecurityManagerContext,
} from './types/struct';
import {blz_security} from './utils';

const NS = 'zh:blz:driv';

interface AddEndpointParameters {
    endpoint?: number;
    profileId?: number;
    deviceId?: number;
    appFlags?: number;
    inputClusters?: number[];
    outputClusters?: number[];
}

type BlzFrame = {
    address: number | string;
    payload: Buffer;
    frame: BlzApsFrame;
    zdoResponse?: GenericZdoResponse;
};

type BlzWaitressMatcher = {
    address: number | string;
    clusterId: number;
    sequence: number;
};

type IeeeMfg = {
    mfgId: number;
    prefix: number[];
};

export interface BlzIncomingMessage {
    messageType: number;
    apsFrame: BlzApsFrame;
    lqi: number;
    rssi: number;
    sender: number;
    bindingIndex: number;
    addressIndex: number;
    message: Buffer;
    senderEui64: BlzEUI64;
    zdoResponse?: GenericZdoResponse;
}

const IEEE_PREFIX_MFG_ID: IeeeMfg[] = [
    {mfgId: 0x115f, prefix: [0x04, 0xcf, 0xfc]},
    {mfgId: 0x115f, prefix: [0x54, 0xef, 0x44]},
];
const DEFAULT_MFG_ID = 0x1049;
// we make three attempts to send the request
const REQUEST_ATTEMPT_DELAYS = [500, 1000, 1500];

export class Driver extends EventEmitter {
    // @ts-expect-error XXX: init in startup
    public blz: Blz;
    private nwkOpt: TsType.NetworkOptions;
    // @ts-expect-error XXX: init in startup
    public networkParams: BlzNetworkParameters;
    //// @ts-expect-error XXX: init in startup
    // public version: {
    //     product: number;
    //     major: string;
    //     minor: string;
    //     patch: string;
    //     build: string;
    // };
    private eui64ToNodeId = new Map<string, number>();
    // private eui64ToRelays = new Map<string, number>();
    // @ts-expect-error XXX: init in startup
    public ieee: BlzEUI64;
    //// @ts-expect-error XXX: init in startup
    // private multicast: Multicast;
    private waitress: Waitress<BlzFrame, BlzWaitressMatcher>;
    private transactionID = 1;
    private serialOpt: TsType.SerialPortOptions;
    public backupMan: BLZAdapterBackup;

    constructor(serialOpt: TsType.SerialPortOptions, nwkOpt: TsType.NetworkOptions, backupPath: string) {
        super();

        this.nwkOpt = nwkOpt;
        this.serialOpt = serialOpt;
        this.waitress = new Waitress<BlzFrame, BlzWaitressMatcher>(this.waitressValidator, this.waitressTimeoutFormatter);
        this.backupMan = new BLZAdapterBackup(this, backupPath);
    }

    /**
     * Requested by the BLZ watchdog after too many failures, or by UART layer after port closed unexpectedly.
     * Tries to stop the layers below and startup again.
     * @returns
     */
    public async reset(): Promise<void> {
        logger.debug(`Reset connection.`, NS);

        try {
            // don't emit 'close' on stop since we don't want this to bubble back up as 'disconnected' to the controller.
            await this.stop(false);
        } catch (err) {
            logger.debug(`Stop error ${err}`, NS);
        }
        try {
            await Wait(1000);
            logger.debug(`Startup again.`, NS);
            await this.startup();
        } catch (err) {
            logger.debug(`Reset error ${err}`, NS);

            try {
                // here we let emit
                await this.stop();
            } catch (stopErr) {
                logger.debug(`Failed to stop after failed reset ${stopErr}`, NS);
            }
        }
    }

    private async onBlzReset(): Promise<void> {
        logger.debug('onBlzReset()', NS);
        await this.reset();
    }

    private onBlzClose(): void {
        logger.debug('onBlzClose()', NS);
        this.emit('close');
    }

    public async stop(emitClose: boolean = true): Promise<void> {
        logger.debug('Stopping driver', NS);

        if (this.blz) {
            return await this.blz.close(emitClose);
        }
    }

    public async startup(): Promise<TsType.StartResult> {
        let result: TsType.StartResult = 'resumed';
        this.transactionID = 1;
        this.blz = new Blz();
        this.blz.on('close', this.onBlzClose.bind(this));

        try {
            await this.blz.connect(this.serialOpt);
        } catch (error) {
            logger.debug(`BLZ could not connect: ${error}`, NS);

            throw error;
        }

        this.blz.on('reset', this.onBlzReset.bind(this));

        // await this.blz.version();
        // Add endpoints as per BLZ requirements
        await this.addEndpoint({
            inputClusters: [0x0000, 0x0003, 0x0006, 0x000a, 0x0019, 0x001a, 0x0300],
            outputClusters: [
                0x0000, 0x0003, 0x0004, 0x0005, 0x0006, 0x0008, 0x0020, 0x0300, 0x0400, 0x0402, 0x0405, 0x0406, 0x0500, 0x0b01, 0x0b03, 0x0b04,
                0x0702, 0x1000, 0xfc01, 0xfc02,
            ],
        });
        await this.addEndpoint({
            endpoint: 242,
            profileId: 0xa1e0,
            deviceId: 0x61,
            outputClusters: [0x0021],
        });

        // // Retrieve version info specific to BLZ
        // let verInfo = await this.blz.getValue(BlzValueId.BLZ_VALUE_ID_BLZ_VERSION);
        // // Parse version info according to BLZ's format
        // // Update parsing logic if necessary
        // let build, major, minor, patch;
        // [build, verInfo] = uint16_t.deserialize(uint16_t, verInfo);
        // [major, verInfo] = uint8_t.deserialize(uint8_t, verInfo);
        // [minor, verInfo] = uint8_t.deserialize(uint8_t, verInfo);
        // [patch, verInfo] = uint8_t.deserialize(uint8_t, verInfo);
        // const vers = `${major}.${minor}.${patch}.${build}`;
        // logger.debug(`BLZ version: ${vers}`, NS);
        // this.version = {
        //     product: 1,
        //     major: `${major}`,
        //     minor: `${minor}`,
        //     patch: `${patch} `,
        //     build: `${build}`,
        // };
        await this.blz.getVersion();

        if (await this.needsToBeInitialised(this.nwkOpt)) {
            // need to check the backup
            const restore = await this.needsToBeRestore(this.nwkOpt);

            //TODO: change the part according to network State
            // const res = await this.blz.execCommand('networkState');

            // logger.debug(`Network state ${res.status}`, NS);

            // if (res.status == BlzNetworkStatus.JOINED_NETWORK) {
            logger.info(`Leaving current network and forming new network`, NS);

            const st = await this.blz.leaveNetwork();

            if (st != BlzStatus.SUCCESS) {
                logger.error(`leaveNetwork returned unexpected status: ${st}`, NS);
            }
            // }

            if (restore) {
                // restore
                logger.info('Restore network from backup', NS);
                await this.formNetwork(true);
                result = 'restored';
            } else {
                // reset
                logger.info('Form network', NS);
                await this.formNetwork(false);
                result = 'reset';
            }
        }

        // const state = (await this.blz.execCommand('networkState')).status;
        // logger.debug(`Network state ${state}`, NS);

        const netParams = await this.blz.execCommand('getNetworkParameters');

        if (netParams.status != BlzStatus.SUCCESS) {
            logger.error(`Command (getNetworkParameters) returned unexpected state: ${netParams.status}`, NS);
        }

        this.networkParams.extendedPanId = netParams.extPanId;
        this.networkParams.panId = netParams.panId;
        this.networkParams.Channel = netParams.channel;
        logger.debug(`Node type: ${netParams.nodeType}, Network parameters: ${this.networkParams}`, NS);

        const ieee = (await this.blz.execCommand('getValue', {valueId: BlzValueId.BLZ_VALUE_ID_MAC_ADDRESS})).value;
        this.ieee = new BlzEUI64(ieee);
        const nwk = (await this.blz.execCommand('getNodeIdByEui64', {eui64: ieee})).nodeId;
        logger.debug('Network ready', NS);
        this.blz.on('frame', this.handleFrame.bind(this));
        logger.debug(`BLZ nwk=${nwk}, IEEE=0x${this.ieee}`, NS);
        // Retrieve keys using BLZ-specific commands
        // const linkResult = await this.getKey(BlzKeyType.TRUST_CENTER_LINK_KEY);
        // logger.debug(`TRUST_CENTER_LINK_KEY: ${JSON.stringify(linkResult)}`, NS);
        // const netResult = await this.getKey(BlzKeyType.CURRENT_NETWORK_KEY);
        // logger.debug(`CURRENT_NETWORK_KEY: ${JSON.stringify(netResult)}`, NS);

        // await Wait(1000);
        // await this.blz.execCommand('setManufacturerCode', {code: DEFAULT_MFG_ID});

        // this.multicast = new Multicast(this);
        // await this.multicast.startup([]);
        // await this.multicast.subscribe(ZSpec.GP_GROUP_ID, ZSpec.GP_ENDPOINT);
        // await this.multicast.subscribe(1, 901);

        return result;
    }

    private async needsToBeInitialised(options: TsType.NetworkOptions): Promise<boolean> {
        let valid = true;
        valid = valid && (await this.blz.networkInit());
        const netParams = await this.blz.execCommand('getNetworkParameters');
        // const networkParams = netParams.parameters;
        logger.debug(`Current Node type: ${netParams.nodeType}, Network parameters: ${netParams}`, NS);
        valid = valid && netParams.status == BlzStatus.SUCCESS;
        valid = valid && netParams.nodeType == BlzNodeType.COORDINATOR;
        valid = valid && options.panID == netParams.panId;
        valid = valid && options.channelList.includes(netParams.channel);
        valid = valid && equals(options.extendedPanID, netParams.extPanId);
        return !valid;
    }

    private async formNetwork(restore: boolean): Promise<void> {
        let backup;
        // // Clear transient link keys if applicable in BLZ
        // await this.blz.execCommand('clearTransientLinkKeys');

        // let initial_security_state: BlzInitialSecurityState;
        if (restore) {
            backup = await this.backupMan.getStoredBackup();

            if (!backup) {
                throw new Error(`No valid backup found.`);
            }

            const {sequenceNumber, frameCounter } = backup.networkKeyInfo;
            const networkKey = backup.networkOptions.networkKey
            await this.setNetworkKeyInfo(networkKey, frameCounter, sequenceNumber);
            await this.setGlobalTcLinkKey(backup.blz!.tclk!, backup.blz!.tclkFrameCounter!);
        } 
        // else {
        //     initial_security_state = blz_security(Buffer.from(this.nwkOpt.networkKey!));
        // }

        // const parameters: BlzNetworkParameters = new BlzNetworkParameters();
        // parameters.TxPower = 5;
        // parameters.joinMethod = BlzJoinMethod.USE_MAC_ASSOCIATION;
        // parameters.nwkManagerId = 0;
        // parameters.nwkUpdateId = 0;
        // parameters.channels = 0x07fff800; // all channels
        if (restore) {
            // `backup` valid from above
            // parameters.panId = backup!.networkOptions.panId;
            // parameters.extendedPanId = backup!.networkOptions.extendedPanId;
            // parameters.channels = backup!.logicalChannel;
            // parameters.nwkUpdateId = backup!.networkUpdateId;
            await this.blz.formNetwork(backup!.networkOptions.extendedPanId, backup!.networkOptions.panId, backup!.logicalChannel);
        } else {
            // parameters.channels = this.nwkOpt.channelList[0];
            // parameters.panId = this.nwkOpt.panID;
            // parameters.extendedPanId = Buffer.from(this.nwkOpt.extendedPanID!);
            await this.blz.networkInit();
        }

    }

    private handleFrame(frameName: string, frame: BLZFrameData): void {
        switch (true) {
            case frameName === 'apsDataIndication': {
                const apsFrame: BlzApsFrame = new BlzApsFrame();
                apsFrame.profileId = frame.profileId;
                apsFrame.clusterId = frame.clusterId;
                apsFrame.sourceEndpoint = frame.srcEp;
                apsFrame.destinationEndpoint = frame.dstEp;
                apsFrame.sequence = 0; //TODO
                apsFrame.groupId = frame.dstShortAddr

                if (frame.profileId == Zdo.ZDO_PROFILE_ID && frame.clusterId >= 0x8000 /* response only */) {
                    const zdoResponse = Zdo.Buffalo.readResponse(true, frame.clusterId, frame.message);

                    if (frame.clusterId === Zdo.ClusterId.NETWORK_ADDRESS_RESPONSE) {
                        // special case to properly resolve a NETWORK_ADDRESS_RESPONSE following a NETWORK_ADDRESS_REQUEST (based on EUI64 from ZDO payload)
                        // NOTE: if response has invalid status (no EUI64 available), response waiter will eventually time out
                        /* istanbul ignore else */
                        if (Zdo.Buffalo.checkStatus<Zdo.ClusterId.NETWORK_ADDRESS_RESPONSE>(zdoResponse)) {
                            const eui64 = zdoResponse[1].eui64;

                            // update cache with new network address
                            this.eui64ToNodeId.set(eui64, frame.srcShortAddr);

                            this.waitress.resolve({
                                address: eui64,
                                payload: frame.message,
                                frame: apsFrame,
                                zdoResponse,
                            });
                        }
                    } else {
                        this.waitress.resolve({
                            address: frame.srcShortAddr,
                            payload: frame.message,
                            frame: apsFrame,
                            zdoResponse,
                        });
                    }

                    // always pass ZDO to bubble up to controller
                    this.emit('incomingMessage', {
                        messageType: frame.msgType,
                        apsFrame,
                        lqi: frame.lqi,
                        rssi: frame.rssi,
                        sender: frame.srcShortAddr,
                        bindingIndex: null,
                        addressIndex: null,
                        message: frame.message,
                        senderEui64: this.eui64ToNodeId.get(frame.srcShortAddr),
                        zdoResponse,
                    });
                } else {
                    const handled = this.waitress.resolve({
                        address: frame.srcShortAddr,
                        payload: frame.message,
                        frame: apsFrame,
                    });

                    if (!handled) {
                        this.emit('incomingMessage', {
                            messageType: frame.msgType,
                            apsFrame,
                            lqi: frame.lqi,
                            rssi: frame.rssi,
                            sender: frame.srcShortAddr,
                            bindingIndex: null,
                            addressIndex: null,
                            message: frame.message,
                            senderEui64: this.eui64ToNodeId.get(frame.srcShortAddr),
                        });
                    }
                }
                break;
            }
            case frameName === 'deviceJoinCallback': {
                this.handleNodeJoined(frame.nodeId, frame.eui64);
                break;
                }
            case frameName === 'nwkStatusCallback': {
                this.handleNetworkStatus(frame.status, frame.networkAddress, frame.ieeeAddress);
                break;
                }
            default:
                logger.debug(`Unhandled frame ${frameName}`, NS);
        }
    }

    // private handleRouteRecord(nwk: number, ieee: BlzEUI64 | number[], lqi: number, rssi: number, relays: number): void {
    //     // todo
    //     logger.debug(`handleRouteRecord: nwk=${nwk}, ieee=${ieee.toString()}, lqi=${lqi}, rssi=${rssi}, relays=${relays}`, NS);

    //     this.setNode(nwk, ieee);
    // }

    // private handleRouteError(status: BlzStatus, nwk: number): void {
    //     // todo
    //     logger.debug(`handleRouteError: nwk=${nwk}, status=${status}`, NS);
    // }

    private handleNetworkStatus(status: BlzStatus, networkAddress: number, ieeeAddress: number): void {
        logger.debug(`handleNetworkStatus: nwkAddress=${networkAddress}, ieeeAddress=${ieeeAddress}，networkStatusCode=${status}`, NS);
    }

    // private handleNodeLeft(nwk: number, ieee: BlzEUI64 | number[]): void {
    //     if (ieee && !(ieee instanceof BlzEUI64)) {
    //         ieee = new BlzEUI64(ieee);
    //     }

    //     this.eui64ToNodeId.delete(ieee.toString());
    //     this.emit('deviceLeft', nwk, ieee);
    // }

    // private async resetMfgId(mfgId: number): Promise<void> {
    //     await this.blz.execCommand('setManufacturerCode', {code: mfgId});
    //     // 60 sec for waiting
    //     await Wait(60000);
    //     await this.blz.execCommand('setManufacturerCode', {code: DEFAULT_MFG_ID});
    // }

    public handleNodeJoined(nwk: number, ieee: BlzEUI64 | number[]): void {
        if (ieee && !(ieee instanceof BlzEUI64)) {
            ieee = new BlzEUI64(ieee);
        }

        // for (const rec of IEEE_PREFIX_MFG_ID) {
        //     if (Buffer.from(ieee.value).indexOf(Buffer.from(rec.prefix)) == 0) {
        //         // set ManufacturerCode
        //         logger.debug(`handleNodeJoined: change ManufacturerCode for ieee ${ieee} to ${rec.mfgId}`, NS);
        //         // eslint-disable-next-line @typescript-eslint/no-floating-promises
        //         this.resetMfgId(rec.mfgId);
        //         break;
        //     }
        // }

        this.eui64ToNodeId.set(ieee.toString(), nwk);
        this.emit('deviceJoined', nwk, ieee);
    }

    public setNode(nwk: number, ieee: BlzEUI64 | number[]): void {
        if (ieee && !(ieee instanceof BlzEUI64)) {
            ieee = new BlzEUI64(ieee);
        }

        this.eui64ToNodeId.set(ieee.toString(), nwk);
    }

    public async request(nwk: number | BlzEUI64, apsFrame: BlzApsFrame, data: Buffer, extendedTimeout = false): Promise<boolean> {
        let result = false;

        for (const delay of REQUEST_ATTEMPT_DELAYS) {
            try {
                const seq = (apsFrame.sequence + 1) & 0xff;
                let eui64: BlzEUI64;

                if (typeof nwk !== 'number') {
                    eui64 = nwk as BlzEUI64;
                    const strEui64 = eui64.toString();
                    let nodeId = this.eui64ToNodeId.get(strEui64);

                    if (nodeId === undefined) {
                        nodeId = (await this.blz.execCommand('getNodeIdByEui64', {eui64: eui64})).nodeId;
                        // TODO
                        if (nodeId && nodeId !== 0xffff) {
                            this.eui64ToNodeId.set(strEui64, nodeId);
                        } else {
                            throw new Error('Unknown EUI64:' + strEui64);
                        }
                    }
                    nwk = nodeId;
                } else {
                    eui64 = await this.networkIdToEUI64(nwk);
                }

                // if (extendedTimeout) {
                //     await this.blz.execCommand('setExtendedTimeout', {remoteEui64: eui64, extendedTimeout: true});
                // }

                const sendResult = await this.blz.sendApsData(
                    BlzOutgoingMessageType.BLZ_MSG_TYPE_UNICAST, // msgType
                    nwk,                                        // dstShortAddr
                    apsFrame.profileId,                         // profileId
                    apsFrame.clusterId,                         // clusterId
                    apsFrame.sourceEndpoint,                    // srcEp
                    apsFrame.destinationEndpoint,               // dstEp
                    0,                                          // txOptions
                    5,                                        // radius
                    seq,                                        // messageTag
                    data.length,                                // payloadLen
                    data                                        // payload
                );
                

                // repeat only for these statuses
                result = sendResult == BlzStatus.SUCCESS;
                break;
            } catch (e) {
                logger.debug(`Request error ${e}`, NS);
                break;
            }
        }

        return result;
    }

    // Modify mrequest to use sendApsData with multicast msgType
    public async mrequest(apsFrame: BlzApsFrame, data: Buffer, timeout = 30000): Promise<boolean> {
        try {
            const seq = (apsFrame.sequence + 1) & 0xff;
            const sendResult = await this.blz.sendApsData(
                BlzOutgoingMessageType.BLZ_MSG_TYPE_MULTICAST, // msgType
                apsFrame.groupId ?? 0,                         // dstShortAddr
                apsFrame.profileId,                            // profileId
                apsFrame.clusterId,                            // clusterId
                apsFrame.sourceEndpoint,                       // srcEp
                apsFrame.destinationEndpoint,                  // dstEp
                0,                                             // txOptions
                5,                                             // radius
                seq,                                           // messageTag
                data.length,                                   // payloadLen
                data                                           // payload
            );
        } catch {
            return false;
        }
        return true;
    }

    // Modify brequest to use sendApsData with broadcast msgType
    public async brequest(destination: number, apsFrame: BlzApsFrame, data: Buffer): Promise<boolean> {
        try {
            const seq = (apsFrame.sequence + 1) & 0xff;
            const sendResult = await this.blz.sendApsData(
                BlzOutgoingMessageType.BLZ_MSG_TYPE_MULTICAST, // msgType
                destination,                         // dstShortAddr
                apsFrame.profileId,                            // profileId
                apsFrame.clusterId,                            // clusterId
                apsFrame.sourceEndpoint,                       // srcEp
                apsFrame.destinationEndpoint,                  // dstEp
                0,                                             // txOptions
                5,                                             // radius
                seq,                                           // messageTag
                data.length,                                   // payloadLen
                data                                           // payload
            );
        } catch {
            return false;
        }
        return true;
    }

    private nextTransactionID(): number {
        this.transactionID = (this.transactionID + 1) & 0xff;
        return this.transactionID;
    }

    public makeApsFrame(clusterId: number, disableResponse: boolean): BlzApsFrame {
        const frame = new BlzApsFrame();
        frame.clusterId = clusterId;
        frame.profileId = 0;
        frame.sequence = this.nextTransactionID();
        frame.sourceEndpoint = 0;
        frame.destinationEndpoint = 0;
        frame.groupId = 0;
        frame.options = BlzApsOption.APS_OPTION_ENABLE_ROUTE_DISCOVERY || BlzApsOption.APS_OPTION_ENABLE_ADDRESS_DISCOVERY;

        if (!disableResponse) {
            frame.options ||= BlzApsOption.APS_OPTION_RETRY;
        }

        return frame;
    }

    public async networkIdToEUI64(nwk: number): Promise<BlzEUI64> {
        // Check if we already have the mapping
        for (const [eui64Str, nodeId] of this.eui64ToNodeId) {
            if (nodeId === nwk) return new BlzEUI64(eui64Str);
        }
    
        // Use BLZ command to get EUI64 by node ID
        const response = await this.blz.execCommand('getEui64ByNodeId', {nodeId: nwk});
    
        if (response.status === BlzStatus.SUCCESS) {
            const eui64 = new BlzEUI64(response.eui64);
            this.eui64ToNodeId.set(eui64.toString(), nwk);
    
            return eui64;
        } else {
            throw new Error('Unrecognized nodeId:' + nwk);
        }
    }
    
    // public async preJoining(seconds: number): Promise<void> {
    //     if (seconds) {
    //         const ieee = new BlzEUI64('0xFFFFFFFFFFFFFFFF');
    //         const linkKey = new BlzKeyData();
    //         linkKey.contents = Buffer.from('ZigBeeAlliance09');
    //         const result = await this.addTransientLinkKey(ieee, linkKey);

    //         if (result.status !== BlzStatus.SUCCESS) {
    //             throw new Error(`Add Transient Link Key for '${ieee}' failed`);
    //         }
    //     } else {
    //         await this.blz.execCommand('clearTransientLinkKeys');
    //     }
    // }

    public async permitJoining(seconds: number): Promise<BLZFrameData> {
        return await this.blz.execCommand('permitJoining', {duration: seconds});
    }

    // public makeZDOframe(name: string | number, params: ParamsDesc): Buffer {
    //     return this.blz.makeZDOframe(name, params);
    // }

    public async addEndpoint({
        endpoint = 1,
        profileId = 260,
        deviceId = 0xbeef,
        appFlags = 0,
        inputClusters = [],
        outputClusters = [],
    }: AddEndpointParameters): Promise<void> {
        const res = await this.blz.execCommand('addEndpoint', {
            endpoint: endpoint,
            profileId: profileId,
            deviceId: deviceId,
            appFlags: appFlags,
            inputClusterCount: inputClusters.length,
            outputClusterCount: outputClusters.length,
            inputClusterList: inputClusters,
            outputClusterList: outputClusters,
        });
        logger.debug(() => `Blz adding endpoint: ${JSON.stringify(res)}`, NS);
    }

    public waitFor(
        address: number | string,
        clusterId: number,
        sequence: number,
        timeout = 10000,
    ): ReturnType<typeof this.waitress.waitFor> & {cancel: () => void} {
        const waiter = this.waitress.waitFor({address, clusterId, sequence}, timeout);

        return {...waiter, cancel: () => this.waitress.remove(waiter.ID)};
    }

    private waitressTimeoutFormatter(matcher: BlzWaitressMatcher, timeout: number): string {
        return `${JSON.stringify(matcher)} after ${timeout}ms`;
    }

    private waitressValidator(payload: BlzFrame, matcher: BlzWaitressMatcher): boolean {
        return (
            (!matcher.address || payload.address === matcher.address) &&
            (!payload.frame || payload.frame.clusterId === matcher.clusterId) &&
            (!payload.frame || payload.payload[0] === matcher.sequence)
        );
    }

    // public setChannel(channel: number): Promise<BLZFrameData> {
    //     return this.blz.execCommand('setChannel', {channel: channel});
    // }

    // public addTransientLinkKey(partner: BlzEUI64, transientKey: BlzKeyData): Promise<BLZFrameData> {
    //     return this.blz.execCommand('addTransientLinkKey', {partner, transientKey});
    // }

    public async getGlobalTcLinkKey(): Promise<BLZFrameData> {
        const frameResponse = await this.blz.execCommand('getGlobalTcLinkKey');
    
        const { status, linkKey, outgoingFrameCounter, trustCenterAddress } = frameResponse;
    
        if (status !== BlzStatus.SUCCESS) {
            logger.error(`getGlobalTcLinkKey() returned unexpected BLZ status: ${status}`, NS);
            throw new Error(`Failed to get global Trust Center key: status ${status}`);
        }
    
        logger.debug(
            `Global TC Key retrieved: Key=${linkKey}, FrameCounter=${outgoingFrameCounter}, TCAddress=${trustCenterAddress}`,
            NS
        );
    
        return frameResponse; // Return the full frameResponse object
    }

    public async setGlobalTcLinkKey(
        linkKey: Bytes,
        outgoingFrameCounter: uint32_t
    ): Promise<BlzStatus> {
        // Construct the request payload
        const frameRequest = {
            linkKey,
            outgoingFrameCounter,
        };
    
        // Execute the command
        const frameResponse = await this.blz.execCommand('setGlobalTcLinkKey', frameRequest);
    
        // Extract the status from the response
        const { status } = frameResponse;
    
        // Validate the response status
        if (status !== BlzStatus.SUCCESS) {
            logger.error(`setGlobalTcLinkKey() failed with status: ${status}`, NS);
            throw new Error(`Failed to set global Trust Center key: status ${status}`);
        }
    
        logger.debug(
            `Global TC Key set successfully: Key=${linkKey}, FrameCounter=${outgoingFrameCounter}`,
            NS
        );
    
        return status; // Return the status of the operation
    }

    public async getNetworkKeyInfo(): Promise<BLZFrameData> {
        const frameResponse = await this.blz.execCommand('getNwkSecurityInfos');
    
        const { status, nwkKey, outgoingFrameCounter, nwkKeySeqNum } = frameResponse;
    
        if (status !== BlzStatus.SUCCESS) {
            logger.error(`getNetworkKeyInfo() returned unexpected BLZ status: ${status}`, NS);
            throw new Error(`Failed to get network key info: status ${status}`);
        }
    
        logger.debug(
            `Network Key Info retrieved: Key=${nwkKey}, FrameCounter=${outgoingFrameCounter}, SeqNum=${nwkKeySeqNum}`,
            NS
        );
    
        return frameResponse; // Return the full frameResponse object
    }
    
    public async setNetworkKeyInfo(
        nwkKey: Bytes,
        outgoingFrameCounter: uint32_t,
        nwkKeySeqNum: uint8_t
    ): Promise<BlzStatus> {
        // Construct the request payload
        const frameRequest = {
            nwkKey,
            outgoingFrameCounter,
            nwkKeySeqNum,
        };
    
        // Execute the command
        const frameResponse = await this.blz.execCommand('setNwkSecurityInfos', frameRequest);
    
        // Extract the status from the response
        const { status } = frameResponse;
    
        // Validate the response status
        if (status !== BlzStatus.SUCCESS) {
            logger.error(`setNwkSecurityInfos() failed with status: ${status}`, NS);
            throw new Error(`Failed to set network security infos: status ${status}`);
        }
    
        logger.debug(
            `Network Security Infos set successfully: Key=${nwkKey}, FrameCounter=${outgoingFrameCounter}, SeqNum=${nwkKeySeqNum}`,
            NS
        );
    
        return status; // Return the status of the operation
    }
    

    private async needsToBeRestore(options: TsType.NetworkOptions): Promise<boolean> {
        // if no backup and the settings have been changed, then need to start a new network
        const backup = await this.backupMan.getStoredBackup();
        if (!backup) return false;

        let valid = true;
        //valid = valid && (await this.blz.networkInit());
        const netParams = await this.blz.execCommand('getNetworkParameters');
        // const networkParams = netParams.parameters;
        logger.debug(`Current Node type: ${netParams.nodeType}, Network parameters: ${netParams}`, NS);
        logger.debug(`Backuped network parameters: ${backup.networkOptions}`, NS);
        const networkKey = await this.getNetworkKeyInfo();
        let netKey: Buffer;

        netKey = Buffer.from((networkKey.keyStruct as BlzKeyStruct).key.contents);

        // if the settings in the backup match the chip, then need to warn to delete the backup file first
        valid = valid && netParams.panId == backup.networkOptions.panId;
        valid = valid && netParams.channel == backup.logicalChannel;
        valid = valid && Buffer.from(netParams.extPanId).equals(backup.networkOptions.extendedPanId);
        valid = valid && Buffer.from(netKey).equals(backup.networkOptions.networkKey);
        if (valid) {
            logger.error(`Configuration is not consistent with adapter backup!`, NS);
            logger.error(`- PAN ID: configured=${options.panID}, adapter=${netParams.panId}, backup=${backup.networkOptions.panId}`, NS);
            logger.error(
                `- Extended PAN ID: configured=${Buffer.from(options.extendedPanID!).toString('hex')}, ` +
                    `adapter=${Buffer.from(netParams.extPanId).toString('hex')}, ` +
                    `backup=${Buffer.from(netParams.extPanId).toString('hex')}`,
                NS,
            );
            logger.error(`- Channel: configured=${options.channelList}, adapter=${netParams.channel}, backup=${backup.logicalChannel}`, NS);
            logger.error(
                `- Network key: configured=${Buffer.from(options.networkKey!).toString('hex')}, ` +
                    `adapter=${Buffer.from(netKey).toString('hex')}, ` +
                    `backup=${backup.networkOptions.networkKey.toString('hex')}`,
                NS,
            );
            logger.error(`Please update configuration to prevent further issues.`, NS);
            logger.error(`If you wish to re-commission your network, please remove coordinator backup.`, NS);
            logger.error(`Re-commissioning your network will require re-pairing of all devices!`, NS);
            throw new Error('startup failed - configuration-adapter mismatch - see logs above for more information');
        }
        valid = true;
        // if the settings in the backup match the config, then the old network is in the chip and needs to be restored
        valid = valid && options.panID == backup.networkOptions.panId;
        valid = valid && options.channelList.includes(backup.logicalChannel);
        valid = valid && Buffer.from(options.extendedPanID!).equals(backup.networkOptions.extendedPanId);
        valid = valid && Buffer.from(options.networkKey!).equals(backup.networkOptions.networkKey);
        return valid;
    }
}
