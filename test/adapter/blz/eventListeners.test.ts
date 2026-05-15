import {describe, expect, it, vi} from "vitest";

import {attachListenersOrRollback, detachListeners, type OwnedEventListener} from "../../../src/adapter/blz/eventListeners";

describe("BLZ event listener ownership helpers", () => {
    it("rolls back only listeners that were attached before an attach failure", () => {
        const first = vi.fn();
        const second = vi.fn();
        const third = vi.fn();
        const attachError = new Error("second attach failed");
        const on = vi.fn((event: string | symbol) => {
            if (event === "second") {
                throw attachError;
            }
        });
        const once = vi.fn();
        const off = vi.fn((event: string | symbol) => {
            if (event === "third") {
                throw new Error("third was not attached");
            }
        });
        const target = {
            on,
            once,
            off,
        };
        const listeners: readonly OwnedEventListener[] = [
            {event: "first", listener: first},
            {event: "second", listener: second},
            {event: "third", listener: third},
        ];

        expect(() => attachListenersOrRollback(target, listeners)).toThrow(attachError);

        expect(on).toHaveBeenCalledTimes(2);
        expect(off).toHaveBeenCalledOnce();
        expect(off).toHaveBeenCalledWith("first", first);
    });

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
