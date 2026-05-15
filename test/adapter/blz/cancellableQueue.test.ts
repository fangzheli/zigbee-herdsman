import {describe, expect, it} from "vitest";

import {CancellableQueue} from "../../../src/adapter/blz/cancellableQueue";

describe("BLZ cancellable queue", () => {
    it("normalizes non-positive concurrency so jobs cannot stay stuck", async () => {
        const queue = new CancellableQueue(0);
        let started = false;

        const result = queue.execute(async () => {
            started = true;
            await Promise.resolve();
            return "started";
        });
        await Promise.resolve();

        expect(started).toBe(true);
        await expect(result).resolves.toBe("started");
        expect(queue.count()).toBe(0);
    });

    it("treats zero as a valid serialization key", async () => {
        const queue = new CancellableQueue(2);
        const started: number[] = [];

        let finishFirst: (() => void) | undefined;
        const firstBlocker = new Promise<void>((resolve) => {
            finishFirst = resolve;
        });

        const firstJob = queue.execute(async () => {
            started.push(1);
            await firstBlocker;
        }, 0);
        const secondJob = queue.execute(async () => {
            await Promise.resolve();
            started.push(2);
        }, 0);

        await Promise.resolve();
        expect(started).toEqual([1]);

        finishFirst?.();
        await firstJob;
        await secondJob;

        expect(started).toEqual([1, 2]);
        expect(queue.count()).toBe(0);
    });

    it("clear rejects active and queued jobs", async () => {
        const queue = new CancellableQueue(1);
        const started: number[] = [];

        let finishRunningJob: (() => void) | undefined;
        const runningJobBlocker = new Promise<void>((resolve) => {
            finishRunningJob = resolve;
        });

        const runningJob = queue.execute(async () => {
            started.push(1);
            await runningJobBlocker;
        });
        const runningResult = runningJob.then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
        );
        const queuedJob = queue.execute(async () => {
            await Promise.resolve();
            started.push(2);
        });
        const queuedResult = queuedJob.then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
        );

        queue.clear(new Error("stopped"));

        const queuedObserved = await Promise.race([queuedResult, new Promise((resolve) => setImmediate(() => resolve("pending")))]);
        const runningObserved = await Promise.race([runningResult, new Promise((resolve) => setImmediate(() => resolve("pending")))]);

        expect(queuedObserved).toBe("rejected:stopped");
        expect(runningObserved).toBe("rejected:stopped");
        expect(started).toEqual([1]);
        expect(queue.count()).toBe(0);

        finishRunningJob?.();
        await Promise.resolve();
    });

    it("clear does not let old work remove newer jobs", async () => {
        const queue = new CancellableQueue(1);
        const started: number[] = [];

        let finishOldJob: (() => void) | undefined;
        let finishNewJob: (() => void) | undefined;
        const oldJobBlocker = new Promise<void>((resolve) => {
            finishOldJob = resolve;
        });
        const newJobBlocker = new Promise<void>((resolve) => {
            finishNewJob = resolve;
        });

        const oldJob = queue.execute(async () => {
            started.push(1);
            await oldJobBlocker;
        });
        const oldJobResult = oldJob.then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
        );

        queue.clear();
        const observed = await Promise.race([oldJobResult, new Promise((resolve) => setImmediate(() => resolve("pending")))]);

        const newJob = queue.execute(async () => {
            started.push(2);
            await newJobBlocker;
        });
        const queuedJob = queue.execute(async () => {
            await Promise.resolve();
            started.push(3);
        });

        expect(started).toEqual([1, 2]);
        expect(queue.count()).toBe(2);
        expect(observed).toBe("rejected:Queue cleared");

        finishOldJob?.();
        await Promise.resolve();

        expect(started).toEqual([1, 2]);
        expect(queue.count()).toBe(2);

        finishNewJob?.();
        await newJob;
        await queuedJob;

        expect(started).toEqual([1, 2, 3]);
        expect(queue.count()).toBe(0);
    });
});
