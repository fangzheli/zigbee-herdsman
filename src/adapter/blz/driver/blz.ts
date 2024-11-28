/* istanbul ignore file */

import { EventEmitter } from 'events';

import { Queue, Wait, Waitress } from '../../../utils';
import { logger } from '../../../utils/logger';
import { SerialPortOptions } from '../../tstype';
import {
    BLZFrameDesc,
    FRAME_NAMES_BY_ID,
    FRAMES,
    ParamsDesc,
    ZDOREQUEST_NAME_BY_ID,
    ZDOREQUESTS,
    ZDORESPONSE_NAME_BY_ID,
    ZDORESPONSES,
} from './commands';
import * as t from './types';
import {
    BlzConcentratorType,
    BlzOutgoingMessageType,
    BlzStatus,
    BlzZdoConfigurationFlags,
    BlzConfigId,
    BlzDecisionBitmask,
    BlzDecisionId,
    BlzPolicyId,
} from './types/named';
import { BlzApsFrame, BlzNetworkParameters } from './types/struct';
import { SerialDriver } from './uart';
import {BlzApsOption, BlzJoinDecision, BlzKeyData, BlzNodeType, uint8_t, uint16_t, uint32_t, uint64_t, Bytes} from './types';
import {BlzValueId} from './types/named';

const NS = 'zh:blz:blz';

const MAX_SERIAL_CONNECT_ATTEMPTS = 4;
/** In ms. This is multiplied by tries count (above), e.g., 4 tries = 5000, 10000, 15000 */
const SERIAL_CONNECT_NEW_ATTEMPT_MIN_DELAY = 5000;
const MTOR_MIN_INTERVAL = 10;
const MTOR_MAX_INTERVAL = 90;
const MTOR_ROUTE_ERROR_THRESHOLD = 4;
const MTOR_DELIVERY_FAIL_THRESHOLD = 3;
const MAX_WATCHDOG_FAILURES = 4;
// const RESET_ATTEMPT_BACKOFF_TIME = 5;
const WATCHDOG_WAKE_PERIOD = 10; // in sec
// const BLZ_COUNTER_CLEAR_INTERVAL = 180;  // Clear counters every n * WATCHDOG_WAKE_PERIOD
const BLZ_DEFAULT_RADIUS = 0;

const POLICY_IDS_CURRENT: number[][] = [
    [BlzPolicyId.APP_KEY_REQUEST_POLICY, BlzDecisionId.DENY_APP_KEY_REQUESTS],
    [BlzPolicyId.TC_KEY_REQUEST_POLICY, BlzDecisionId.ALLOW_TC_KEY_REQUESTS],
    [BlzPolicyId.TRUST_CENTER_POLICY, BlzDecisionBitmask.ALLOW_UNSECURED_REJOINS | BlzDecisionBitmask.ALLOW_JOINS],
];

/**
 * Type-specific for BLZ Frames.
 */
type BLZFrame = {
    sequence: number;
    frameId: number;
    frameName: string;
    payload: BLZFrameData;
};

type BLZWaitressMatcher = {
    // sequence: number | null;
    frameId: number | string;
};

export class BLZFrameData {
    _cls_: string;
    _id_: number;
    _isRequest_: boolean;
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    [name: string]: any;

    static createFrame(frame_id: number, isRequest: boolean, params: ParamsDesc | Buffer): BLZFrameData {
        const names = FRAME_NAMES_BY_ID[frame_id];
        if (!names) {
            throw new Error(`Unrecognized frame FrameID ${frame_id}`);
        }
        let frm: BLZFrameData;
        names.every((frameName) => {
            const frameDesc = BLZFrameData.getFrame(frameName);
            try {
                frm = new BLZFrameData(frameName, isRequest, params);
            } catch (error) {
                logger.error(`Frame ${frameName} parsing error: ${error}`, NS);
                return true;
            }
            return false;
        });
        return frm!;
    }

    static getFrame(name: string): BLZFrameDesc {
        const frameDesc = FRAMES[name];
        if (!frameDesc) throw new Error(`Unrecognized frame from FrameID ${name}`);
        return frameDesc;
    }

    constructor(key: string, isRequest: boolean, params: ParamsDesc | Buffer | undefined) {
        this._cls_ = key;
        this._id_ = FRAMES[this._cls_].ID;

        this._isRequest_ = isRequest;
        const frame = BLZFrameData.getFrame(key);
        const frameDesc = this._isRequest_ ? frame.request || {} : frame.response || {};
        if (Buffer.isBuffer(params)) {
            let data = params;
            for (const prop of Object.getOwnPropertyNames(frameDesc)) {
                [this[prop], data] = frameDesc[prop].deserialize(frameDesc[prop], data);
            }
        } else {
            for (const prop of Object.getOwnPropertyNames(frameDesc)) {
                this[prop] = params![prop];
            }
        }
    }

