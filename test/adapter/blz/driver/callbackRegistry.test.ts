import {describe, expect, it, vi} from "vitest";
import {CallbackRegistry} from "../../../../src/adapter/blz/driver/callbackRegistry";

describe("BLZ callback registry", () => {
    it("keeps callbacks registered during notification for the next notification", () => {
        const registry = new CallbackRegistry<() => void>();
        const registeredDuringNotify = vi.fn();
        const first = vi.fn(() => {
            registry.add(registeredDuringNotify);
        });

        registry.add(first);

        registry.notify((callback) => callback());

        expect(first).toHaveBeenCalledOnce();
        expect(registeredDuringNotify).not.toHaveBeenCalled();
        expect(registry.count()).toBe(1);

        registry.notify((callback) => callback());

        expect(registeredDuringNotify).toHaveBeenCalledOnce();
        expect(registry.count()).toBe(0);
    });

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
