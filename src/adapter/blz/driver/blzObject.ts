import { logger } from '../../../utils/logger';
import BuffaloBlz, { BuffaloBlzOptions } from './buffaloBlz';
import { BlzCommand, BlzCommandParameter, BlzCommandType } from './commandType';
import { BlzCommandCode, BlzMessageCode, BlzObjectPayload } from './constants';
import BlzFrame from './frame';
import { BlzMessage, BlzMessageParameter } from './messageType';
import ParameterType from './parameterType';

type BlzCode = BlzCommandCode | BlzMessageCode;
type BlzParameter = BlzCommandParameter | BlzMessageParameter;

const NS = 'zh:blz:object';

const BufferAndListTypes: ParameterType[] = [
    ParameterType.BUFFER,
    ParameterType.BUFFER8,
    ParameterType.BUFFER16,
    ParameterType.BUFFER32,
    ParameterType.LIST_UINT16,
    ParameterType.LIST_UINT8,
];

class BlzObject {
    private readonly _code: BlzCode;
    private readonly _payload: BlzObjectPayload;
    private readonly _parameters: BlzParameter[];
    private readonly _frame?: BlzFrame;

    private constructor(code: BlzCode, payload: BlzObjectPayload, parameters: BlzParameter[], frame?: BlzFrame) {
        this._code = code;
        this._payload = payload;
        this._parameters = parameters;
        this._frame = frame;
    }

    get code(): BlzCode {
        return this._code;
    }

    get frame(): BlzFrame | undefined {
        return this._frame;
    }

    get payload(): BlzObjectPayload {
        return this._payload;
    }

    get command(): BlzCommandType {
        return BlzCommand[this._code];
    }

    public static createRequest(commandCode: BlzCommandCode, payload: BlzObjectPayload): BlzObject {
        const cmd = BlzCommand[commandCode];

        if (!cmd) {
            throw new Error(`Command '${commandCode}' not found`);
        }

        return new BlzObject(commandCode, payload, cmd.request);
    }

    public static fromBlzFrame(frame: BlzFrame): BlzObject {
        const code = frame.readMsgCode();
        return BlzObject.fromBuffer(code, frame.msgPayloadBytes, frame);
    }

    public static fromBuffer(code: number, buffer: Buffer, frame: BlzFrame): BlzObject {
        const msg = BlzMessage[code];

        if (!msg) {
            throw new Error(`Message '${code.toString(16)}' not found`);
        }

        const parameters = msg.response;
        if (parameters === undefined) {
            throw new Error(`Message '${code.toString(16)}' cannot be a response`);
        }

        const payload = this.readParameters(buffer, parameters);

        return new BlzObject(code, payload, parameters, frame);
    }

    private static readParameters(buffer: Buffer, parameters: BlzParameter[]): BlzObjectPayload {
        const buffalo = new BuffaloBlz(buffer);
        const result: BlzObjectPayload = {};

        for (const parameter of parameters) {
            const options: BuffaloBlzOptions = {};

            if (BufferAndListTypes.includes(parameter.parameterType)) {
                const lengthParameter = parameters[parameters.indexOf(parameter) - 1];
                const length = result[lengthParameter.name];

                if (typeof length === 'number') {
                    options.length = length;
                }
            }

            try {
                result[parameter.name] = buffalo.read(parameter.parameterType, options);
            } catch (error) {
                logger.error((error as Error).stack!, NS);
            }
        }

        if (buffalo.isMore()) {
            const bufferString = buffalo.getBuffer().toString('hex');
            logger.debug(
                `Last bytes of data were not parsed \x1b[32m${bufferString.slice(0, buffalo.getPosition() * 2).replace(/../g, '$& ')}` +
                    `\x1b[31m${bufferString.slice(buffalo.getPosition() * 2).replace(/../g, '$& ')}\x1b[0m `,
                NS,
            );
        }

        return result;
    }

    public toBlzFrame(): BlzFrame {
        const buffer = this.createPayloadBuffer();
        const frame = new BlzFrame();
        frame.writeMsgCode(this._code as number);
        frame.writeMsgPayload(buffer);
        return frame;
    }

    private createPayloadBuffer(): Buffer {
        const buffalo = new BuffaloBlz(Buffer.alloc(256));

        for (const parameter of this._parameters) {
            const value = this._payload[parameter.name];
            buffalo.write(parameter.parameterType, value, {});
        }

        return buffalo.getWritten();
    }
}

export default BlzObject;
