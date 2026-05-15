import {describe, expect, it, vi} from "vitest";
import {checkInstallCode} from "../src/controller/helpers/installCodes";
import {Queue, Utils, Waitress, wait} from "../src/utils";
import {AsyncMutex} from "../src/utils/async-mutex";
import {logger, setLogger} from "../src/utils/logger";

const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
};

describe("Utils", () => {
    it("Is Number Array", () => {
        expect(Utils.isNumberArray([1, 2, 3])).toBeTruthy();
        expect(Utils.isNumberArray([1, 2, "3"])).toBeFalsy();
        expect(Utils.isNumberArray("nonarray")).toBeFalsy();
    });

    it("Is Number Array of length", () => {
        expect(Utils.isNumberArrayOfLength([1, 2, 3], 3)).toBeTruthy();
        expect(Utils.isNumberArrayOfLength([1, 2], 3)).toBeFalsy();
        expect(Utils.isNumberArrayOfLength([1, 2, "3"], 3)).toBeFalsy();
        expect(Utils.isNumberArrayOfLength("nonarray", 3)).toBeFalsy();
    });

    it("Is object empty", () => {
        expect(Utils.isObjectEmpty({})).toBeTruthy();
        expect(Utils.isObjectEmpty({a: 1})).toBeFalsy();
    });

    it("Assert string", () => {
        expect(Utils.assertString("bla")).toBeUndefined();

        expect(() => {
            Utils.assertString(1);
        }).toThrow("Input must be a string!");
    });

    it("Test wait", () => {
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementationOnce(
            // @ts-expect-error mocked
            () => {},
        );
        wait(1000)
            .then(() => {})
            .catch(() => {});
        expect(setTimeout).toHaveBeenCalledTimes(1);
        expect(setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 1000);
        setTimeoutSpy.mockRestore();
    });

    it("Test waitress", async () => {
        vi.useFakeTimers();
        const validator = (payload: string, matcher: number): boolean => {
            if (payload === "one" && matcher === 1) return true;
            if (payload === "two" && matcher === 2) return true;
            return false;
        };
        const waitress = new Waitress<string, number>(validator, (_, timeout) => `Timedout '${timeout}'`);

        const wait1 = waitress.waitFor(1, 10000).start();
        waitress.resolve("one");
        expect(await wait1.promise).toBe("one");

        const wait2_1 = waitress.waitFor(2, 10000).start();
        const wait2_2 = waitress.waitFor(2, 10000).start();
        const wait2_3 = waitress.waitFor(2, 10000).start();
        const wait2_4 = waitress.waitFor(2, 5000).start();
        const wait2_5 = waitress.waitFor(2, 5000).start();
        wait2_3.promise.catch(() => {});

        waitress.remove(wait2_3.ID);
        vi.advanceTimersByTime(6000);
        waitress.remove(wait2_5.ID);
        waitress.resolve("two");
        expect(await wait2_1.promise).toBe("two");
        expect(await wait2_2.promise).toBe("two");

        let error2;
        try {
            await wait2_4.promise;
        } catch (e) {
            error2 = e;
        }
        expect(error2).toStrictEqual(new Error("Timedout '5000'"));

        let error3;
        try {
            await wait2_5.promise;
        } catch (e) {
            error3 = e;
        }
        expect(error3).toStrictEqual(new Error("Timedout '5000'"));

        vi.useRealTimers();

        // reject test
        const wait1b = waitress.waitFor(1, 5000).start();
        let error1_;
        wait(1000)
            .then(() => {
                waitress.reject("one", "drop");
            })
            .catch(() => {});
        try {
            await wait1b.promise;
        } catch (e) {
            error1_ = e;
        }
        expect(error1_).toStrictEqual(new Error("drop"));

        vi.useFakeTimers();
        const wait2 = waitress.waitFor(2, 5000).start();
        const handled1 = waitress.reject("tree", "drop");
        expect(handled1).toBe(false);
        let error2_;
        vi.advanceTimersByTime(6000);
        try {
            await wait2.promise;
        } catch (e) {
            error2_ = e;
        }
        expect(error2_).toStrictEqual(new Error("Timedout '5000'"));
        const handled2 = waitress.reject("two", "drop");
        expect(handled2).toBe(false);

        waitress
            .waitFor(2, 10000)
            .start()
            .promise.catch(() => {});
        waitress
            .waitFor(2, 10000)
            .start()
            .promise.catch(() => {});

        await vi.advanceTimersByTimeAsync(2000);
        waitress.clear();
        await vi.advanceTimersByTimeAsync(12000);

        expect(waitress.count()).toStrictEqual(0);

        vi.useRealTimers();
    });

    it("Test waitress clear rejects pending waiters", async () => {
        const validator = (payload: string, matcher: number): boolean => {
            return payload.length === matcher;
        };
        const waitress = new Waitress<string, number>(validator, (_, timeout) => `Timedout '${timeout}'`);
        const waiter = waitress.waitFor(2, 10000).start();
        const result = waiter.promise.then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
        );

        waitress.clear();

        expect(
            await Promise.race([
                result,
                new Promise((resolve) => setImmediate(() => resolve("pending"))),
            ]),
        ).toBe("rejected:Waitress cleared");
    });

    it("Test waitress exposes pending waiter count without private state access", () => {
        const validator = (payload: string, matcher: number): boolean => {
            return payload.length === matcher;
        };
        const waitress = new Waitress<string, number>(validator, (_, timeout) => `Timedout '${timeout}'`);
        const first = waitress.waitFor(2, 10000);
        const second = waitress.waitFor(3, 10000);

        expect(waitress.count()).toBe(2);
        waitress.remove(first.ID);

        expect(waitress.count()).toBe(1);
        waitress.clear();

        expect(waitress.count()).toBe(0);
        void second.start().promise.catch(() => {});
    });

    it("Test waitress clear preserves custom rejection reasons", async () => {
        const validator = (payload: string, matcher: number): boolean => {
            return payload.length === matcher;
        };
        const waitress = new Waitress<string, number>(validator, (_, timeout) => `Timedout '${timeout}'`);
        const waiter = waitress.waitFor(2, 10000).start();
        const result = waiter.promise.then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
        );

        waitress.clear(new Error("Driver stopped"));

        expect(
            await Promise.race([
                result,
                new Promise((resolve) => setImmediate(() => resolve("pending"))),
            ]),
        ).toBe("rejected:Driver stopped");
    });

    it("Test waitress remove rejects removed waiters", async () => {
        const validator = (payload: string, matcher: number): boolean => {
            return payload.length === matcher;
        };
        const waitress = new Waitress<string, number>(validator, (_, timeout) => `Timedout '${timeout}'`);
        const waiter = waitress.waitFor(2, 10000).start();
        const result = waiter.promise.then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
        );

        waitress.remove(waiter.ID);

        expect(
            await Promise.race([
                result,
                new Promise((resolve) => setImmediate(() => resolve("pending"))),
            ]),
        ).toBe("rejected:Waitress removed");
    });

    it("Test waitress remove rejects unstarted waiters without unhandled rejection", async () => {
        const validator = (payload: string, matcher: number): boolean => {
            return payload.length === matcher;
        };
        const waitress = new Waitress<string, number>(validator, (_, timeout) => `Timedout '${timeout}'`);
        const waiter = waitress.waitFor(2, 10000);

        waitress.remove(waiter.ID);
        await new Promise((resolve) => setImmediate(resolve));

        await expect(waiter.start().promise).rejects.toEqual(new Error("Waitress removed"));
        expect(waitress.count()).toStrictEqual(0);
    });

    it("Test waitress clear rejects unstarted waiters without unhandled rejection", async () => {
        const validator = (payload: string, matcher: number): boolean => {
            return payload.length === matcher;
        };
        const waitress = new Waitress<string, number>(validator, (_, timeout) => `Timedout '${timeout}'`);
        const waiter = waitress.waitFor(2, 10000);

        waitress.clear();
        await new Promise((resolve) => setImmediate(resolve));

        await expect(waiter.start().promise).rejects.toEqual(new Error("Waitress cleared"));
        expect(waitress.count()).toStrictEqual(0);
    });

    it("Test waitress reject rejects unstarted waiters without unhandled rejection", async () => {
        const validator = (payload: string, matcher: number): boolean => {
            return payload.length === matcher;
        };
        const waitress = new Waitress<string, number>(validator, (_, timeout) => `Timedout '${timeout}'`);
        const waiter = waitress.waitFor(2, 10000);

        const handled = waitress.reject("up", "drop");
        await new Promise((resolve) => setImmediate(resolve));

        expect(handled).toBe(true);
        await expect(waiter.start().promise).rejects.toEqual(new Error("drop"));
        expect(waitress.count()).toStrictEqual(0);
    });

    it("Test waitress removes timed out waiters immediately", async () => {
        vi.useFakeTimers();
        const validator = (payload: string, matcher: number): boolean => {
            return payload.length === matcher;
        };
        const waitress = new Waitress<string, number>(validator, (_, timeout) => `Timedout '${timeout}'`);
        const waiter = waitress.waitFor(2, 5000).start();
        const result = waiter.promise.catch((error: Error) => error);

        await vi.advanceTimersByTimeAsync(6000);

        await expect(result).resolves.toEqual(new Error("Timedout '5000'"));
        expect(waitress.count()).toStrictEqual(0);
        vi.useRealTimers();
    });

    it("Test waitress releases timed out waiters when timeout formatter errors cannot be stringified", async () => {
        vi.useFakeTimers();
        const validator = (payload: string, matcher: number): boolean => {
            return payload.length === matcher;
        };
        const formatterFailure = {
            toString: () => {
                throw new Error("formatter stringification failed");
            },
        };
        const waitress = new Waitress<string, number>(validator, () => {
            throw formatterFailure;
        });
        const waiter = waitress.waitFor(2, 5000).start();
        const result = waiter.promise.then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
        );

        await vi.advanceTimersByTimeAsync(5000).catch(() => {});
        const observed = await Promise.race([result, Promise.resolve("pending")]);

        expect(observed).toBe("rejected:<unprintable error>");
        expect(waitress.count()).toStrictEqual(0);
        vi.useRealTimers();
    });

    it("Test waitress defers timeout formatting for waiters that resolve", async () => {
        vi.useFakeTimers();
        const validator = (payload: string, matcher: number): boolean => {
            return payload.length === matcher;
        };
        const timeoutFormatter = vi.fn((_, timeout) => `Timedout '${timeout}'`);
        const waitress = new Waitress<string, number>(validator, timeoutFormatter);
        const waiter = waitress.waitFor(2, 5000).start();

        expect(timeoutFormatter).not.toHaveBeenCalled();
        waitress.resolve("up");

        await expect(waiter.promise).resolves.toBe("up");
        expect(timeoutFormatter).not.toHaveBeenCalled();
        expect(waitress.count()).toStrictEqual(0);
        vi.useRealTimers();
    });

    it("Test queue", async () => {
        const queue = new Queue(4);
        const finished: number[] = [];

        let job1Promise: (() => void) | undefined;
        let job2Promise: (() => void) | undefined;
        const job1 = new Promise<void>((resolve) => {
            job1Promise = resolve;
        });
        const job2 = new Promise<void>((resolve) => {
            job2Promise = resolve;
        });
        const job5 = new Promise((_resolve) => {});
        const job6 = new Promise((_resolve) => {});
        const job7 = new Promise((_resolve) => {});

        const job1Result = queue.execute<string>(async () => {
            await job1;
            finished.push(1);
            return "finished";
        });

        const job2Result = queue.execute<void>(async () => {
            await job2;
            finished.push(2);
        }, "mykey");

        queue
            .execute<void>(async () => {
                finished.push(3);
                await Promise.resolve();
            }, "mykey")
            .catch(() => {});

        queue
            .execute<void>(async () => {
                finished.push(4);
                await Promise.resolve();
            }, "mykey2")
            .catch(() => {});

        queue
            .execute<void>(async () => {
                await job5;
                finished.push(5);
            })
            .catch(() => {});

        queue
            .execute<void>(async () => {
                await job6;
                finished.push(6);
            })
            .catch(() => {});

        queue
            .execute<void>(async () => {
                await job7;
                finished.push(7);
            })
            .catch(() => {});

        queue
            .execute<void>(async () => {
                finished.push(8);
                await Promise.resolve();
            })
            .catch(() => {});

        expect(finished).toEqual([4]);
        job1Promise?.();
        expect(await job1Result).toBe("finished");
        await job1Result;
        expect(finished).toEqual([4, 1]);
        job2Promise?.();
        await job2Result;
        expect(finished).toEqual([4, 1, 2, 3]);
        expect(queue.count()).toBe(5);

        queue.clear();

        expect(queue.count()).toBe(0);
    });

    it("Test queue clear rejects active jobs and does not let old work remove new jobs", async () => {
        const queue = new Queue(1);
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
        const observed = await Promise.race([
            oldJobResult,
            new Promise((resolve) => setImmediate(() => resolve("pending"))),
        ]);

        const newJob = queue.execute(async () => {
            started.push(2);
            await newJobBlocker;
        });
        const queuedJob = queue.execute(async () => {
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

    it("Test queue treats zero as a valid serialization key", async () => {
        const queue = new Queue(2);
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
            started.push(2);
        }, 0);

        await Promise.resolve();
        expect(started).toEqual([1]);

        finishFirst?.();
        await firstJob;
        await secondJob;

        expect(started).toEqual([1, 2]);
    });

    it("Test queue clear rejects jobs that have not started", async () => {
        const queue = new Queue(1);
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
            started.push(2);
        });
        const queuedResult = queuedJob.then(
            () => "resolved",
            (error: Error) => `rejected:${error.message}`,
        );

        queue.clear();

        const result = await Promise.race([
            queuedResult,
            new Promise((resolve) => setImmediate(() => resolve("pending"))),
        ]);
        const activeResult = await Promise.race([
            runningResult,
            new Promise((resolve) => setImmediate(() => resolve("pending"))),
        ]);

        expect(result).toBe("rejected:Queue cleared");
        expect(activeResult).toBe("rejected:Queue cleared");
        expect(started).toEqual([1]);
        expect(queue.count()).toBe(0);

        finishRunningJob?.();
        await Promise.resolve();
    });

    it("Test async mutex", async () => {
        vi.useFakeTimers();

        const queue = new AsyncMutex();

        void queue.run(async () => {
            await new Promise((resolve) => setTimeout(resolve, 1000));
        });

        void queue.run(async () => {
            await new Promise((resolve) => setTimeout(resolve, 1000));
        });

        await vi.advanceTimersByTimeAsync(500);
        expect(queue.count).toStrictEqual(1); // first has ran but still pending return, second is queued

        await vi.advanceTimersByTimeAsync(1000);
        expect(queue.count).toStrictEqual(0);

        void queue.run(async () => {
            await new Promise((resolve) => setTimeout(resolve, 1000));
        });

        expect(queue.count).toStrictEqual(1); // second has ran but still pending return, third is queued
        await vi.advanceTimersByTimeAsync(1600);
        expect(queue.count).toStrictEqual(0);

        //-- clear

        void queue.run(async () => {
            await new Promise((resolve) => setTimeout(resolve, 1000));
        });
        void queue.run(async () => {
            await new Promise((resolve) => setTimeout(resolve, 1000));
        });

        expect(queue.count).toStrictEqual(1);

        queue.clear();

        expect(queue.count).toStrictEqual(0);
        await vi.runOnlyPendingTimersAsync(); // cleanup

        vi.useRealTimers();
    });

    it("Logs", () => {
        const debugSpy = vi.spyOn(console, "debug");
        const infoSpy = vi.spyOn(console, "info");
        const warningSpy = vi.spyOn(console, "warn");
        const errorSpy = vi.spyOn(console, "error");
        logger.debug("debug", "zh");
        expect(debugSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[\d\d\d\d-\d\d-\d\dT\d\d:\d\d:\d\d.\d\d\dZ\] zh: debug$/));
        logger.info("info", "zh");
        expect(infoSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[\d\d\d\d-\d\d-\d\dT\d\d:\d\d:\d\d.\d\d\dZ\] zh: info$/));
        logger.warning("warning", "zh");
        expect(warningSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[\d\d\d\d-\d\d-\d\dT\d\d:\d\d:\d\d.\d\d\dZ\] zh: warning$/));
        logger.error("error", "zh");
        expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[\d\d\d\d-\d\d-\d\dT\d\d:\d\d:\d\d.\d\d\dZ\] zh: error$/));
        logger.error(() => "lazy error", "zh");
        expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[\d\d\d\d-\d\d-\d\dT\d\d:\d\d:\d\d.\d\d\dZ\] zh: lazy error$/));
        expect(() => {
            logger.error(() => {
                throw new Error("lazy format failed");
            }, "zh");
        }).not.toThrow();
        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringMatching(/^\[\d\d\d\d-\d\d-\d\dT\d\d:\d\d:\d\d.\d\d\dZ\] zh: Log message formatting failed: Error: lazy format failed$/),
        );

        setLogger(mockLogger);
        expect(logger).toEqual(mockLogger);
        logger.debug("debug", "zh");
        expect(mockLogger.debug).toHaveBeenCalledWith("debug", "zh");
        logger.info("info", "zh");
        expect(mockLogger.info).toHaveBeenCalledWith("info", "zh");
        logger.warning("warning", "zh");
        expect(mockLogger.warning).toHaveBeenCalledWith("warning", "zh");
        logger.error("error", "zh");
        expect(mockLogger.error).toHaveBeenCalledWith("error", "zh");
    });

    it("Checks install codes of all lengths", () => {
        expect(() => checkInstallCode(Buffer.from("001122", "hex"))).toThrow("Install code 001122 has invalid size");

        const code8Valid = Buffer.from("83FED3407A932B70", "hex");
        const code8Invalid = Buffer.from("FFFED3407A939723", "hex");
        const code8InvalidFixed = Buffer.from("FFFED3407A93DE84", "hex");
        const code8MissingCRC = Buffer.from("83FED3407A93", "hex");

        expect(checkInstallCode(code8Valid)).toStrictEqual([code8Valid, undefined]);
        expect(checkInstallCode(code8Invalid)).toStrictEqual([code8InvalidFixed, "invalid CRC"]);
        expect(() => checkInstallCode(code8Invalid, false)).toThrow(`Install code ${code8Invalid.toString("hex")} failed CRC validation`);
        expect(checkInstallCode(code8MissingCRC)).toStrictEqual([code8Valid, "missing CRC"]);
        expect(() => checkInstallCode(code8MissingCRC, false)).toThrow(`Install code ${code8MissingCRC.toString("hex")} failed CRC validation`);

        const code10Valid = Buffer.from("83FED3407A93972397FC", "hex");
        const code10Invalid = Buffer.from("FFFED3407A939723A5C6", "hex");
        const code10InvalidFixed = Buffer.from("FFFED3407A9397238C4F", "hex");
        // consired as 8-length with invalid CRC
        const code10MissingCRC = Buffer.from("83FED3407A939723", "hex");
        const code10MissingCRCFixed = Buffer.from("83FED3407A932B70", "hex");

        expect(checkInstallCode(code10Valid)).toStrictEqual([code10Valid, undefined]);
        expect(checkInstallCode(code10Invalid)).toStrictEqual([code10InvalidFixed, "invalid CRC"]);
        expect(() => checkInstallCode(code10Invalid, false)).toThrow(`Install code ${code10Invalid.toString("hex")} failed CRC validation`);
        expect(checkInstallCode(code10MissingCRC)).toStrictEqual([code10MissingCRCFixed, "invalid CRC"]);
        expect(() => checkInstallCode(code10MissingCRC, false)).toThrow(`Install code ${code10MissingCRC.toString("hex")} failed CRC validation`);

        const code14Valid = Buffer.from("83FED3407A939723A5C639FF4C12", "hex");
        const code14Invalid = Buffer.from("FFFED3407A939723A5C639FF4C12", "hex");
        const code14InvalidFixed = Buffer.from("FFFED3407A939723A5C639FFDE74", "hex");
        const code14MissingCRC = Buffer.from("83FED3407A939723A5C639FF", "hex");

        expect(checkInstallCode(code14Valid)).toStrictEqual([code14Valid, undefined]);
        expect(checkInstallCode(code14Invalid)).toStrictEqual([code14InvalidFixed, "invalid CRC"]);
        expect(() => checkInstallCode(code14Invalid, false)).toThrow(`Install code ${code14Invalid.toString("hex")} failed CRC validation`);
        expect(checkInstallCode(code14MissingCRC)).toStrictEqual([code14Valid, "missing CRC"]);
        expect(() => checkInstallCode(code14MissingCRC, false)).toThrow(`Install code ${code14MissingCRC.toString("hex")} failed CRC validation`);

        const code18Valid = Buffer.from("83FED3407A939723A5C639B26916D505C3B5", "hex");
        const code18Invalid = Buffer.from("FFFED3407A939723A5C639B26916D505C3B5", "hex");
        const code18InvalidFixed = Buffer.from("FFFED3407A939723A5C639B26916D505EEB1", "hex");
        const code18MissingCRC = Buffer.from("83FED3407A939723A5C639B26916D505", "hex");

        expect(checkInstallCode(code18Valid)).toStrictEqual([code18Valid, undefined]);
        expect(checkInstallCode(code18Invalid)).toStrictEqual([code18InvalidFixed, "invalid CRC"]);
        expect(() => checkInstallCode(code18Invalid, false)).toThrow(`Install code ${code18Invalid.toString("hex")} failed CRC validation`);
        expect(checkInstallCode(code18MissingCRC)).toStrictEqual([code18Valid, "missing CRC"]);
        expect(() => checkInstallCode(code18MissingCRC, false)).toThrow(`Install code ${code18MissingCRC.toString("hex")} failed CRC validation`);
    });
});
