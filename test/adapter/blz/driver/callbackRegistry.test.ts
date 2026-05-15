import {describe, expect, it, vi} from "vitest";
import {CallbackRegistry} from "../../../../src/adapter/blz/driver/callbackRegistry";

describe("BLZ callback registry", () => {
    it("notifies every registered callback even when one throws", () => {
        const registry = new CallbackRegistry<() => void>();
        const first = vi.fn(() => {
            throw new Error("first failed");
        });
        const second = vi.fn();

        registry.add(first);
        registry.add(second);

        expect(() => registry.notify((callback) => callback())).toThrow("first failed");

        expect(first).toHaveBeenCalledOnce();
        expect(second).toHaveBeenCalledOnce();
        expect(registry.count()).toBe(0);
    });
});
