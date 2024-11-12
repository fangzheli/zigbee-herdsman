/* istanbul ignore file */

import assert from 'assert';
import {EventEmitter} from 'events';
import net from 'net';

import {DelimiterParser} from '@serialport/parser-delimiter';

import {Queue} from '../../../utils';
import {logger} from '../../../utils/logger';
import Waitress from '../../../utils/waitress';
import * as ZSpec from '../../../zspec';
import * as Zdo from '../../../zspec/zdo';
import {EndDeviceAnnounce, GenericZdoResponse, ResponseMap as ZdoResponseMap} from '../../../zspec/zdo/definition/tstypes';
import {SerialPort} from '../../serialPort';
import SerialPortUtils from '../../serialPortUtils';
import SocketPortUtils from '../../socketPortUtils';
import {SerialPortOptions} from '../../tstype';
// import {equal, BlzResponseMatcher, BlzResponseMatcherRule} from './commandType';
// import {STATUS, ZDO_REQ_CLUSTER_ID_TO_ZIGATE_COMMAND_ID, BlzCommandCode, BlzMessageCode, BlzObjectPayload} from './constants';
import { ADDRESS_MODE, BlzCommandCode, BlzMessageCode } from '../driver/constants';
import BlzFrame from '../driver/frame';
import BlzObject from '../driver/blzObject';
import {equal, BlzResponseMatcher, BlzResponseMatcherRule} from './commandType';



const NS = 'zh:blz:driver';

const timeouts = {
    reset: 30000,
    default: 10000,
};

type WaitressMatcher = {
    blzObject: BlzObject;
    rules: BlzResponseMatcher;
    extraParameters?: object;
};


// const autoDetectDefinitions = [
//     {manufacturer: 'blz_PL2303', vendorId: '067b', productId: '2303'},
//     {manufacturer: 'blz_cp2102', vendorId: '10c4', productId: 'ea60'},
// ];


type ZdoWaitressPayload = {
    BlzPayload: {
        status: number;
        profileID: number;
        clusterID: number;
        sourceEndpoint: number;
        destinationEndpoint: number;
        sourceAddressMode: number;
        sourceAddress: number | string;
        destinationAddressMode: number;
        destinationAddress: number | string;
        payload: Buffer;
    };
    zdo: GenericZdoResponse;
};

type ZdoWaitressMatcher = {
    clusterId: number;
    target?: number | string;
};

