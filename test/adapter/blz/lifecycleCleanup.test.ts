import {describe, expect, it, vi} from "vitest";

import {runAsyncCleanupSteps, runCleanupSteps} from "../../../src/adapter/blz/lifecycleCleanup";

describe("BLZ lifecycle cleanup helpers", () => {
    it("runs every sync cleanup step and reports all cleanup failures", () => {
        const firstError = new Error("first cleanup failed");
        const secondError = new Error("second cleanup failed");
        const lastStep = vi.fn();

        const error = captureThrown(() => {
            runCleanupSteps([
                () => {
                    throw firstError;
                },
                () => {
                    throw secondError;
                },
                lastStep,
            ]);
        });

        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toEqual([firstError, secondError]);
        expect(lastStep).toHaveBeenCalledOnce();
    });

    it("runs every async cleanup step and reports all cleanup failures", async () => {
        const firstError = new Error("first async cleanup failed");
        const secondError = new Error("second async cleanup failed");
        const lastStep = vi.fn();

        const error = await runAsyncCleanupSteps([() => Promise.reject(firstError), () => Promise.reject(secondError), lastStep]).catch(
            (caught: unknown) => caught,
        );

        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toEqual([firstError, secondError]);
        expect(lastStep).toHaveBeenCalledOnce();
    });

    it("keeps single cleanup failures unchanged", async () => {
        const syncError = new Error("sync cleanup failed");
        const asyncError = new Error("async cleanup failed");

        expect(() =>
            runCleanupSteps([
                () => {
                    throw syncError;
                },
            ]),
        ).toThrow(syncError);
        await expect(runAsyncCleanupSteps([() => Promise.reject(asyncError)])).rejects.toThrow(asyncError);
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