    serialize(): Buffer {
        const frame = BLZFrameData.getFrame(this._cls_);
        const frameDesc = this._isRequest_ ? frame.request || {} : frame.response || {};
        const result = [];
        for (const prop of Object.getOwnPropertyNames(frameDesc)) {
            result.push(frameDesc[prop].serialize(frameDesc[prop], this[prop]));
        }
        return Buffer.concat(result);
    }

    get name(): string {
        return this._cls_;
    }

    get id(): number {
        return this._id_;
    }
}

export class BLZZDORequestFrameData {
    _cls_: string;
    _id_: number;
    _isRequest_: boolean;
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    [name: string]: any;

    static getFrame(key: string | number): BLZFrameDesc {
        const name = typeof key == 'string' ? key : ZDOREQUEST_NAME_BY_ID[key];
        const frameDesc = ZDOREQUESTS[name];
        if (!frameDesc) throw new Error(`Unrecognized ZDOFrame from FrameID ${key}`);
        return frameDesc;
    }

    constructor(key: string | number, isRequest: boolean, params: ParamsDesc | Buffer) {
        if (typeof key == 'string') {
            this._cls_ = key;
            this._id_ = ZDOREQUESTS[this._cls_].ID;
        } else {
            this._id_ = key;
            this._cls_ = ZDOREQUEST_NAME_BY_ID[key];
        }

        this._isRequest_ = isRequest;
        const frame = BLZZDORequestFrameData.getFrame(key);
        const frameDesc = this._isRequest_ ? frame.request || {} : frame.response || {};
        if (Buffer.isBuffer(params)) {
            let data = params;
            for (const prop of Object.getOwnPropertyNames(frameDesc)) {
                [this[prop], data] = frameDesc[prop].deserialize(frameDesc[prop], data);
            }
        } else {
            for (const prop of Object.getOwnPropertyNames(frameDesc)) {
                this[prop] = params[prop];
            }
        }
    }

    serialize(): Buffer {
        const frame = BLZZDORequestFrameData.getFrame(this._cls_);
        const frameDesc = this._isRequest_ ? frame.request || {} : frame.response || {};
        const result = [];
        for (const prop of Object.getOwnPropertyNames(frameDesc)) {
            result.push(frameDesc[prop].serialize(frameDesc[prop], this[prop]));
        }
        return Buffer.concat(result);
    }

    get name(): string {
        return this._cls_;
    }

    get id(): number {
        return this._id_;
    }
}

export class BLZZDOResponseFrameData {
    _cls_: string;
    _id_: number;
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    [name: string]: any;

    static getFrame(key: string | number): ParamsDesc {
        const name = typeof key == 'string' ? key : ZDORESPONSE_NAME_BY_ID[key];
        const frameDesc = ZDORESPONSES[name];
        if (!frameDesc) throw new Error(`Unrecognized ZDOFrame from FrameID ${key}`);
        return frameDesc.params;
    }

    constructor(key: string | number, params: ParamsDesc | Buffer) {
        if (typeof key == 'string') {
            this._cls_ = key;
            this._id_ = ZDORESPONSES[this._cls_].ID;
        } else {
            this._id_ = key;
            this._cls_ = ZDORESPONSE_NAME_BY_ID[key];
        }

        const frameDesc = BLZZDOResponseFrameData.getFrame(key);
        if (Buffer.isBuffer(params)) {
            let data = params;
            for (const prop of Object.getOwnPropertyNames(frameDesc)) {
                [this[prop], data] = frameDesc[prop].deserialize(frameDesc[prop], data);
            }
        } else {
            for (const prop of Object.getOwnPropertyNames(frameDesc)) {
                this[prop] = params[prop];
            }
        }
    }

    serialize(): Buffer {
        const frameDesc = BLZZDOResponseFrameData.getFrame(this._cls_);
        const result = [];
        for (const prop of Object.getOwnPropertyNames(frameDesc)) {
            result.push(frameDesc[prop].serialize(frameDesc[prop], this[prop]));
        }
        return Buffer.concat(result);
    }

    get name(): string {
        return this._cls_;
    }

    get id(): number {
        return this._id_;
    }
}

export class Blz extends EventEmitter {
    cmdSeq = 0; // command sequence

