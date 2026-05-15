import {describe, expect, it, vi} from "vitest";
import {CallbackRegistry} from "../../../../src/adapter/blz/driver/callbackRegistry";

describe("BLZ callback registry", () => {
    it("does not notify callbacks removed before their turn", () => {
        const registry = new CallbackRegistry<() => void>();
        const second = vi.fn();
        const first = vi.fn(() => {
            registry.delete(second);
        });

        registry.add(first);
        registry.add(second);

        registry.notify((callback) => callback());

        expect(first).toHaveBeenCalledOnce();
        expect(second).not.toHaveBeenCalled();
        expect(registry.count()).toBe(0);
    });

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

    it("reports all callback failures from one notification pass", () => {
        const registry = new CallbackRegistry<() => void>();
        const firstError = new Error("first failed");
        const secondError = new Error("second failed");
        const first = vi.fn(() => {
            throw firstError;
        });
        const second = vi.fn(() => {
            throw secondError;
        });

        registry.add(first);
        registry.add(second);

        const error = captureThrown(() => registry.notify((callback) => callback()));

        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toEqual([firstError, secondError]);
        expect(first).toHaveBeenCalledOnce();
        expect(second).toHaveBeenCalledOnce();
        expect(registry.count()).toBe(0);
    });
});

function captureThrown(operation: () => void): unknown {
    try {
        operation();
    } catch (error) {
        return error;
    }

    return undefined;
}
