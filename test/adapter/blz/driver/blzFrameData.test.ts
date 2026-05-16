import {describe, expect, it, vi} from "vitest";
import * as fs from "node:fs";

import {BLZFrameData, NS} from "../../../../src/adapter/blz/driver/blz";
import {FRAMES} from "../../../../src/adapter/blz/driver/commands";
import {BlzValueId} from "../../../../src/adapter/blz/driver/types";
import {logger} from "../../../../src/utils/logger";

describe("BLZFrameData", () => {
    it("uses explicit frame parser fallback without non-null assertions", () => {
        const source = fs.readFileSync("src/adapter/blz/driver/frameData.ts", "utf8");

        expect(source).not.toContain("names.every");
        expect(source).not.toContain("return frm!");
        expect(source).toContain("): BLZFrameData | undefined");
    });

    it("serializes frames with uint64 fields to JSON for debug logging", () => {
        const payload = Buffer.from("0000dddddddddddddddd621a0e0b00000000080000", "hex");
        const frame = BLZFrameData.createFrame(FRAMES.getNetworkParameters.ID, false, payload);

        expect(() => JSON.stringify(frame)).not.toThrow();
        expect(JSON.parse(JSON.stringify(frame))).toMatchObject({
            _cls_: "getNetworkParameters",
            extPanId: "0xdddddddddddddddd",
        });
    });

    it("returns undefined when candidate frame parse errors cannot be stringified", () => {
        const error = vi.spyOn(logger, "error").mockImplementation(() => {});
        const originalErrorToString = Error.prototype.toString;
        const errorToString = vi
            .spyOn(Error.prototype, "toString")
            .mockImplementation(function errorToString() {
                if (this.message.includes("Buffer too small")) {
                    throw new Error("frame parse error stringification failed");
                }

                return originalErrorToString.call(this);
            });

        try {
            expect(
                BLZFrameData.createFrame(FRAMES.getValue.ID, false, Buffer.alloc(0)),
            ).toBeUndefined();
            expect(error).toHaveBeenCalledWith("Frame getValue parsing error: <unprintable error>", NS);
        } finally {
            errorToString.mockRestore();
            error.mockRestore();
        }
    });

    it("serializes command fields without Buffer.concat allocation churn", () => {
        const concatSpy = vi.spyOn(Buffer, "concat");
        try {
            const frame = new BLZFrameData("getValue", true, {
                valueId: BlzValueId.BLZ_VALUE_ID_STACK_VERSION,
            });

            expect(frame.serialize()).toStrictEqual(
                Buffer.from([BlzValueId.BLZ_VALUE_ID_STACK_VERSION]),
            );
            expect(concatSpy).not.toHaveBeenCalled();
        } finally {
            concatSpy.mockRestore();
        }
    });

    it("serializes command fields through the shared mapped buffer helper", () => {
        const source = fs.readFileSync("src/adapter/blz/driver/frameData.ts", "utf8");

        expect(source).not.toContain("buffers.push");
        expect(source).toContain("serializeMappedBufferSegments(fields");
    });

    it("rejects declared byte fields with truncated payload data", () => {
        expect(() =>
            new BLZFrameData("getValue", false, Buffer.from([0x00, 0x03, 0xaa, 0xbb])),
        ).toThrow("Byte field value expected 3 bytes, received 2");
    });

    it("rejects declared byte fields with mismatched serialized payload length", () => {
        const frame = new BLZFrameData("getValue", false, {
            status: 0x00,
            valueLength: 1,
            value: Buffer.from([0xaa, 0xbb]),
        });

        expect(() => frame.serialize()).toThrow("Byte field value expected 1 bytes, received 2");
    });

    it("rejects trailing bytes after a declared byte field", () => {
        expect(() =>
            new BLZFrameData("getValue", false, Buffer.from([0x00, 0x02, 0xaa, 0xbb, 0xcc])),
        ).toThrow("Unexpected trailing data after getValue frame: 1 bytes");
    });

    it("parses counted WordList fields without consuming following lists", () => {
        const frame = new BLZFrameData(
            "addEndpoint",
            true,
            Buffer.from([
                0x01, // endpoint
                0x04, 0x01, // profileId
                0x00, 0x00, // deviceId
                0x00, // appFlags
                0x02, // inputClusterCount
                0x01, // outputClusterCount
                0x06, 0x00, // genOnOff
                0x08, 0x00, // genLevelCtrl
                0x19, 0x00, // genOta
            ]),
        );

        expect(frame.inputClusterList).toEqual([0x0006, 0x0008]);
        expect(frame.outputClusterList).toEqual([0x0019]);
    });

    it("rejects counted WordList fields with mismatched serialized item count", () => {
        const frame = new BLZFrameData("addEndpoint", true, {
            endpoint: 1,
            profileId: 0x0104,
            deviceId: 0x0000,
            appFlags: 0,
            inputClusterCount: 1,
            outputClusterCount: 0,
            inputClusterList: [0x0006, 0x0008],
            outputClusterList: [],
        });

        expect(() => frame.serialize()).toThrow("WordList field inputClusterList expected 1 items, received 2");
    });
});