    private serialDriver: SerialDriver;
    private waitress: Waitress<BLZFrame, BLZWaitressMatcher>;
    private queue: Queue;
    private watchdogTimer?: NodeJS.Timeout;
    private failures = 0;
    private inResetingProcess = false;
    public version: {
        product: number;
        major: string;
        minor: string;
        patch: string;
        build: string;
    };

    constructor() {
        super();
        this.queue = new Queue();
        this.waitress = new Waitress<BLZFrame, BLZWaitressMatcher>(this.waitressValidator, this.waitressTimeoutFormatter);

        this.serialDriver = new SerialDriver();
        this.serialDriver.on('received', this.onFrameReceived.bind(this));
        this.serialDriver.on('close', this.onSerialClose.bind(this));
        this.version = {product: 1, major: '0', minor: '0', patch: '0', build: '0'};
    }

    public async connect(options: SerialPortOptions): Promise<void> {
        let lastError = null;

        const resetForReconnect = (): void => {
            throw new Error('Failure to connect');
        };
        this.serialDriver.on('reset', resetForReconnect);

        for (let i = 1; i <= MAX_SERIAL_CONNECT_ATTEMPTS; i++) {
            try {
                await this.serialDriver.connect(options);
                break;
            } catch (error) {
                logger.error(`Connection attempt ${i} error: ${error}`, NS);

                if (i < MAX_SERIAL_CONNECT_ATTEMPTS) {
                    await Wait(SERIAL_CONNECT_NEW_ATTEMPT_MIN_DELAY * i);
                    logger.debug(`Next attempt ${i + 1}`, NS);
                }

                lastError = error;
            }
        }

        this.serialDriver.off('reset', resetForReconnect);

        if (!this.serialDriver.isInitialized()) {
            throw new Error('Failure to connect', { cause: lastError });
        }

        this.inResetingProcess = false;

        this.serialDriver.on('reset', this.onSerialReset.bind(this));

        if (WATCHDOG_WAKE_PERIOD) {
            this.watchdogTimer = setInterval(this.watchdogHandler.bind(this), WATCHDOG_WAKE_PERIOD * 1000);
        }
    }

    public isInitialized(): boolean {
        return this.serialDriver?.isInitialized();
    }

    private onSerialReset(): void {
        logger.debug('onSerialReset()', NS);
        this.inResetingProcess = true;
        this.emit('reset');
    }

    private onSerialClose(): void {
        logger.debug('onSerialClose()', NS);
        if (!this.inResetingProcess) {
            this.emit('close');
        }
    }

    public async close(emitClose: boolean): Promise<void> {
        logger.debug('Closing Blz', NS);

        clearTimeout(this.watchdogTimer);
        this.queue.clear();
        await this.serialDriver.close(emitClose);
    }

    private onFrameReceived(data: Buffer): void {
        logger.debug(`<== Frame: ${data.toString('hex')}`, NS);

        let frameId: number;
        frameId = data.readUInt16LE(2)
        const sequence = (data[1] & 0x70) >> 4;
        data = data.subarray(4, -2)

        const frm = BLZFrameData.createFrame(frameId, false, data);

        if (!frm) {
            logger.error(`Unparsed frame 0x${frameId.toString(16)}. Skipped`, NS);
            return;
        }

        logger.debug(() => `<== 0x${frameId.toString(16)}: ${JSON.stringify(frm)}`, NS);

        const handled = this.waitress.resolve({
            frameId,
            frameName: frm.name,
            sequence,
            payload: frm,
        });

        if (!handled) {
            this.emit('frame', frm.name, frm);
        }
    }

    public makeZDOframe(name: string | number, params: ParamsDesc): Buffer {
        const frmData = new BLZZDORequestFrameData(name, true, params);
        return frmData.serialize();
    }

    private makeFrame(name: string, params: ParamsDesc | undefined): Buffer {
        const frmData = new BLZFrameData(name, true, params);

        logger.debug(() => `==> ${JSON.stringify(frmData)}`, NS);
        // let seq = 0;
        // const frame = [seq & 255];

        // if (this.blzV < 8) {
        //     if (this.blzV >= 5) {
        //         frame.push(0x00, 0xff, 0x00, frmData.id);
        //     } else {
        //         frame.push(0x00, frmData.id);
        //     }
        // } else {
        //     const cmd_id = t.serialize([frmData.id], [t.uint16_t]);

        //     frame.push(0x00, 0x01, ...cmd_id);
        // }
        // TODO: clean it up
        return frmData.serialize();
    }

