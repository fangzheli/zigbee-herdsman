/* istanbul ignore file */

import crc16ccitt from "./crc16ccitt";

if (!Symbol.asyncIterator) {
    (Symbol as unknown as {asyncIterator: symbol}).asyncIterator = Symbol.for("Symbol.asyncIterator");
}

export {crc16ccitt};
