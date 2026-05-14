import {describe, expect, it, vi} from "vitest";
import * as fs from "node:fs";

import {BLZFrameData} from "../../../../src/adapter/blz/driver/blz";
import {FRAMES} from "../../../../src/adapter/blz/driver/commands";
import {BlzValueId} from "../../../../src/adapter/blz/driver/types";

describe("BLZFrameData", () => {
    it("uses explicit frame parser fallback without non-null assertions", () => {
        const source = fs.readFileSync("src/adapter/blz/driver/blz.ts", "utf8");

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
        const source = fs.readFileSync("src/adapter/blz/driver/blz.ts", "utf8");

        expect(source).not.toContain("buffers.push");
        expect(source).toContain("serializeMappedBufferSegments(fields");
    });

    it("rejects declared byte fields with truncated payload data", () => {
        expect(() =>
            new BLZFrameData("getValue", false, Buffer.from([0x00, 0x03, 0xaa, 0xbb])),
        ).toThrow("Byte field value expected 3 bytes, received 2");
    });

    it("rejects trailing bytes after a declared byte field", () => {
        expect(() =>
            new BLZFrameData("getValue", false, Buffer.from([0x00, 0x02, 0xaa, 0xbb, 0xcc])),
        ).toThrow("Unexpected trailing data after getValue frame: 1 bytes");
    });
});
