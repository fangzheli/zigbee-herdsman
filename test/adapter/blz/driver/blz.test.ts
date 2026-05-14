import * as fs from "node:fs";

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { Blz, BLZFrameData } from "../../../../src/adapter/blz/driver/blz";
import { SerialDriver } from "../../../../src/adapter/blz/driver/uart";
import {
  BlzStatus,
  BlzValueId,
} from "../../../../src/adapter/blz/driver/types/named";
import { SerialPortOptions } from "../../../../src/adapter/tstype";
import { FRAMES } from "../../../../src/adapter/blz/driver/commands";
import { logger } from "../../../../src/utils/logger";
import { NS } from "../../../../src/adapter/blz/driver/blz";
import {
  MAX_SERIAL_CONNECT_ATTEMPTS,
  SERIAL_CONNECT_NEW_ATTEMPT_MIN_DELAY,
} from "../../../../src/adapter/blz/driver/blz";

vi.mock("../../../../src/adapter/blz/driver/uart");

// Mock BLZFrameData
vi.mock("../../../../src/adapter/blz/driver/blz", async () => {
  const actual = await vi.importActual(
    "../../../../src/adapter/blz/driver/blz",
  );
  return {
    ...actual,
    BLZFrameData: {
      createFrame: vi
        .fn()
        .mockImplementation(
          (frameId: number, isRequest: boolean, params: any) => {
            const frameName = Object.entries(FRAMES).find(
              ([_, desc]) => desc.ID === frameId,
            )?.[0];
            if (!frameName) {
              throw new Error(`Unknown frame ID: ${frameId}`);
            }
            return {
              _cls_: frameName,
              _id_: frameId,
              _isRequest_: isRequest,
              ...params,
            };
          },
        ),
    },
  };
});

