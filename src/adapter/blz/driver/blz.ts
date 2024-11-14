/* istanbul ignore file */

import { EventEmitter } from 'events';

import { Queue, Wait, Waitress } from '../../../utils';
import { logger } from '../../../utils/logger';
import { SerialPortOptions } from '../../tstype';
import { FRAMES, FRAME_NAMES_BY_ID, BLZFrameDesc } from './commands';
import * as t from './types';
import { 
    BlzStatus, 
    BlzConfigId, 
    BlzPolicyId, 
    BlzDecisionId, 
    BlzValueId 
} from './types/named';
import { SerialDriver } from './uart';

const NS = 'zh:blz:driver';

const MAX_SERIAL_CONNECT_ATTEMPTS = 3;
const SERIAL_CONNECT_NEW_ATTEMPT_MIN_DELAY = 5000; // in ms

type BlzFrame = {
    sequence: number;
    frameId: number;
    frameName: string;
    payload: BlzFrameData;
};

type BlzWaitressMatcher = {
    sequence: number | null;
    frameId: number | string;
};

export class BlzFrameData {
    _cls_: string;
    _id_: number;
    _isRequest_: boolean;
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    [name: string]: any;

    static createFrame(blzv: number, frameId: number, isRequest: boolean, params: t.ParamsDesc | Buffer): BlzFrameData {
        const names = FRAME_NAMES_BY_ID[frameId];
        if (!names) {
            throw new Error(`Unrecognized frame FrameID ${frameId}`);
        }

        let frame: BlzFrameData | undefined;

        names.every((frameName) => {
            const frameDesc = BlzFrameData.getFrame(frameName);
            if ((frameDesc.maxV && frameDesc.maxV < blzv) || (frameDesc.minV && frameDesc.minV > blzv)) {
                return true;
            }
            try {
                frame = new BlzFrameData(frameName, isRequest, params);
            } catch (error) {
                logger.error(`Frame ${frameName} parsing error: ${error}`, NS);
                return true;
            }
            return false;
        });

        return frame!;
    }

    static getFrame(name: string): BLZFrameDesc {
        const frameDesc = FRAMES[name];
        if (!frameDesc) throw new Error(`Unrecognized frame ${name}`);
        return frameDesc;
    }

    constructor(key: string, isRequest: boolean, params: t.ParamsDesc | Buffer | undefined) {
        this._cls_ = key;
        this._id_ = FRAMES[this._cls_].ID;
        this._isRequest_ = isRequest;

        const frame = BlzFrameData.getFrame(key);
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
        const frame = BlzFrameData.getFrame(this._cls_);
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

export class blz extends EventEmitter {
    private serialDriver: SerialDriver;
    private waitress: Waitress<BlzFrame, BlzWaitressMatcher>;
    private queue: Queue;
    private cmdSeq = 0; // Command sequence

    constructor() {
        super();
        this.queue = new Queue();
        this.waitress = new Waitress<BlzFrame, BlzWaitressMatcher>(this.waitressValidator, this.waitressTimeoutFormatter);

        this.serialDriver = new SerialDriver();
        this.serialDriver.on('received', this.onFrameReceived.bind(this));
        this.serialDriver.on('close', this.onSerialClose.bind(this));
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
                }

                lastError = error;
            }
        }

        this.serialDriver.off('reset', resetForReconnect);

        if (!this.serialDriver.isInitialized()) {
            throw new Error('Failure to connect', { cause: lastError });
        }

