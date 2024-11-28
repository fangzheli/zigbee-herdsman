/* istanbul ignore file */

import {randomBytes} from 'crypto';

import {BlzEUI64, BlzInitialSecurityBitmask} from '../types/named';
import {BlzInitialSecurityState, BlzKeyData} from '../types/struct';
import crc16ccitt from './crc16ccitt';

if (!Symbol.asyncIterator) {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any*/
    (<any>Symbol).asyncIterator = Symbol.for('Symbol.asyncIterator');
}

function blz_security(networkKey: Buffer): BlzInitialSecurityState {
    const isc: BlzInitialSecurityState = new BlzInitialSecurityState();
    isc.bitmask =
        BlzInitialSecurityBitmask.HAVE_PRECONFIGURED_KEY |
        BlzInitialSecurityBitmask.TRUST_CENTER_GLOBAL_LINK_KEY |
        BlzInitialSecurityBitmask.HAVE_NETWORK_KEY |
        //BlzInitialSecurityBitmask.PRECONFIGURED_NETWORK_KEY_MODE |
        BlzInitialSecurityBitmask.REQUIRE_ENCRYPTED_KEY |
        BlzInitialSecurityBitmask.TRUST_CENTER_USES_HASHED_LINK_KEY;
    isc.preconfiguredKey = new BlzKeyData();
    isc.preconfiguredKey.contents = randomBytes(16);
    isc.networkKey = new BlzKeyData();
    isc.networkKey.contents = networkKey;
    isc.networkKeySequenceNumber = 0;
    isc.preconfiguredTrustCenterEui64 = new BlzEUI64([0, 0, 0, 0, 0, 0, 0, 0]);
    return isc;
}

export {crc16ccitt, blz_security};
