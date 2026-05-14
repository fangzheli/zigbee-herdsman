import {describe, expect, it, vi} from "vitest";

import {BLZFrameData} from "../../../../src/adapter/blz/driver/blz";
import {FRAMES} from "../../../../src/adapter/blz/driver/commands";
import {BlzValueId} from "../../../../src/adapter/blz/driver/types";

describe("BLZFrameData", () => {
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
});
