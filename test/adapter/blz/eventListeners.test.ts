import {describe, expect, it, vi} from "vitest";

import {detachListeners, type OwnedEventListener} from "../../../src/adapter/blz/eventListeners";

describe("BLZ event listener ownership helpers", () => {
    it("detaches every listener even when one detach throws", () => {
        const first = vi.fn();
        const second = vi.fn();
        const detachError = new Error("first detach failed");
        const off = vi.fn((event: string | symbol, listener: (...args: unknown[]) => void) => {
            if (event === "first" && listener === first) {
                throw detachError;
            }
        });
        const target = {
            off,
        };
        const listeners: readonly OwnedEventListener[] = [
            {event: "first", listener: first},
            {event: "second", listener: second},
        ];

        expect(() => detachListeners(target, listeners)).toThrow(detachError);

        expect(off).toHaveBeenCalledTimes(2);
        expect(off).toHaveBeenNthCalledWith(1, "first", first);
        expect(off).toHaveBeenNthCalledWith(2, "second", second);
    });
});