    public async execCommand(name: string, params?: ParamsDesc): Promise<BLZFrameData> {
        logger.debug(() => `==> ${name}: ${JSON.stringify(params)}`, NS);

        if (!this.serialDriver.isInitialized()) {
            throw new Error('Connection not initialized');
        }

        return await this.queue.execute<BLZFrameData>(async (): Promise<BLZFrameData> => {
            const data = this.makeFrame(name, params);
            const waiter = this.waitFor(name);
            // this.cmdSeq = (this.cmdSeq + 1) & 255;

            try {
                await this.serialDriver.sendDATA(data, FRAMES[name].ID);

                const response = await waiter.start().promise;

                return response.payload;
            } catch {
                this.waitress.remove(waiter.ID);
                throw new Error(`Failure send ${name}:` + JSON.stringify(data));
            }
        });
    }

    async networkInit(): Promise<boolean> {
        const waiter = this.waitFor('stackStatusHandler');
        const response = await waiter.start().promise;
        const result = await this.execCommand('networkInit');

        if (response.payload.status !== BlzStatus.SUCCESS) {
            logger.error('Wrong network status: ' + JSON.stringify(response.payload), NS);

            throw new Error('Wrong network status: ' + JSON.stringify(response.payload));
        }

        logger.debug(`Network init result: ${JSON.stringify(result)}`, NS);

        if (result.status !== BlzStatus.SUCCESS) {
            this.waitress.remove(waiter.ID);
            logger.error('Failure to init network', NS);
            return false;
        }

        return result.status == BlzStatus.SUCCESS;
    }

    async leaveNetwork(): Promise<number> {
        const waiter = this.waitFor('stackStatusHandler');
        const response = await waiter.start().promise;
        const result = await this.execCommand('leaveNetwork');

        if (response.payload.status !== BlzStatus.SUCCESS) {
            logger.error('Wrong network status: ' + JSON.stringify(response.payload), NS);

            throw new Error('Wrong network status: ' + JSON.stringify(response.payload));
        }

        logger.debug(`Network leave result: ${JSON.stringify(result)}`, NS);

        if (result.status !== BlzStatus.SUCCESS) {
            this.waitress.remove(waiter.ID);
            logger.debug('Failure to leave network', NS);
            throw new Error('Failure to leave network: ' + JSON.stringify(result));
        }

        return response.payload.status;
    }

    async setValue(valueId: t.BlzValueId, value: number): Promise<BLZFrameData> {
        const valueName = t.BlzValueId.valueToName(t.BlzValueId, valueId);
        logger.debug(`Set ${valueName} = ${value}`, NS);
        const ret = await this.execCommand('setValue', {valueId, value});

        if (ret.status !== BlzStatus.SUCCESS) {
            logger.error(`Command (setValue(${valueName}, ${value})) returned unexpected state: ${JSON.stringify(ret)}`, NS);
        }

        return ret;
    }

    async getValue(valueId: t.BlzValueId): Promise<Buffer> {
        const valueName = t.BlzValueId.valueToName(t.BlzValueId, valueId);
        logger.debug(`Get ${valueName}`, NS);
        const ret = await this.execCommand('getValue', {valueId});

        if (ret.status !== BlzStatus.SUCCESS) {
            logger.error(`Command (getValue(${valueName})) returned unexpected state: ${JSON.stringify(ret)}`, NS);
        }

        logger.debug(`Got ${valueName} = ${ret.value}`, NS);
        return ret.value;
    }

    async formNetwork(extPanId: uint64_t, panId: uint16_t, channel: uint8_t): Promise<number> {
        const waiter = this.waitFor('stackStatusHandler');
        const response = await waiter.start().promise;
    
        // Aligning the parameters with the command format
        const commandParams = {
            extPanId: extPanId,
            panId: panId,
            channel: channel,
        };
    
        const v = await this.execCommand('formNetwork', commandParams);
    
        if (response.payload.status !== BlzStatus.SUCCESS) {
            logger.error('Wrong network status: ' + JSON.stringify(response.payload), NS);
            throw new Error('Wrong network status: ' + JSON.stringify(response.payload));
        }
    
        if (v.status !== BlzStatus.SUCCESS) {
            this.waitress.remove(waiter.ID);
            logger.error('Failure forming network: ' + JSON.stringify(v), NS);
            throw new Error('Failure forming network: ' + JSON.stringify(v));
        }
    
        return v.status;
    }
    

    public sendUnicast(direct: BlzOutgoingMessageType, nwk: number, apsFrame: BlzApsFrame, seq: number, data: Buffer): Promise<BLZFrameData> {
        return this.execCommand('sendUnicast', {
            type: direct,
            indexOrDestination: nwk,
            apsFrame: apsFrame,
            messageTag: seq,
            message: data,
        });
    }

