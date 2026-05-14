/* istanbul ignore file */

import * as stream from 'stream';
import { logger } from '../../../utils/logger';
import * as consts from './consts';
import { buildFrameBuffer, wrapFrameBuffer } from './framing';

const NS = 'zh:blz:uart';

export class Writer extends stream.Readable {
    public writeBuffer(buffer: Buffer): void {
        logger.debug(() => `--> [${buffer.toString('hex')}]`, NS);
        this.push(buffer);
    }

    public _read(): void {}

    public sendACK(ackSeq: number): void {
        const control = 0x80; // ACK control byte
        const frame = this.makeFrame(control, 0, ackSeq, 0x0001);
        this.writeBuffer(frame);
    }

    public sendData(
        data: Buffer,
        seq: number,
        ackSeq: number,
        frameId: number,
        isRetransmission: boolean = false,
        isDebug: boolean = false
    ): void {
        const control = this.makeControlByte(isDebug, isRetransmission);
        const frame = this.makeFrame(control, seq, ackSeq, frameId, data);
        this.writeBuffer(frame);
    }

    public sendReset(seq: number, 
        ackSeq: number, 
        isRetransmission: boolean = false,
        isDebug: boolean = false
    ): void {
        const control = this.makeControlByte(isDebug, isRetransmission);
        const frame = this.makeFrame(control, seq, ackSeq, 0x0003); // RESET frameId
        logger.debug(() => `--> RESET frame: ${frame.toString('hex')}`, NS);
        this.writeBuffer(frame);
    }

    private makeFrame(
        control: number,
        seq: number,
        ackSeq: number,
        frameId: number,
        data?: Buffer
    ): Buffer {
        const sequence = (ackSeq & 0x07) << 4 | (seq & 0x07);
        return wrapFrameBuffer(buildFrameBuffer(control, sequence, frameId, data));
    }

    private makeControlByte(isDebug: boolean=false, isRetransmission: boolean): number {
        return ((isDebug ? consts.DEBUG : 0x00) | (isRetransmission ? consts.RETX : 0x00));
    }
}
