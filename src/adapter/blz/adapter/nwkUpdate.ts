export type NwkUpdateChannelChange = {
    payload: Buffer;
    scanChannelsMask: number;
    channel: number;
    scanDuration: number;
    nwkUpdateId: number;
    nwkManagerAddr: number;
};

const CHANNEL_CHANGE_DURATION = 0xfe;
const DEFAULT_NWK_MANAGER_ADDR = 0xffff;

export function parseNwkUpdateChannelChange(rawPayload: Buffer, hasZdoMessageOverhead: boolean): NwkUpdateChannelChange {
    const payload = normalizeNwkUpdatePayload(rawPayload, hasZdoMessageOverhead);
    let offset = hasZdoMessageOverhead ? 1 : 0;

    const scanChannelsMask = payload.readUInt32LE(offset);
    offset += 4;

    const scanDuration = payload.readUInt8(offset);
    offset += 1;

    if (scanDuration !== CHANNEL_CHANGE_DURATION) {
        throw new Error(`scanDuration 0x${scanDuration.toString(16)} is not 0xFE; this adapter only handles channel-change requests.`);
    }

    const nwkUpdateId = payload.readUInt8(offset);
    offset += 1;

    const nwkManagerAddr = payload.readUInt16LE(offset);
    const channel = channelFromSingleBitMask(scanChannelsMask);

    return {
        payload,
        scanChannelsMask,
        channel,
        scanDuration,
        nwkUpdateId,
        nwkManagerAddr,
    };
}

function normalizeNwkUpdatePayload(rawPayload: Buffer, hasZdoMessageOverhead: boolean): Buffer {
    let payload = Buffer.from(rawPayload);
    let needsTsn = false;
    let needsManagerAddress = false;

    if (hasZdoMessageOverhead) {
        switch (payload.length) {
            case 9:
                break;
            case 8:
                needsTsn = true;
                break;
            case 7:
                needsManagerAddress = true;
                break;
            case 6:
                needsTsn = true;
                needsManagerAddress = true;
                break;
            default:
                throw new Error(
                    `Unexpected NWK_UPDATE_REQUEST length ${payload.length} bytes. Expected 6, 7, 8, or 9 bytes when hasZdoMessageOverhead=true`,
                );
        }
    } else {
        switch (payload.length) {
            case 8:
                break;
            case 6:
                needsManagerAddress = true;
                break;
            default:
                throw new Error(
                    `Unexpected NWK_UPDATE_REQUEST length ${payload.length} bytes. Expected 6 or 8 bytes when hasZdoMessageOverhead=false`,
                );
        }
    }

    if (needsTsn) {
        payload = Buffer.concat([Buffer.from([0x00]), payload]);
    }

    if (needsManagerAddress) {
        payload = Buffer.concat([payload, Buffer.from([DEFAULT_NWK_MANAGER_ADDR & 0xff, (DEFAULT_NWK_MANAGER_ADDR >> 8) & 0xff])]);
    }

    return payload;
}

function channelFromSingleBitMask(scanChannelsMask: number): number {
    let channel = -1;

    for (let i = 0; i < 32; i++) {
        if ((scanChannelsMask >>> i) & 1) {
            if (channel !== -1) {
                throw new Error(`scanChannelsMask 0x${scanChannelsMask.toString(16)} has more than one bit set`);
            }

            channel = i;
        }
    }

    if (channel === -1) {
        throw new Error(`scanChannelsMask 0x${scanChannelsMask.toString(16)} has no bits set`);
    }

    return channel;
}