    public async setSourceRouting(): Promise<void> {
        const res = await this.execCommand('setConcentrator', {
            on: true,
            concentratorType: BlzConcentratorType.HIGH_RAM_CONCENTRATOR,
            minTime: MTOR_MIN_INTERVAL,
            maxTime: MTOR_MAX_INTERVAL,
            routeErrorThreshold: MTOR_ROUTE_ERROR_THRESHOLD,
            deliveryFailureThreshold: MTOR_DELIVERY_FAIL_THRESHOLD,
            maxHops: 0,
        });

        logger.debug(`Set concentrator type: ${JSON.stringify(res)}`, NS);

        if (res.status != BlzStatus.SUCCESS) {
            logger.error(`Couldn't set concentrator ${JSON.stringify(res)}`, NS);
        }

        await this.execCommand('setSourceRouteDiscoveryMode', {mode: 1});
    }

    public sendBroadcast(destination: number, apsFrame: BlzApsFrame, seq: number, data: Buffer): Promise<BLZFrameData> {
        return this.execCommand('sendBroadcast', {
            destination: destination,
            apsFrame: apsFrame,
            radius: BLZ_DEFAULT_RADIUS,
            messageTag: seq,
            message: data,
        });
    }

    public async getVersion(): Promise<void> {
        // Retrieve version info specific to BLZ
        let verInfo = await this.getValue(BlzValueId.BLZ_VALUE_ID_BLZ_VERSION);
        // Parse version info according to BLZ's format
        // Update parsing logic if necessary
        let build, major, minor, patch;
        [build, verInfo] = uint16_t.deserialize(uint16_t, verInfo);
        [major, verInfo] = uint8_t.deserialize(uint8_t, verInfo);
        [minor, verInfo] = uint8_t.deserialize(uint8_t, verInfo);
        [patch, verInfo] = uint8_t.deserialize(uint8_t, verInfo);
        const vers = `${major}.${minor}.${patch}.${build}`;
        logger.debug(`BLZ version: ${vers}`, NS);
        this.version = {
            product: 1,
            major: `${major}`,
            minor: `${minor}`,
            patch: `${patch} `,
            build: `${build}`,
        };
    }

    public async sendApsData(
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
        payload: Bytes
    ): Promise<BlzStatus> {
        // Construct the request payload inline and send the command
        const frameResponse = await this.execCommand('sendApsData', {
            msgType,
            dstShortAddr,
            profileId,
            clusterId,
            srcEp,
            dstEp,
            txOptions,
            radius,
            messageTag,
            payloadLen,
            payload,
        });
    
        // Extract and validate the status from the response
        const { status } = frameResponse;
    
        if (status !== BlzStatus.SUCCESS) {
            logger.error(`sendApsData() failed with status: ${status}`, NS);
            throw new Error(`Failed to send APS data: status ${status}`);
        }
    
        logger.debug(
            `sendApsData() succeeded: msgType=${msgType}, dstShortAddr=${dstShortAddr}, clusterId=${clusterId}, payloadLen=${payloadLen}`,
            NS
        );
    
        return status; // Return the status of the operation
    }
    

    public waitFor(
        frameId: string | number,
        timeout = 10000,
    ): {start: () => {promise: Promise<BLZFrame>; ID: number}; ID: number} {
        return this.waitress.waitFor({frameId}, timeout);
    }

    private waitressTimeoutFormatter(matcher: BLZWaitressMatcher, timeout: number): string {
        return `${JSON.stringify(matcher)} after ${timeout}ms`;
    }

    private waitressValidator(payload: BLZFrame, matcher: BLZWaitressMatcher): boolean {
        const frameNames = typeof matcher.frameId == 'string' ? [matcher.frameId] : FRAME_NAMES_BY_ID[matcher.frameId];
        return frameNames.includes(payload.frameName);
    }

    private async watchdogHandler(): Promise<void> {
        logger.debug(`Time to watchdog ... ${this.failures}`, NS);

        if (this.inResetingProcess) {
            logger.debug('The reset process is in progress...', NS);
            return;
        }

        try {
            await this.execCommand('nop');
        } catch (error) {
            logger.error(`Watchdog heartbeat timeout ${error}`, NS);

            if (!this.inResetingProcess) {
                this.failures += 1;

                if (this.failures > MAX_WATCHDOG_FAILURES) {
                    this.failures = 0;

                    this.emit('reset');
                }
            }
        }
    }
}
