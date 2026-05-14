import {describe, expect, it} from "vitest";

import {parseNwkUpdateChannelChange} from "../../../../src/adapter/blz/adapter/nwkUpdate";
import * as Zdo from "../../../../src/zspec/zdo";

describe("BLZ NWK update payload handling", () => {
    it("normalizes controller channel-change payloads that omit the manager address", () => {
        const rawPayload = Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.NWK_UPDATE_REQUEST, [15], 0xfe, undefined, 1, undefined);

        const result = parseNwkUpdateChannelChange(rawPayload, true);

        expect(result.channel).toBe(15);
        expect(result.nwkUpdateId).toBe(1);
        expect(result.nwkManagerAddr).toBe(0xffff);
        expect(result.payload).toStrictEqual(Buffer.from("0000800000fe01ffff", "hex"));
    });

    it.each([
        {
            name: "TSN and manager address",
            hasZdoMessageOverhead: true,
            rawPayload: "0500800000fe013412",
            expectedPayload: "0500800000fe013412",
            nwkUpdateId: 1,
            nwkManagerAddr: 0x1234,
        },
        {
            name: "TSN only",
            hasZdoMessageOverhead: true,
            rawPayload: "0500800000fe02",
            expectedPayload: "0500800000fe02ffff",
            nwkUpdateId: 2,
            nwkManagerAddr: 0xffff,
        },
        {
            name: "manager address only",
            hasZdoMessageOverhead: true,
            rawPayload: "00800000fe033412",
            expectedPayload: "0000800000fe033412",
            nwkUpdateId: 3,
            nwkManagerAddr: 0x1234,
        },
        {
            name: "neither TSN nor manager address",
            hasZdoMessageOverhead: true,
            rawPayload: "00800000fe04",
            expectedPayload: "0000800000fe04ffff",
            nwkUpdateId: 4,
            nwkManagerAddr: 0xffff,
        },
        {
            name: "no ZDO overhead with manager address",
            hasZdoMessageOverhead: false,
            rawPayload: "00800000fe053412",
            expectedPayload: "00800000fe053412",
            nwkUpdateId: 5,
            nwkManagerAddr: 0x1234,
        },
        {
            name: "no ZDO overhead without manager address",
            hasZdoMessageOverhead: false,
            rawPayload: "00800000fe06",
            expectedPayload: "00800000fe06ffff",
            nwkUpdateId: 6,
            nwkManagerAddr: 0xffff,
        },
    ])("normalizes $name", ({hasZdoMessageOverhead, rawPayload, expectedPayload, nwkUpdateId, nwkManagerAddr}) => {
        const raw = Buffer.from(rawPayload, "hex");
        const original = Buffer.from(raw);

        const result = parseNwkUpdateChannelChange(raw, hasZdoMessageOverhead);

        expect(raw).toStrictEqual(original);
        expect(result.channel).toBe(15);
        expect(result.nwkUpdateId).toBe(nwkUpdateId);
        expect(result.nwkManagerAddr).toBe(nwkManagerAddr);
        expect(result.payload).toStrictEqual(Buffer.from(expectedPayload, "hex"));
    });

    it("rejects unsupported energy-scan requests", () => {
        const raw = Buffer.from("00008000000303", "hex");

        expect(() => parseNwkUpdateChannelChange(raw, true)).toThrow("this adapter only handles channel-change requests");
    });

    it("rejects channel-change masks with more than one channel", () => {
        const raw = Buffer.from("0000880000fe01", "hex");

        expect(() => parseNwkUpdateChannelChange(raw, true)).toThrow("has more than one bit set");
    });

    it("rejects channel-change masks with no channels", () => {
        const raw = Buffer.from("0000000000fe01", "hex");

        expect(() => parseNwkUpdateChannelChange(raw, true)).toThrow("has no bits set");
    });

    it("rejects payloads with unsupported lengths", () => {
        expect(() => parseNwkUpdateChannelChange(Buffer.from("0000800000", "hex"), true)).toThrow("Unexpected NWK_UPDATE_REQUEST length 5 bytes");
        expect(() => parseNwkUpdateChannelChange(Buffer.from("00800000fe", "hex"), false)).toThrow("Unexpected NWK_UPDATE_REQUEST length 5 bytes");
    });
});
