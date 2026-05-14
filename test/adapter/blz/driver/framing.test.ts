import {describe, expect, it} from "vitest";

import * as consts from "../../../../src/adapter/blz/driver/consts";
import {stuffFrameData, unstuffFrameData} from "../../../../src/adapter/blz/driver/framing";

describe("BLZ frame byte stuffing", () => {
    it("stuffs all delimiter bytes and leaves other bytes unchanged", () => {
        const raw = Buffer.from([0x00, consts.START, consts.END, consts.ESCAPE, 0xff]);

        const stuffed = stuffFrameData(raw);

        expect(stuffed).toStrictEqual(
            Buffer.from([
                0x00,
                consts.ESCAPE,
                consts.START ^ consts.STUFF,
                consts.ESCAPE,
                consts.END ^ consts.STUFF,
                consts.ESCAPE,
                consts.ESCAPE ^ consts.STUFF,
                0xff,
            ]),
        );
        expect(raw).toStrictEqual(Buffer.from([0x00, consts.START, consts.END, consts.ESCAPE, 0xff]));
    });

    it("unstuffs escaped delimiter bytes", () => {
        const stuffed = Buffer.from([
            consts.ESCAPE,
            consts.START ^ consts.STUFF,
            consts.ESCAPE,
            consts.END ^ consts.STUFF,
            consts.ESCAPE,
            consts.ESCAPE ^ consts.STUFF,
        ]);

        expect(unstuffFrameData(stuffed)).toStrictEqual(Buffer.from([consts.START, consts.END, consts.ESCAPE]));
    });

    it("round trips payloads through stuff and unstuff", () => {
        const raw = Buffer.from([consts.START, 0x01, consts.END, 0x02, consts.ESCAPE, 0x03]);

        expect(unstuffFrameData(stuffFrameData(raw))).toStrictEqual(raw);
    });
});