describe("BLZ Driver", () => {
  let blz: Blz;
  let serialDriverMock: {
    connect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    isInitialized: ReturnType<typeof vi.fn>;
    sendDATA: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    removeAllListeners: ReturnType<typeof vi.fn>;
  };

  const serialPortOptions: SerialPortOptions = {
    path: "COM5",
    baudRate: 115200,
    rtscts: false,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    serialDriverMock = {
      connect: vi.fn(),
      close: vi.fn(),
      isInitialized: vi.fn(),
      sendDATA: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    vi.mocked(SerialDriver).mockImplementation(() => serialDriverMock as any);
    blz = new Blz();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("Connection", () => {
    it("should keep cached version behind defensive snapshots", () => {
      const source = fs.readFileSync("src/adapter/blz/driver/blz.ts", "utf8");

      expect(source).toContain("private version:");
      expect(source).not.toContain("public version:");
      expect(source).toContain("private waitFor(");
      expect(source).not.toContain("public waitFor(");
      expect(source).not.toContain("cmdSeq");
      expect(source).not.toContain("makeZDOframe(");
      expect(source).not.toContain("BLZZDORequestFrameData");
      expect(source).not.toContain("BLZZDOResponseFrameData");
      expect(source).not.toContain("ZDOREQUESTS");
      expect(source).not.toContain("ZDOREQUEST_NAME_BY_ID");
      expect(source).not.toContain("ZDORESPONSES");
      expect(source).not.toContain("ZDORESPONSE_NAME_BY_ID");

      const version = blz.getVersionSnapshot();
      version.product = 99;

      expect(blz.getVersionSnapshot().product).toBe(1);
    });

    it("should connect successfully", async () => {
      serialDriverMock.connect.mockResolvedValue(undefined);
      serialDriverMock.isInitialized.mockReturnValue(true);

      await blz.connect(serialPortOptions);
      expect(serialDriverMock.connect).toHaveBeenCalledWith(serialPortOptions);
      expect(blz.isInitialized()).toBe(true);
    });

    // it('should handle connection failure', async () => {
    //     // Mock connection to fail all attempts
    //     serialDriverMock.connect.mockRejectedValue(new Error('Connection failed'));
    //     serialDriverMock.isInitialized.mockReturnValue(false);

    //     // Spy on logger to verify error messages
    //     const loggerSpy = vi.spyOn(logger, 'error');
    //     const loggerDebugSpy = vi.spyOn(logger, 'debug');

    //     const connectPromise = blz.connect(serialPortOptions);

    //     // Advance time for each retry attempt and verify behavior
    //     for (let i = 1; i <= MAX_SERIAL_CONNECT_ATTEMPTS; i++) {
    //         await vi.advanceTimersByTimeAsync(SERIAL_CONNECT_NEW_ATTEMPT_MIN_DELAY * i);

    //         // Verify appropriate error logging
    //         expect(loggerSpy).toHaveBeenCalledWith(
    //             expect.stringContaining(`Connection attempt ${i} failed`),
    //             NS
    //         );

    //         if (i < MAX_SERIAL_CONNECT_ATTEMPTS) {
    //             expect(loggerDebugSpy).toHaveBeenCalledWith(
    //                 expect.stringContaining(`Waiting ${SERIAL_CONNECT_NEW_ATTEMPT_MIN_DELAY * i}ms`),
    //                 NS
    //             );
    //         }
    //     }

    //     // Verify final error and connection state
    //     const err = await connectPromise.catch(e => e);
    //     expect(err.message).toContain(`Failed to connect after ${MAX_SERIAL_CONNECT_ATTEMPTS} attempts`);
    //     expect(err.cause).toBeDefined();
    //     expect(err.cause.message).toBe('Connection failed');
    //     expect(blz.isInitialized()).toBe(false);

    //     // Verify connection attempts were made the correct number of times
    //     expect(serialDriverMock.connect).toHaveBeenCalledTimes(MAX_SERIAL_CONNECT_ATTEMPTS);
    // });

    it("should handle disconnection", async () => {
      serialDriverMock.connect.mockResolvedValue(undefined);
      serialDriverMock.isInitialized.mockReturnValue(true);
      await blz.connect(serialPortOptions);

      await blz.close(true);
      expect(serialDriverMock.close).toHaveBeenCalledWith(true);
    });

    it("should emit close when explicitly closed with emitClose", async () => {
      serialDriverMock.connect.mockResolvedValue(undefined);
      serialDriverMock.isInitialized.mockReturnValue(true);
      const callback = vi.fn();

      await blz.connect(serialPortOptions);
      blz.on("close", callback);

      await blz.close(true);

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("should emit close when explicit close fails in the serial driver", async () => {
      serialDriverMock.connect.mockResolvedValue(undefined);
      serialDriverMock.isInitialized.mockReturnValue(true);
      const callback = vi.fn();

      await blz.connect(serialPortOptions);
      blz.on("close", callback);
      serialDriverMock.close.mockRejectedValue(new Error("close failed"));

      await expect(blz.close(true)).rejects.toThrow("close failed");

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("should detach owned serial driver listeners without broad listener cleanup", async () => {
      serialDriverMock.connect.mockResolvedValue(undefined);
      serialDriverMock.isInitialized.mockReturnValue(true);
      await blz.connect(serialPortOptions);
      serialDriverMock.off.mockClear();
      serialDriverMock.removeAllListeners.mockClear();

      await blz.close(false);

      expect(serialDriverMock.off).toHaveBeenCalledWith("received", expect.any(Function));
      expect(serialDriverMock.off).toHaveBeenCalledWith("close", expect.any(Function));
      expect(serialDriverMock.off).toHaveBeenCalledWith("reset", expect.any(Function));
      expect(serialDriverMock.removeAllListeners).not.toHaveBeenCalled();
    });

    it("should restore serial driver event bridge when reconnecting after close", async () => {
      serialDriverMock.connect.mockResolvedValue(undefined);
      serialDriverMock.isInitialized.mockReturnValue(true);

      await blz.connect(serialPortOptions);
      await blz.close(false);
      await blz.connect(serialPortOptions);

      expect(serialDriverMock.on.mock.calls.filter((call) => call[0] === "received")).toHaveLength(2);
      expect(serialDriverMock.on.mock.calls.filter((call) => call[0] === "close")).toHaveLength(2);
    });

    it("should clear the previous watchdog timer before reconnecting", async () => {
      const clearIntervalSpy = vi.spyOn(global, "clearInterval");
      serialDriverMock.connect.mockResolvedValue(undefined);
      serialDriverMock.isInitialized.mockReturnValue(true);

      await blz.connect(serialPortOptions);
      await blz.connect(serialPortOptions);

      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    });

    it("should close the existing serial driver before reconnecting", async () => {
      serialDriverMock.connect.mockResolvedValue(undefined);
      serialDriverMock.isInitialized
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true);
      serialDriverMock.close.mockResolvedValue(undefined);

      await blz.connect(serialPortOptions);
      await blz.connect(serialPortOptions);

      expect(serialDriverMock.close).toHaveBeenCalledWith(false);
      expect(serialDriverMock.close).toHaveBeenCalledTimes(1);
    });

    it("should clear the previous watchdog timer when closing the existing serial driver fails", async () => {
      const clearIntervalSpy = vi.spyOn(global, "clearInterval");
      serialDriverMock.connect.mockResolvedValue(undefined);
      serialDriverMock.isInitialized
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true);
      serialDriverMock.close.mockRejectedValue(new Error("close failed"));

      await blz.connect(serialPortOptions);

      await expect(blz.connect(serialPortOptions)).rejects.toThrow("close failed");
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    });

    it("should clear the previous watchdog timer when reconnect attempts fail", async () => {
      const clearIntervalSpy = vi.spyOn(global, "clearInterval");
      serialDriverMock.connect.mockResolvedValueOnce(undefined);
      serialDriverMock.isInitialized.mockReturnValue(true);

      await blz.connect(serialPortOptions);

      serialDriverMock.connect.mockRejectedValue(new Error("Connection failed"));
      const reconnect = blz.connect(serialPortOptions);
      const rejection = expect(reconnect).rejects.toThrow("Failed to connect");

      for (let i = 1; i < MAX_SERIAL_CONNECT_ATTEMPTS; i++) {
        await vi.advanceTimersByTimeAsync(
          SERIAL_CONNECT_NEW_ATTEMPT_MIN_DELAY * i,
        );
      }

      await rejection;
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(serialDriverMock.connect).toHaveBeenCalledTimes(
        MAX_SERIAL_CONNECT_ATTEMPTS + 1,
      );
    });

    it("should cancel connection retry waits when closing", async () => {
      serialDriverMock.connect.mockRejectedValue(new Error("Connection failed"));
      serialDriverMock.isInitialized.mockReturnValue(false);
      serialDriverMock.close.mockResolvedValue(undefined);

      const connect = blz.connect(serialPortOptions);
      const connectResult = connect.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );

      await vi.advanceTimersByTimeAsync(0);
      await blz.close(false);
      await vi.advanceTimersByTimeAsync(0);
      const observed = await Promise.race([
        connectResult,
        Promise.resolve("pending"),
      ]);

      for (let i = 1; i < MAX_SERIAL_CONNECT_ATTEMPTS; i++) {
        await vi.advanceTimersByTimeAsync(
          SERIAL_CONNECT_NEW_ATTEMPT_MIN_DELAY * i,
        );
      }

      await connect.catch(() => {});

      expect(observed).toBe("rejected:Connection cancelled by close");
      expect(serialDriverMock.connect).toHaveBeenCalledTimes(1);
      expect(serialDriverMock.off.mock.calls.filter((call) => call[0] === "reset")).toHaveLength(2);
    });

    it("should cancel a pending serial connect attempt when closing", async () => {
      serialDriverMock.connect.mockReturnValue(new Promise<void>(() => {}));
      serialDriverMock.isInitialized.mockReturnValue(false);
      serialDriverMock.close.mockResolvedValue(undefined);

      const connect = blz.connect(serialPortOptions);
      const connectResult = connect.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      await vi.advanceTimersByTimeAsync(0);

      await blz.close(false);
      await vi.advanceTimersByTimeAsync(0);
      const observed = await Promise.race([
        connectResult,
        Promise.resolve("pending"),
      ]);

      expect(observed).toBe("rejected:Connection cancelled by close");
      expect(serialDriverMock.close).toHaveBeenCalledWith(false);
      expect(serialDriverMock.connect).toHaveBeenCalledTimes(1);
    });

    it("should cancel connect while failed-attempt cleanup close is pending", async () => {
      serialDriverMock.connect.mockRejectedValue(new Error("Connection failed"));
      serialDriverMock.isInitialized.mockReturnValue(false);
      serialDriverMock.close.mockReturnValue(new Promise<void>(() => {}));

      const connect = blz.connect(serialPortOptions);
      const connectResult = connect.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      await vi.advanceTimersByTimeAsync(0);

      const close = blz.close(false);
      await vi.advanceTimersByTimeAsync(0);
      const observed = await Promise.race([
        connectResult,
        Promise.resolve("pending"),
      ]);

      void connect.catch(() => {});
      void close.catch(() => {});

      expect(observed).toBe("rejected:Connection cancelled by close");
      expect(serialDriverMock.connect).toHaveBeenCalledTimes(1);
      expect(serialDriverMock.close).toHaveBeenCalledWith(false);
    });

    it("should cancel reconnect while closing the existing serial driver", async () => {
      serialDriverMock.connect.mockResolvedValue(undefined);
      serialDriverMock.isInitialized.mockReturnValue(true);

      await blz.connect(serialPortOptions);

      serialDriverMock.close.mockReturnValue(new Promise<void>(() => {}));
      const reconnect = blz.connect(serialPortOptions);
      const reconnectResult = reconnect.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      await vi.advanceTimersByTimeAsync(0);

      const close = blz.close(false);
      await vi.advanceTimersByTimeAsync(0);
      const observed = await Promise.race([
        reconnectResult,
        Promise.resolve("pending"),
      ]);

      void reconnect.catch(() => {});
      void close.catch(() => {});

      expect(observed).toBe("rejected:Connection cancelled by close");
      expect(serialDriverMock.connect).toHaveBeenCalledTimes(1);
      expect(serialDriverMock.close).toHaveBeenCalledWith(false);
    });

    it("should wait for an in-flight close before reconnecting", async () => {
      let initialized = false;
      const closeResolvers: (() => void)[] = [];
      serialDriverMock.connect.mockImplementation(async () => {
        initialized = true;
      });
      serialDriverMock.close.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            closeResolvers.push(() => {
              initialized = false;
              resolve();
            });
          }),
      );
      serialDriverMock.isInitialized.mockImplementation(() => initialized);

      await blz.connect(serialPortOptions);

      const close = blz.close(false);
      await vi.advanceTimersByTimeAsync(0);
      const reconnect = blz.connect(serialPortOptions);
      await vi.advanceTimersByTimeAsync(0);

      const closeCallsBeforeRelease = serialDriverMock.close.mock.calls.length;
      const connectCallsBeforeRelease = serialDriverMock.connect.mock.calls.length;

      for (const resolveClose of closeResolvers.splice(0)) {
        resolveClose();
      }
      await vi.advanceTimersByTimeAsync(0);
      await Promise.all([close, reconnect]);

      expect(closeCallsBeforeRelease).toBe(1);
      expect(connectCallsBeforeRelease).toBe(1);
      expect(serialDriverMock.connect).toHaveBeenCalledTimes(2);
    });

    it("should emit close when a concurrent explicit close joins an in-flight silent close", async () => {
      let initialized = false;
      let releaseClose: (() => void) | undefined;
      serialDriverMock.connect.mockImplementation(async () => {
        initialized = true;
      });
      serialDriverMock.close.mockReturnValue(
        new Promise<void>((resolve) => {
          releaseClose = () => {
            initialized = false;
            resolve();
          };
        }),
      );
      serialDriverMock.isInitialized.mockImplementation(() => initialized);
      const callback = vi.fn();

      await blz.connect(serialPortOptions);
      blz.on("close", callback);

      const silentClose = blz.close(false);
      await vi.advanceTimersByTimeAsync(0);
      const explicitClose = blz.close(true);
      await vi.advanceTimersByTimeAsync(0);

      releaseClose?.();
      await Promise.all([silentClose, explicitClose]);

      expect(serialDriverMock.close).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("should coalesce concurrent connect attempts", async () => {
      let releaseConnect: (() => void) | undefined;
      serialDriverMock.connect.mockReturnValue(
        new Promise<void>((resolve) => {
          releaseConnect = resolve;
        }),
      );
      serialDriverMock.isInitialized.mockReturnValue(true);

      const firstConnect = blz.connect(serialPortOptions);
      await vi.advanceTimersByTimeAsync(0);
      const secondConnect = blz.connect(serialPortOptions);
      await vi.advanceTimersByTimeAsync(0);

      expect(serialDriverMock.connect).toHaveBeenCalledTimes(1);

      releaseConnect?.();
      await Promise.all([firstConnect, secondConnect]);
    });

    it("should convert reset events during connect into a failed attempt", async () => {
      serialDriverMock.connect.mockReturnValue(new Promise<void>(() => {}));
      serialDriverMock.isInitialized.mockReturnValue(false);
      serialDriverMock.close.mockResolvedValue(undefined);

      const connect = blz.connect(serialPortOptions);
      const connectResult = connect.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      await vi.advanceTimersByTimeAsync(0);

      const resetForReconnect = serialDriverMock.on.mock.calls
        .filter((call) => call[0] === "reset")
        .at(-1)?.[1];

      expect(resetForReconnect).toBeDefined();
      expect(() => resetForReconnect()).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);

      expect(serialDriverMock.close).toHaveBeenCalledWith(false);

      await blz.close(false);
      await vi.advanceTimersByTimeAsync(0);

      await expect(connectResult).resolves.toBe(
        "rejected:Connection cancelled by close",
      );
    });

    it("should close the serial driver before retrying a resolved but uninitialized connection", async () => {
      serialDriverMock.connect.mockResolvedValue(undefined);
      serialDriverMock.isInitialized
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);
      serialDriverMock.close.mockResolvedValue(undefined);

      const connect = blz.connect(serialPortOptions);
      await vi.advanceTimersByTimeAsync(SERIAL_CONNECT_NEW_ATTEMPT_MIN_DELAY);
      await connect;

      expect(serialDriverMock.close).toHaveBeenCalledWith(false);
      expect(serialDriverMock.connect).toHaveBeenCalledTimes(2);
    });

    it("should reset watchdog failures after a successful heartbeat", async () => {
      const reset = vi.fn();
      const watchdog = (
        blz as unknown as {watchdogHandler: () => Promise<void>}
      ).watchdogHandler.bind(blz);
      vi.spyOn(blz, "getVersion")
        .mockRejectedValueOnce(new Error("first miss"))
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("second miss"))
        .mockRejectedValueOnce(new Error("third miss"));

      blz.on("reset", reset);

      await watchdog();
      await watchdog();
      await watchdog();
      await watchdog();

      expect(reset).not.toHaveBeenCalled();
    });

    it("should reset watchdog failures after a successful reconnect", async () => {
      const reset = vi.fn();
      const watchdog = (
        blz as unknown as {watchdogHandler: () => Promise<void>}
      ).watchdogHandler.bind(blz);
      vi.spyOn(blz, "getVersion").mockRejectedValue(new Error("heartbeat miss"));
      serialDriverMock.connect.mockResolvedValue(undefined);
      serialDriverMock.isInitialized.mockReturnValue(true);

      blz.on("reset", reset);

      await watchdog();
      await watchdog();
      await blz.connect(serialPortOptions);
      await watchdog();

      expect(reset).not.toHaveBeenCalled();
    });

    it("should ignore watchdog failures after close interrupts an in-flight heartbeat", async () => {
      let rejectHeartbeat: ((error: Error) => void) | undefined;
      const reset = vi.fn();
      const watchdog = (
        blz as unknown as {watchdogHandler: () => Promise<void>}
      ).watchdogHandler.bind(blz);
      vi.spyOn(blz, "getVersion").mockReturnValue(
        new Promise((_, reject) => {
          rejectHeartbeat = reject;
        }),
      );
      (blz as unknown as {failures: number}).failures = 2;
      serialDriverMock.close.mockResolvedValue(undefined);
      blz.on("reset", reset);

      const run = watchdog();
      await vi.advanceTimersByTimeAsync(0);
      await blz.close(false);
      rejectHeartbeat?.(new Error("heartbeat closed"));
      await run;

      expect(reset).not.toHaveBeenCalled();
    });
  });

  describe("Value operations", () => {
    beforeEach(async () => {
      serialDriverMock.connect.mockResolvedValue(undefined);
      serialDriverMock.isInitialized.mockReturnValue(true);
      await blz.connect(serialPortOptions);
    });

    it("should get value successfully", async () => {
      const mockValue = Buffer.from([1, 2]);

      // Mock successful request with immediate response
      serialDriverMock.sendDATA.mockImplementation(() => {
        // Immediately emit the response after sendDATA is called
        const data = Buffer.alloc(10);
        data.writeUInt16LE(FRAMES.getValue.ID, 2); // frameId
        data[4] = BlzStatus.SUCCESS; // status
        data[5] = mockValue.length; // valueLength
        mockValue.copy(data, 6); // value

        // Find the 'received' event handler and call it with our response
        const receivedHandler = serialDriverMock.on.mock.calls.find(
          (call) => call[0] === "received",
        )?.[1];
        if (receivedHandler) {
          receivedHandler(data);
        }

        return Promise.resolve(undefined);
      });

      // Execute and wait for the response
      const result = await blz.getValue(BlzValueId.BLZ_VALUE_ID_STACK_VERSION);
      expect(result).toEqual(mockValue);
    }, 10000); // Increase timeout for this test

    it("should serialize numeric setValue payloads without zero-fill allocation", async () => {
      const execCommand = vi.spyOn(blz, "execCommand").mockResolvedValue({
        status: BlzStatus.SUCCESS,
      } as BLZFrameData);
      const originalAlloc = Buffer.alloc;
      const allocSpy = vi.spyOn(Buffer, "alloc").mockImplementation(((size: number, ...args: unknown[]) => {
        if (size === 4) {
          throw new Error("Buffer.alloc(4) used");
        }

        return (originalAlloc as (...parameters: unknown[]) => Buffer)(size, ...args);
      }) as typeof Buffer.alloc);

      try {
        await blz.setValue(BlzValueId.BLZ_VALUE_ID_STACK_VERSION, 0x12345678);

        expect(execCommand).toHaveBeenCalledWith("setValue", {
          valueId: BlzValueId.BLZ_VALUE_ID_STACK_VERSION,
          valueLength: 4,
          value: Buffer.from([0x78, 0x56, 0x34, 0x12]),
        });
        expect(allocSpy).not.toHaveBeenCalledWith(4);
      } finally {
        allocSpy.mockRestore();
      }
    });

    it("should not retain waiters for reset commands that do not wait for response", async () => {
      serialDriverMock.sendDATA.mockResolvedValue(undefined);

      await blz.execCommand("reset");

      expect(
        (blz as unknown as {waitress: {waiters: Map<number, unknown>}}).waitress.waiters.size,
      ).toBe(0);
    });

    it("should not throw when matching an unknown numeric frame waiter", () => {
      const result = (
        blz as unknown as {
          waitressValidator: (
            payload: {frameName: string},
            matcher: {frameId: number},
          ) => boolean;
        }
      ).waitressValidator(
        {frameName: "getValue"},
        {frameId: 0xffff},
      );

      expect(result).toBe(false);
    });

    it("should match string frame waiters without array matching churn", () => {
      const includesSpy = vi.spyOn(Array.prototype, "includes").mockImplementation(() => {
        throw new Error("Array.includes used");
      });
      let result = false;

      try {
        result = (
          blz as unknown as {
            waitressValidator: (
              payload: {frameName: string},
              matcher: {frameId: string},
            ) => boolean;
          }
        ).waitressValidator(
          {frameName: "getValue"},
          {frameId: "getValue"},
        );
      } finally {
        includesSpy.mockRestore();
      }

      expect(result).toBe(true);
      expect(includesSpy).not.toHaveBeenCalled();
    });

    it("should not resolve active reset commands after close interrupts lower send", async () => {
      let releaseSend: (() => void) | undefined;
      serialDriverMock.sendDATA.mockReturnValue(
        new Promise<void>((resolve) => {
          releaseSend = resolve;
        }),
      );
      serialDriverMock.close.mockResolvedValue(undefined);

      const command = blz.execCommand("reset");
      const commandResult = command.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      await vi.advanceTimersByTimeAsync(0);

      await blz.close(false);
      releaseSend?.();
      await vi.advanceTimersByTimeAsync(0);

      await expect(commandResult).resolves.toBe("rejected:Connection closed");
    });

    it("should handle send failures before command waiters start", async () => {
      serialDriverMock.sendDATA.mockRejectedValue(new Error("send failed"));

      await expect(
        blz.execCommand("getValue", {
          valueId: BlzValueId.BLZ_VALUE_ID_STACK_VERSION,
        }),
      ).rejects.toThrow("Failure send getValue");
    });
  });

  describe("Event handling", () => {
    beforeEach(async () => {
      serialDriverMock.connect.mockResolvedValue(undefined);
      serialDriverMock.isInitialized.mockReturnValue(true);
      await blz.connect(serialPortOptions);
    });

    it("should handle close events", () => {
      const callback = vi.fn();
      blz.on("close", callback);

      serialDriverMock.on.mock.calls.find((call) => call[0] === "close")?.[1]();
      expect(callback).toHaveBeenCalled();
    });

    it("should ignore malformed received buffers that are too short for a BLZ frame", () => {
      const frame = vi.fn();
      const error = vi.spyOn(logger, "error").mockImplementation(() => {});
      blz.on("frame", frame);

      const receivedHandler = serialDriverMock.on.mock.calls.find(
        (call) => call[0] === "received",
      )?.[1];

      try {
        expect(() => receivedHandler(Buffer.from([0x00, 0x01, 0x02]))).not.toThrow();
        expect(frame).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith(
          "Received malformed BLZ frame: expected at least 6 bytes, received 3",
          NS,
        );
      } finally {
        error.mockRestore();
      }
    });

    it("should ignore received frames that cannot be decoded", () => {
      const frame = vi.fn();
      const error = vi.spyOn(logger, "error").mockImplementation(() => {});
      blz.on("frame", frame);

      const receivedHandler = serialDriverMock.on.mock.calls.find(
        (call) => call[0] === "received",
      )?.[1];
      const data = Buffer.alloc(6);
      data.writeUInt16LE(0xffff, 2);

      try {
        expect(() => receivedHandler(data)).not.toThrow();
        expect(frame).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining("Failed to parse BLZ frame 0xffff"),
          NS,
        );
      } finally {
        error.mockRestore();
      }
    });
  });
});
