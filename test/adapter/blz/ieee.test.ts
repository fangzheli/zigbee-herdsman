import {describe, expect, it} from "vitest";

import {formatIeeeAddress, normalizeIeeeAddress} from "../../../src/adapter/blz/ieee";

describe("BLZ IEEE helpers", () => {
    it("normalizes prefixes and casing for cache keys", () => {
        expect(normalizeIeeeAddress("0X010203040506ABCD")).toBe("010203040506abcd");
        expect(normalizeIeeeAddress("0x010203040506ABCD")).toBe("010203040506abcd");
        expect(normalizeIeeeAddress("010203040506ABCD")).toBe("010203040506abcd");
    });

    it("formats prefixed lower-case IEEE addresses from string-like values", () => {
        expect(
            formatIeeeAddress({
                toString: () => "0X010203040506ABCD",
            }),
        ).toBe("0x010203040506abcd");
    });
});
