/* istanbul ignore file */

import { EventEmitter } from 'events';

import equals from 'fast-deep-equal/es6';

import { Wait, Waitress } from '../../../utils';
import { logger } from '../../../utils/logger';
import * as ZSpec from '../../../zspec';
import { Clusters } from '../../../zspec/zcl/definition/cluster';
import * as Zdo from '../../../zspec/zdo';
import { GenericZdoResponse } from '../../../zspec/zdo/definition/tstypes';
import { BLZAdapterBackup } from '../adapter/backup';
import * as TsType from './../../tstype';
import { ParamsDesc } from './commands';
import { Blz, BlzFrameData } from './blz';
import { Multicast } from './multicast';
import { 
    BlzStatus, 
    BlzValueId, 
    BlzPolicyId, 
    BlzDecisionId, 
    uint8_t, 
    uint16_t 
} from './types';
import { BlzNetworkParameters } from './types/struct';

const NS = 'zh:blz:driver';

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
    frame: any;
    zdoResponse?: GenericZdoResponse;
};

type BlzWaitressMatcher = {
    address: number | string;
    clusterId: number;
    sequence: number;
};

export class Driver extends EventEmitter {
    public Blz!: Blz;
    private nwkOpt: TsType.NetworkOptions;
    public networkParams!: BlzNetworkParameters;
    public version!: {
        product: number;
        majorrel: string;
        minorrel: string;
        maintrel: string;
        revision: string;
    };
    private eui64ToNodeId = new Map<string, number>();
    private multicast!: Multicast;
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

    public async reset(): Promise<void> {
        logger.debug(`Resetting connection.`, NS);

        try {
            await this.stop(false);
        } catch (err) {
            logger.debug(`Stop error ${err}`, NS);
        }
        try {
            await Wait(1000);
            logger.debug(`Restarting connection.`, NS);
            await this.startup();
        } catch (err) {
            logger.debug(`Reset error ${err}`, NS);

            try {
                await this.stop();
            } catch (stopErr) {
                logger.debug(`Failed to stop after reset failure ${stopErr}`, NS);
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

        if (this.Blz) {
            return await this.Blz.close(emitClose);
        }
    }

    public async startup(): Promise<TsType.StartResult> {
        let result: TsType.StartResult = 'resumed';
        this.transactionID = 1;

        this.Blz = new Blz();
        this.Blz.on('close', this.onBlzClose.bind(this));

        try {
            await this.Blz.connect(this.serialOpt);
        } catch (error) {
            logger.debug(`Blz could not connect: ${error}`, NS);
            throw error;
        }

        this.Blz.on('reset', this.onBlzReset.bind(this));

        await this.Blz.version();
        await this.Blz.setValue(BlzValueId.VALUE_END_DEVICE_KEEP_ALIVE_SUPPORT_MODE, 3);
        await this.Blz.setSourceRouting();

        await this.addEndpoint({
            inputClusters: [0x0000, 0x0003, 0x0006, 0x000a, 0x0019, 0x0300],
            outputClusters: [0x0000, 0x0003, 0x0004, 0x0005, 0x0006],
        });

        const verInfo = await this.Blz.getValue(BlzValueId.VALUE_VERSION_INFO);
        // #TODO:REPLACEMENT - Verify parsing of version info if BLZ has unique structure

        const state = (await this.Blz.execCommand('getNetworkState')).status;
        logger.debug(`Network state: ${state}`, NS);

        const netParams = await this.Blz.execCommand('getNetworkParameters');
        if (netParams.status != BlzStatus.SUCCESS) {
            logger.error(`Command (getNetworkParameters) returned unexpected state: ${netParams.status}`, NS);
        }
        this.networkParams = netParams.parameters;

        // Initialize multicast
        this.multicast = new Multicast(this);
        await this.multicast.startup([]);

        return result;
    }

    public async networkInit(): Promise<void> {
        const initResult = await this.Blz.networkInit();
        if (!initResult) {
            throw new Error('Failed to initialize the network.');
        }
    }

    public async leaveNetwork(): Promise<void> {
        const result = await this.Blz.leaveNetwork();
        if (result !== BlzStatus.SUCCESS) {
            throw new Error('Failed to leave network');
        }
    }

    public async permitJoining(seconds: number): Promise<void> {
        const result = await this.Blz.execCommand('permitJoining', { duration: seconds });
        if (result.status !== BlzStatus.SUCCESS) {
            throw new Error('Failed to permit joining');
        }
    }

    public async addEndpoint(params: AddEndpointParameters): Promise<void> {
        const result = await this.Blz.execCommand('addEndpoint', {
            endpoint: params.endpoint || 1,
            profileId: params.profileId || 260,
            deviceId: params.deviceId || 0xbeef,
            appFlags: params.appFlags || 0,
            inputClusterCount: (params.inputClusters || []).length,
            outputClusterCount: (params.outputClusters || []).length,
            inputClusterList: params.inputClusters || [],
            outputClusterList: params.outputClusters || [],
        });

        if (result.status !== BlzStatus.SUCCESS) {
            throw new Error('Failed to add endpoint');
        }
    }

    public handleFrame(frameName: string, frame: BlzFrameData): void {
        switch (frameName) {
            case 'incomingMessageHandler':
                this.emit('incomingMessage', frame);
                break;

            case 'stackStatusHandler':
                logger.debug(`stackStatusHandler: ${frame.status}`, NS);
                break;

            case 'apsDataIndication': 
                logger.debug(`apsDataIndication received: ${JSON.stringify(frame)}`, NS);
                // #TODO:REPLACEMENT - Handle APS data indications if required
                break;

            case 'apsDataConfirm': 
                logger.debug(`apsDataConfirm received: ${JSON.stringify(frame)}`, NS);
                // #TODO:REPLACEMENT - Handle APS data confirmations if required
                break;

            default:
                logger.debug(`Unhandled frame: ${frameName}`, NS);
                break;
        }
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
}