        logger.info('blz connected successfully', NS);
    }

    private onSerialReset(): void {
        logger.debug('onSerialReset()', NS);
        this.emit('reset');
    }

    private onSerialClose(): void {
        logger.debug('onSerialClose()', NS);
            this.emit('close');
    }
    

    public async close(emitClose: boolean): Promise<void> {
        logger.debug('Closing blz', NS);
        this.queue.clear();
        await this.serialDriver.close(emitClose);
    }

    public async sendCommand(name: string, params: t.ParamsDesc): Promise<BlzFrameData> {
        logger.debug(`==> ${name}: ${JSON.stringify(params)}`, NS);

        return this.queue.execute<BlzFrameData>(async () => {
            const data = this.makeFrame(name, params, this.cmdSeq);
            const waiter = this.waitFor(name, this.cmdSeq);
            this.cmdSeq = (this.cmdSeq + 1) & 255;

            try {
                await this.serialDriver.sendDATA(data);
                const response = await waiter.start().promise;

                return response.payload;
            } catch (error) {
                this.waitress.remove(waiter.ID);
                throw new Error(`Failed to send ${name}: ${error}`);
            }
        });
    }

    public async networkInit(): Promise<boolean> {
        const waiter = this.waitFor('stackStatusHandler', null);
        const result = await this.sendCommand('networkInit', {});

        if (result.status !== BlzStatus.SUCCESS) {
            this.waitress.remove(waiter.ID);
            logger.error('Failure to initialize network', NS);
            return false;
        }

        const response = await waiter.start().promise;
        return response.payload.status === BlzStatus.NETWORK_UP;
    }

    public async leaveNetwork(): Promise<void> {
        const waiter = this.waitFor('stackStatusHandler', null);
        const result = await this.sendCommand('leaveNetwork', {});

        if (result.status !== BlzStatus.SUCCESS) {
            this.waitress.remove(waiter.ID);
            logger.error('Failure to leave network', NS);
            throw new Error('Failed to leave network');
        }

        const response = await waiter.start().promise;

        if (response.payload.status !== BlzStatus.SUCCESS) {
            const msg = `Unexpected network status: ${JSON.stringify(response.payload)}`;
            logger.error(msg, NS);
            throw new Error(msg);
        }
    }

    public async setConfigurationValue(configId: number, value: number): Promise<void> {
        const ret = await this.sendCommand('setConfigurationValue', { configId, value });

        if (ret.status !== BlzStatus.SUCCESS) {
            logger.error(`Failed to set configuration value: ${configId}=${value}`, NS);
        }
    }

    public async getConfigurationValue(configId: number): Promise<number> {
        const ret = await this.sendCommand('getConfigurationValue', { configId });

        if (ret.status !== BlzStatus.SUCCESS) {
            logger.error(`Failed to get configuration value for ${configId}`, NS);
            throw new Error(`Failed to get configuration value for ${configId}`);
        }

        return ret.value;
    }

    private makeFrame(name: string, params: t.ParamsDesc | undefined, seq: number): Buffer {
        const frameData = new BlzFrameData(name, true, params);
        logger.debug(() => `==> ${JSON.stringify(frameData)}`, NS);

        const frame = [seq & 0xff];
        const cmdId = t.serialize([frameData.id], [t.uint16_t]);
        frame.push(0x00, ...cmdId);

        return Buffer.concat([Buffer.from(frame), frameData.serialize()]);
    }

    private onFrameReceived(data: Buffer): void {
        logger.debug(`<== Frame: ${data.toString('hex')}`, NS);

        const sequence = data[0];
        const [[frameId], payload] = t.deserialize(data.subarray(1), [t.uint16_t]);
        const frame = BlzFrameData.createFrame(4, frameId, false, payload);

        const handled = this.waitress.resolve({
            frameId,
            frameName: frame.name,
            sequence,
            payload: frame,
        });

        if (!handled) {
            this.emit('frame', frame.name, frame);
        }
    }

    private waitressValidator(payload: BlzFrame, matcher: BlzWaitressMatcher): boolean {
        const frameNames = typeof matcher.frameId === 'string' ? [matcher.frameId] : FRAME_NAMES_BY_ID[matcher.frameId];
        return (matcher.sequence == null || payload.sequence === matcher.sequence) && frameNames.includes(payload.frameName);
    }

    private waitressTimeoutFormatter(matcher: BlzWaitressMatcher, timeout: number): string {
        return `${JSON.stringify(matcher)} after ${timeout}ms`;
    }

    public waitFor(
        frameId: string | number,
        sequence: number | null,
        timeout = 10000,
    ): { start: () => { promise: Promise<BlzFrame>; ID: number }; ID: number } {
        return this.waitress.waitFor({ frameId, sequence }, timeout);
    }
}