function zeroPad(number: number, size?: number): string {
    return number.toString(16).padStart(size || 4, '0');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolve(path: string | [], obj: {[k: string]: any}, separator = '.'): any {
    const properties = Array.isArray(path) ? path : path.split(separator);
    return properties.reduce((prev, curr) => prev && prev[curr], obj);
}

interface BlzEventMap {
    close: [];
    zdoResponse: [Zdo.ClusterId, GenericZdoResponse];
    received: [BlzObject];
    LeaveIndication: [BlzObject];
    DeviceAnnounce: [EndDeviceAnnounce];
}

export default class BlzAdapter extends EventEmitter<BlzEventMap> {
    private path: string;
    private baudRate: number;
    private initialized: boolean;

    private parser?: EventEmitter;
    private serialPort?: SerialPort;
    private socketPort?: net.Socket;
    private queue: Queue;
    public portWrite?: SerialPort | net.Socket;
    private waitress: Waitress<BlzObject, WaitressMatcher>;

    public constructor(path: string, serialPortOptions: SerialPortOptions) {
        super();
        this.path = path;
        this.baudRate = serialPortOptions.baudRate || 2000000;
        this.initialized = false;
        this.queue = new Queue(1);

        this.waitress = new Waitress<BlzObject, WaitressMatcher>(this.waitressValidator, this.waitressTimeoutFormatter);
    }

    public async sendCommand(
        code: BlzCommandCode,
        payload?: BlzObject,
        timeout?: number,
        extraParameters?: object,
        disableResponse = false,
    ): Promise<BlzObject> {
        return await this.queue.execute(async () => {
            try {
                logger.debug(
                    () =>
                        'Send command \x1b[32m>>>> ' +
                        BlzCommandCode[code] +
                        ' 0x' +
                        code.toString(16) +
                        ` <<<<\x1b[0m \nPayload: ${JSON.stringify(payload)}`,
                    NS,
                );

                const blzObject = BlzObject.createRequest(code, payload || {});
                const frame = blzObject.toBlzFrame();
                logger.debug(() => `Frame: ${JSON.stringify(frame)}`, NS);

                await this.portWrite?.write(frame.toBuffer());

                if (disableResponse) {
                    return blzObject;
                }

                const matcher = {
                    blzObject,
                    rules: [{ receivedProperty: 'code', matcher: equal, value: code }],
                    extraParameters,
                };

                return this.waitress.waitFor(matcher, timeout || timeouts.default);
            } catch (error) {
                logger.error(`Error sending command ${code}: ${error.message}`, NS);
                throw error;
            }
        });
    }

    public async requestZdo(clusterId: Zdo.ClusterId, payload: Buffer): Promise<boolean> {
        return await this.queue.execute(async () => {
            const commandCode = ZDO_REQ_CLUSTER_ID_TO_BLZ_COMMAND_ID[clusterId];
            assert(commandCode !== undefined, `ZDO cluster ID '${clusterId}' not supported.`);
            const ruleStatus: BlzResponseMatcher = [
                {receivedProperty: 'code', matcher: equal, value: BlzMessageCode.Status},
                {receivedProperty: 'payload.packetType', matcher: equal, value: commandCode},
            ];

            logger.debug(() => `ZDO ${Zdo.ClusterId[clusterId]}(cmd code: ${commandCode}) ${payload.toString('hex')}`, NS);

            const frame = new BlzFrame();
            frame.writeMsgCode(commandCode);
            frame.writeMsgPayload(payload);

            logger.debug(() => `ZDO ${JSON.stringify(frame)}`, NS);

            const sendBuffer = frame.toBuffer();

            logger.debug(`<-- ZDO send command ${sendBuffer.toString('hex')}`, NS);

            const statusWaiter = this.waitress.waitFor({rules: ruleStatus}, timeouts.default);

            // @ts-expect-error assumed proper based on port type
            this.portWrite!.write(sendBuffer);

            const statusResponse: BlzObject = await statusWaiter.start().promise;

            return statusResponse.payload.status === STATUS.E_SL_MSG_STATUS_SUCCESS;
        });
    }

    public static async isValidPath(path: string): Promise<boolean> {
        return await SerialPortUtils.is(path, autoDetectDefinitions);
    }

    public static async autoDetectPath(): Promise<string | undefined> {
        const paths = await SerialPortUtils.find(autoDetectDefinitions);
        return paths.length > 0 ? paths[0] : undefined;
    }

    public open(): Promise<void> {
        return SocketPortUtils.isTcpPath(this.path) ? this.openSocketPort() : this.openSerialPort();
    }

    public async close(): Promise<void> {
        logger.info('closing', NS);
        this.queue.clear();

        if (this.initialized) {
            this.portWrite = undefined;
            this.initialized = false;

            if (this.serialPort) {
                try {
                    await this.serialPort.asyncFlushAndClose();
                } catch (error) {
                    this.emit('close');

                    throw error;
                }
            } else {
                this.socketPort?.destroy();
            }
        }

        this.emit('close');
    }

    private async openSerialPort(): Promise<void> {
        this.serialPort = new SerialPort({
            path: this.path,
            baudRate: this.baudRate,
            dataBits: 8,
            parity: 'none' /* one of ['none', 'even', 'mark', 'odd', 'space'] */,
            stopBits: 1 /* one of [1,2] */,
            lock: false,
            autoOpen: false,
        });
        this.parser = this.serialPort.pipe(new DelimiterParser({delimiter: [BlzFrame.STOP_BYTE], includeDelimiter: true}));
        this.parser.on('data', this.onSerialData.bind(this));

        this.portWrite = this.serialPort;

        try {
            await this.serialPort.asyncOpen();
            logger.debug('Serialport opened', NS);

            this.serialPort.once('close', this.onPortClose.bind(this));
            this.serialPort.once('error', this.onPortError.bind(this));

            this.initialized = true;
        } catch (error) {
            this.initialized = false;

            if (this.serialPort.isOpen) {
                this.serialPort.close();
            }

            throw error;
        }
    }

    private async openSocketPort(): Promise<void> {
        const info = SocketPortUtils.parseTcpPath(this.path);
        logger.debug(`Opening TCP socket with ${info.host}:${info.port}`, NS);

        this.socketPort = new net.Socket();
        this.socketPort.setNoDelay(true);
        this.socketPort.setKeepAlive(true, 15000);

        this.parser = this.socketPort.pipe(new DelimiterParser({delimiter: [BlzFrame.STOP_BYTE], includeDelimiter: true}));
        this.parser.on('data', this.onSerialData.bind(this));

        this.portWrite = this.socketPort;
        return await new Promise((resolve, reject): void => {
            this.socketPort!.on('connect', () => {
                logger.debug('Socket connected', NS);
            });

            this.socketPort!.on('ready', async () => {
                logger.debug('Socket ready', NS);
                this.initialized = true;
                resolve();
            });

            this.socketPort!.once('close', this.onPortClose.bind(this));

            this.socketPort!.on('error', (error) => {
                logger.error(`Socket error ${error}`, NS);
                // reject(new Error(`Error while opening socket`));
                reject();
                this.initialized = false;
            });

            this.socketPort!.connect(info.port, info.host);
        });
    }

    private onPortError(error: Error): void {
        logger.error(`Port error: ${error}`, NS);
    }

    private onPortClose(): void {
        logger.debug('Port closed', NS);
        this.initialized = false;
        this.emit('close');
    }

    private onSerialData(buffer: Buffer): void {
        try {
            // logger.debug(() => `--- parseNext ${JSON.stringify(buffer)}`, NS);

            const frame = new BlzFrame(buffer);
            if (!(frame instanceof BlzFrame)) return;

            const code = frame.readMsgCode();
            const msgName = (BlzMessageCode[code] ? BlzMessageCode[code] : '') + ' 0x' + zeroPad(code);

            logger.debug(`--> parsed frame \x1b[1;34m>>>> ${msgName} <<<<\x1b[0m `, NS);

            try {
                const blzObject = BlzObject.fromBlzFrame(frame);
                logger.debug(() => `${JSON.stringify(blzObject.payload)}`, NS);
                //TODO
                if (code === BlzMessageCode.ApsDataIndication && blzObject.payload.profileID === Zdo.ZDO_PROFILE_ID) {
                    const BlzPayload: ZdoWaitressPayload['BlzPayload'] = blzObject.payload;
                    // requests don't have tsn, but responses do
                    // https://blz.fr/documentation/commandes-blz/
                    const zdo = Zdo.Buffalo.readResponse(true, BlzPayload.clusterID, BlzPayload.payload);

                    this.zdoWaitress.resolve({BlzPayload, zdo});
                    this.emit('zdoResponse', BlzPayload.clusterID, zdo);
                } else if (code === BlzMessageCode.LeaveIndication && blzObject.payload.rejoin === 0) {
                    // mock a ZDO response (if waiter present) as blz does not follow spec on this (missing ZDO LEAVE_RESPONSE)
                    const BlzPayload: ZdoWaitressPayload['BlzPayload'] = {
                        status: 0,
                        profileID: Zdo.ZDO_PROFILE_ID,
                        clusterID: Zdo.ClusterId.LEAVE_RESPONSE, // only piece actually required for waitress validation
                        sourceEndpoint: Zdo.ZDO_ENDPOINT,
                        destinationEndpoint: Zdo.ZDO_ENDPOINT,
                        sourceAddressMode: 0x03,
                        sourceAddress: blzObject.payload.extendedAddress,
                        destinationAddressMode: 0x03,
                        destinationAddress: ZSpec.BLANK_EUI64,
                        // @ts-expect-error not used
                        payload: undefined,
                    };

                    // Workaround: `zdo` is not valid for LEAVE_RESPONSE, but required to pass altered waitress validation (in sendZdo)
                    if (this.zdoWaitress.resolve({BlzPayload, zdo: [Zdo.Status.SUCCESS, {eui64: blzObject.payload.extendedAddress}]})) {
                        this.emit('zdoResponse', Zdo.ClusterId.LEAVE_RESPONSE, [
                            Zdo.Status.SUCCESS,
                            undefined,
                        ] as ZdoResponseMap[Zdo.ClusterId.LEAVE_RESPONSE]);
                    }

                    this.emit('LeaveIndication', blzObject);
                } else {
                    this.waitress.resolve(blzObject);

                    if (code === BlzMessageCode.DataIndication) {
                        if (blzObject.payload.profileID === ZSpec.HA_PROFILE_ID) {
                            this.emit('received', blzObject);
                        } else {
                            logger.debug('not implemented profile: ' + blzObject.payload.profileID, NS);
                        }
                    } else if (code === BlzMessageCode.DeviceAnnounce) {
                        this.emit('DeviceAnnounce', {
                            nwkAddress: blzObject.payload.shortAddress,
                            eui64: blzObject.payload.ieee,
                            capabilities: blzObject.payload.MACcapability,
                        });
                    }
                }
            } catch (error) {
                logger.error(`Parsing error: ${error}`, NS);
            }
        } catch (error) {
            logger.error(`Error while parsing Frame '${error}'`, NS);
        }
    }

    private waitressTimeoutFormatter(matcher: WaitressMatcher | ZdoWaitressMatcher, timeout: number): string {
        return `${JSON.stringify(matcher)} after ${timeout}ms`;
    }

    private waitressValidator(BlzObject: BlzObject, matcher: WaitressMatcher): boolean {
        const validator = (rule: BlzResponseMatcherRule): boolean => {
            try {
                let expectedValue: string | number;
                if (rule.value == undefined && rule.expectedProperty != undefined) {
                    assert(matcher.BlzObject, `Matcher BlzObject expected valid.`);
                    expectedValue = resolve(rule.expectedProperty, matcher.BlzObject);
                } else if (rule.value == undefined && rule.expectedExtraParameter != undefined) {
                    expectedValue = resolve(rule.expectedExtraParameter, matcher.extraParameters!); // XXX: assumed valid?
                } else {
                    expectedValue = rule.value!; // XXX: assumed valid?
                }
                const receivedValue = resolve(rule.receivedProperty, BlzObject);
                return rule.matcher(expectedValue, receivedValue);
            } catch {
                return false;
            }
        };
        return matcher.rules.every(validator);
    }
    public async reset(type: 'soft' | 'hard'): Promise<void> {
        if (type === 'soft') {
            await this.sendCommand(BlzCommandCode.Reset, {}, 5000);
        }
        // More commands can be added for other types if needed.
    }

    public async getNetworkParameters(): Promise<ZSpec.NetworkParameters> {
        const result = await this.sendCommand(BlzCommandCode.GetNetworkState, {}, 10000);
        return {
            panID: result.payload.PANID,
            extendedPanID: result.payload.extendedPanID,
            channel: result.payload.channel,
        };
    }

    public async permitJoin(seconds: number, networkAddress?: number): Promise<void> {
        const clusterId = Zdo.ClusterId.PERMIT_JOINING_REQUEST;

        if (networkAddress !== undefined) {
            const zdoPayload = Zdo.Buffalo.buildRequest(false, clusterId, seconds, 1, []);
            await this.sendCommand(BlzCommandCode.PermitJoining, { payload: zdoPayload }, 10000);
        }
    }


    public zdoWaitFor(matcher: ZdoWaitressMatcher): ReturnType<typeof this.zdoWaitress.waitFor> {
        return this.zdoWaitress.waitFor(matcher, timeouts.default);
    }

    private zdoWaitressValidator(payload: ZdoWaitressPayload, matcher: ZdoWaitressMatcher): boolean {
        return (
            (matcher.target === undefined ||
                (typeof matcher.target === 'number'
                    ? matcher.target === payload.BlzPayload.sourceAddress
                    : // @ts-expect-error checked with ?
                      matcher.target === payload.zdo?.[1]?.eui64)) &&
            payload.BlzPayload.clusterID === matcher.clusterId
        );
    }
}
