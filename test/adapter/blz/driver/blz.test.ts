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

    it("should not retain waiters for reset commands that do not wait for response", async () => {
      serialDriverMock.sendDATA.mockResolvedValue(undefined);

      await blz.execCommand("reset");

      expect(
        (blz as unknown as {waitress: {waiters: Map<number, unknown>}}).waitress.waiters.size,
      ).toBe(0);
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
  });
});
