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
    reset: ReturnType<typeof vi.fn>;
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
      reset: vi.fn(),
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

  const getWatchdog = (): {run: () => Promise<void>; failures: number} =>
    (blz as unknown as {watchdog: {run: () => Promise<void>; failures: number}}).watchdog;

  describe("Connection", () => {
    it("should keep cached version behind defensive snapshots", () => {
      const source = fs.readFileSync("src/adapter/blz/driver/blz.ts", "utf8");
      const waiterSource = fs.readFileSync("src/adapter/blz/driver/blzCommandWaiters.ts", "utf8");
      const watchdogPath = "src/adapter/blz/driver/blzWatchdog.ts";
      expect(fs.existsSync(watchdogPath)).toBe(true);
      const watchdogSource = fs.readFileSync(watchdogPath, "utf8");

      expect(source).toContain("private version:");
      expect(source).not.toContain("public version:");
      expect(source).toContain("private readonly commandWaiters = new BlzCommandWaiters();");
      expect(source).toContain("private readonly watchdog: BlzWatchdog;");
      expect(source).not.toContain("private watchdogTimer");
      expect(source).not.toContain("private failures");
      expect(source).not.toContain("private watchdogGeneration");
      expect(source).not.toContain("private watchdogPromise");
      expect(source).not.toContain("private waitress:");
      expect(source).not.toContain("new Waitress<BLZFrame, BLZWaitressMatcher>");
      expect(source).not.toContain("private waitFor(");
      expect(source).not.toContain("public waitFor(");
      expect(source).not.toContain("cmdSeq");
      expect(source).not.toContain("makeZDOframe(");
      expect(source).not.toContain("setResetingProcess");
      expect(source).not.toContain("BLZZDORequestFrameData");
      expect(source).not.toContain("BLZZDOResponseFrameData");
      expect(source).not.toContain("ZDOREQUESTS");
      expect(source).not.toContain("ZDOREQUEST_NAME_BY_ID");
      expect(source).not.toContain("ZDORESPONSES");
      expect(source).not.toContain("ZDORESPONSE_NAME_BY_ID");
      expect(source).toContain("private isSuccessStatus(status: BlzStatus): boolean");
      expect(source.match(/this\.isSuccessStatus\(/g)).toHaveLength(7);
      expect(source.match(/status !== BlzStatus\.SUCCESS/g) ?? []).toHaveLength(0);
      expect(source.match(/status == BlzStatus\.SUCCESS/g) ?? []).toHaveLength(0);
      expect(source).toContain("private attachSerialDriverResetListener(): void");
      expect(source).toContain("this.attachSerialDriverResetListener();");
      expect(source.match(/this\.serialDriver\.off\("reset", this\.onSerialResetHandler\);/g)).toHaveLength(1);
      expect(source).toContain("private detachSerialDriverEventBridge(): void");
      expect(source).toContain("private detachSerialDriverResetListener(): void");
      expect(source).toContain("this.detachSerialDriverEventBridge();");
      expect(source).toContain("this.detachSerialDriverResetListener();");
      expect(source).toContain("private attachConnectResetListener(listener: () => void): void");
      expect(source).toContain("private detachConnectResetListener(listener: () => void): void");
      expect(source).toContain("private async withConnectResetListener(");
      expect(source).toContain("await this.withConnectResetListener(");
      expect(source).toContain("this.attachConnectResetListener(listener);");
      expect(source).toContain("this.detachConnectResetListener(listener);");
      expect(source).toContain("private async connectWithRetries(");
      expect(source).toContain("() => this.connectWithRetries(options, connectGeneration),");
      expect(source).toContain("private cancelConnectResetOperations(error: Error): void");
      expect(source).toContain("this.cancelConnectResetOperations(this.createFailureToConnectError());");
      expect(source).toContain("private startWatchdogTimer(): void");
      expect(source).toContain("this.watchdog.start();");
      expect(source).toContain("this.watchdog.clear();");
      expect(source).toContain("this.watchdog.resetFailures();");
      expect(source).not.toContain("private async watchdogHandler");
      expect(source).not.toContain("private async performWatchdogHeartbeat");
      expect(source).not.toContain("private isWatchdogGenerationActive");
      expect(watchdogSource).toContain("export class BlzWatchdog");
      expect(watchdogSource).toContain("private timer?: NodeJS.Timeout;");
      expect(watchdogSource).toContain("private generation = 0;");
      expect(watchdogSource).toContain("private failures = 0;");
      expect(watchdogSource).toContain("private heartbeatPromise?: Promise<void>;");
      expect(watchdogSource).toContain("public async run(): Promise<void>");
      expect(source).not.toContain("private cancelWaiter(");
      expect(source).toContain("this.commandWaiters.waitFor(");
      expect(source).toContain("this.commandWaiters.cancel(waiter);");
      expect(source).toContain("this.commandWaiters.resolve(");
      expect(waiterSource).toContain("export class BlzCommandWaiters");
      expect(waiterSource).toContain("private readonly waiters = new WaitressBackedWaiters");
      expect(waiterSource).toContain("public cancel(waiter: BlzCommandWaiter | undefined): void");

      const version = blz.getVersionSnapshot();
      version.product = 99;

      expect(blz.getVersionSnapshot().product).toBe(1);
    });

    it("centralizes connection cancellation cleanup", () => {
      const source = fs.readFileSync("src/adapter/blz/driver/blz.ts", "utf8");

      expect(source).toContain("private cancelConnectionOperations(error: Error): void");
      expect(source.match(/this\.connectGeneration \+= 1;/g)).toHaveLength(1);
      expect(source).toContain("private cancelConnectOperations(error: Error): void");
      expect(source).toContain("this.cancelConnectOperations(error);");
      expect(source.match(/this\.connectOperations\.cancel\(error\);/g)).toHaveLength(1);
      expect(source).toContain("private isConnectGenerationActive(connectGeneration: number): boolean");
      expect(source.match(/this\.isConnectGenerationActive\(connectGeneration\)/g)).toHaveLength(4);
      expect(source.match(/!this\.isConnectCancelled\(connectGeneration\)/g) ?? []).toHaveLength(0);
      expect(source.match(/this\.connectGeneration === connectGeneration/g)).toHaveLength(1);
      expect(source.match(/this\.connectResetOperations\.cancel\(error\);/g)).toHaveLength(1);
      expect(source.match(/this\.cancelConnectResetOperations\(error\);/g)).toHaveLength(1);
      expect(source).toContain("private cancelConnectRetryDelay(): void");
      expect(source).toContain("this.cancelConnectRetryDelay();");
      expect(source.match(/this\.connectRetryDelay\.cancel\(\);/g)).toHaveLength(1);
      expect(source).toContain("private createConnectionCancelledByCloseError(): Error");
      expect(source.match(/this\.createConnectionCancelledByCloseError\(\)/g)).toHaveLength(5);
      expect(source).toContain("private createFailureToConnectError(): Error");
      expect(source.match(/this\.createFailureToConnectError\(\)/g)).toHaveLength(2);
      expect(source.match(/new Error\("Connection cancelled by close"\)/g)).toHaveLength(1);
      expect(source.match(/new Error\("Failure to connect"\)/g)).toHaveLength(1);
    });

    it("centralizes pending command cleanup", () => {
      const source = fs.readFileSync("src/adapter/blz/driver/blz.ts", "utf8");

      expect(source).toContain("private clearPendingCommands(error: Error): void");
      expect(source.match(/this\.queue\.clear\(/g)).toHaveLength(1);
      expect(source.match(/this\.commandWaiters\.clear\(/g)).toHaveLength(1);
    });

    it("should continue connection cleanup when connect operation cancellation fails", () => {
      const cancelError = new Error("connect operation cancel failed");
      const connectOperations = (blz as unknown as {connectOperations: {cancel: (error: Error) => void}}).connectOperations;
      const connectResetOperations = (blz as unknown as {connectResetOperations: {cancel: (error: Error) => void}}).connectResetOperations;
      const connectRetryDelay = (blz as unknown as {connectRetryDelay: {cancel: () => void}}).connectRetryDelay;
      const watchdog = (blz as unknown as {watchdog: {clear: () => void}}).watchdog;
      const connectResetCancel = vi.spyOn(connectResetOperations, "cancel");
      const connectRetryCancel = vi.spyOn(connectRetryDelay, "cancel");
      const watchdogClear = vi.spyOn(watchdog, "clear");
      connectOperations.cancel = vi.fn((): void => {
        throw cancelError;
      });

      expect(() => {
        (blz as unknown as {cancelConnectionOperations: (error: Error) => void}).cancelConnectionOperations(new Error("Connection closed"));
      }).toThrow(cancelError);

      expect(connectResetCancel).toHaveBeenCalledTimes(1);
      expect(connectRetryCancel).toHaveBeenCalledTimes(1);
      expect(watchdogClear).toHaveBeenCalledTimes(1);
    });

    it("centralizes disconnected-state cleanup", () => {
      const source = fs.readFileSync("src/adapter/blz/driver/blz.ts", "utf8");

      expect(source).toContain("private enterDisconnectedState(connectionError: Error, commandError = connectionError): void");
      expect(source).toContain("private cleanupAfterSerialDriverEvent(connectionError: Error, commandError = connectionError): void");
      expect(source).toContain("this.cleanupAfterSerialDriverEvent(this.createConnectionResetError());");
      expect(source).toContain("this.cleanupAfterSerialDriverEvent(this.createConnectionClosedError());");
      expect(source).toContain("this.enterDisconnectedState(connectionCancelError, closeError);");
      expect(source.match(/this\.detachSerialDriverListeners\(\);/g)).toHaveLength(2);
      expect(source.match(/this\.cancelConnectionOperations\(connectionError\);/g)).toHaveLength(1);
      expect(source).toContain("private createConnectionClosedError(): Error");
      expect(source.match(/this\.createConnectionClosedError\(\)/g)).toHaveLength(4);
      expect(source).toContain("private createConnectionResetError(): Error");
      expect(source.match(/this\.createConnectionResetError\(\)/g)).toHaveLength(2);
      expect(source.match(/new Error\("Connection closed"\)/g)).toHaveLength(1);
      expect(source.match(/new Error\("Connection reset"\)/g)).toHaveLength(1);
    });

    it("centralizes serial runtime cleanup without cancelling connect generation", () => {
      const source = fs.readFileSync("src/adapter/blz/driver/blz.ts", "utf8");

      expect(source).toContain("private clearSerialRuntimeState(error: Error): void");
      expect(source).toContain("private captureSerialRuntimeCleanup(error: Error): unknown");
      expect(source).toContain("this.captureSerialRuntimeCleanup(reconnectError);");
      expect(source).toContain("this.captureSerialRuntimeCleanup(connectFailureError);");
      expect(source.match(/this\.clearWatchdogTimer\(\);/g)).toHaveLength(2);
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

    it("should continue serial close cleanup when event bridge detach fails", async () => {
      serialDriverMock.connect.mockResolvedValue(undefined);
      serialDriverMock.isInitialized.mockReturnValue(true);
      await blz.connect(serialPortOptions);
      serialDriverMock.off.mockClear();
      serialDriverMock.close.mockClear();
      serialDriverMock.off.mockImplementation((event: string) => {
        if (event === "received") {
          throw new Error("received listener detach failed");
        }
      });

      await expect(blz.close(false)).rejects.toThrow("received listener detach failed");

      expect(serialDriverMock.off).toHaveBeenCalledWith("received", expect.any(Function));
      expect(serialDriverMock.off).toHaveBeenCalledWith("close", expect.any(Function));
      expect(serialDriverMock.off).toHaveBeenCalledWith("reset", expect.any(Function));
      expect(serialDriverMock.close).toHaveBeenCalledWith(false);
      expect(serialDriverMock.removeAllListeners).not.toHaveBeenCalled();
      expect((blz as unknown as {serialDriverEventBridgeAttached: boolean}).serialDriverEventBridgeAttached).toBe(false);
      expect((blz as unknown as {serialDriverResetListenerAttached: boolean}).serialDriverResetListenerAttached).toBe(false);
    });

    it("should detach serial driver listeners when command waiter cleanup fails", async () => {
      const cleanupError = new Error("command waiter cleanup failed");
      serialDriverMock.connect.mockResolvedValue(undefined);
      serialDriverMock.isInitialized.mockReturnValue(true);
      await blz.connect(serialPortOptions);
      serialDriverMock.off.mockClear();
      serialDriverMock.close.mockClear();
      const commandWaiters = (
        blz as unknown as {
          commandWaiters: {clear: (error: Error) => void};
        }
      ).commandWaiters;
      const originalClear = commandWaiters.clear.bind(commandWaiters);
      commandWaiters.clear = vi.fn((error: Error): void => {
        originalClear(error);
        throw cleanupError;
      });

      const error = await blz.close(false).catch((caught: unknown) => caught);

      expect(error).toBe(cleanupError);
      expect(serialDriverMock.off).toHaveBeenCalledWith("received", expect.any(Function));
      expect(serialDriverMock.off).toHaveBeenCalledWith("close", expect.any(Function));
      expect(serialDriverMock.off).toHaveBeenCalledWith("reset", expect.any(Function));
      expect(serialDriverMock.close).toHaveBeenCalledWith(false);
      expect((blz as unknown as {serialDriverEventBridgeAttached: boolean}).serialDriverEventBridgeAttached).toBe(false);
      expect((blz as unknown as {serialDriverResetListenerAttached: boolean}).serialDriverResetListenerAttached).toBe(false);
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

    it("should detach partially attached serial event bridge when reconnect listener attach fails", async () => {
      serialDriverMock.connect.mockResolvedValue(undefined);
      serialDriverMock.close.mockResolvedValue(undefined);
      serialDriverMock.isInitialized.mockReturnValue(true);

      await blz.connect(serialPortOptions);
      await blz.close(false);
      serialDriverMock.off.mockClear();
      serialDriverMock.on.mockImplementation((event: string) => {
        if (event === "close") {
          throw new Error("close bridge failed");
        }
      });

      await expect(blz.connect(serialPortOptions)).rejects.toThrow("close bridge failed");

      expect(serialDriverMock.off).toHaveBeenCalledWith("received", expect.any(Function));
      expect(serialDriverMock.off.mock.calls.filter((call) => call[0] === "close")).toHaveLength(0);
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

    it("should close the existing serial driver when reconnect runtime cleanup fails", async () => {
      const cleanupError = new Error("reconnect runtime cleanup failed");
      const queue = (blz as unknown as {queue: {clear: (error: Error) => void}}).queue;
      serialDriverMock.connect.mockResolvedValue(undefined);
      serialDriverMock.isInitialized
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true);
      serialDriverMock.close.mockResolvedValue(undefined);

      await blz.connect(serialPortOptions);
      queue.clear = vi.fn((): void => {
        throw cleanupError;
      });

      await expect(blz.connect(serialPortOptions)).rejects.toThrow(cleanupError);

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

    it("should detach the serial event bridge when connect attempts fail", async () => {
      serialDriverMock.connect.mockRejectedValue(new Error("Connection failed"));
      serialDriverMock.isInitialized.mockReturnValue(false);
      serialDriverMock.close.mockResolvedValue(undefined);

      const connect = blz.connect(serialPortOptions);
      const rejection = expect(connect).rejects.toThrow("Failed to connect");

      for (let i = 1; i < MAX_SERIAL_CONNECT_ATTEMPTS; i++) {
        await vi.advanceTimersByTimeAsync(
          SERIAL_CONNECT_NEW_ATTEMPT_MIN_DELAY * i,
        );
      }

      await rejection;

      expect(serialDriverMock.off).toHaveBeenCalledWith("received", expect.any(Function));
      expect(serialDriverMock.off).toHaveBeenCalledWith("close", expect.any(Function));
      expect(serialDriverMock.removeAllListeners).not.toHaveBeenCalled();
    });

    it("should report both connect and connect-reset listener cleanup failures", async () => {
      const detachError = new Error("connect reset detach failed");
      serialDriverMock.connect.mockRejectedValue(new Error("Connection failed"));
      serialDriverMock.isInitialized.mockReturnValue(false);
      serialDriverMock.close.mockResolvedValue(undefined);
      serialDriverMock.off.mockImplementation((event: string) => {
        if (event === "reset") {
          throw detachError;
        }
      });

      const connect = blz.connect(serialPortOptions).catch((error: unknown) => error);

      for (let i = 1; i < MAX_SERIAL_CONNECT_ATTEMPTS; i++) {
        await vi.advanceTimersByTimeAsync(
          SERIAL_CONNECT_NEW_ATTEMPT_MIN_DELAY * i,
        );
      }

      const error = await connect;

      expect(error).toBeInstanceOf(AggregateError);
      const aggregateError = error as AggregateError;
      expect((aggregateError.errors[0] as Error).message).toBe(
        `Failed to connect after ${MAX_SERIAL_CONNECT_ATTEMPTS} attempts`,
      );
      expect(aggregateError.errors[1]).toBe(detachError);
      expect(serialDriverMock.off).toHaveBeenCalledWith("reset", expect.any(Function));
      expect(serialDriverMock.off).toHaveBeenCalledWith("received", expect.any(Function));
      expect(serialDriverMock.off).toHaveBeenCalledWith("close", expect.any(Function));
    });

    it("should report both connect and serial listener cleanup failures", async () => {
      const detachError = new Error("received listener detach failed");
      serialDriverMock.connect.mockRejectedValue(new Error("Connection failed"));
      serialDriverMock.isInitialized.mockReturnValue(false);
      serialDriverMock.close.mockResolvedValue(undefined);
      serialDriverMock.off.mockImplementation((event: string) => {
        if (event === "received") {
          throw detachError;
        }
      });

      const connect = blz.connect(serialPortOptions).catch((error: unknown) => error);

      for (let i = 1; i < MAX_SERIAL_CONNECT_ATTEMPTS; i++) {
        await vi.advanceTimersByTimeAsync(
          SERIAL_CONNECT_NEW_ATTEMPT_MIN_DELAY * i,
        );
      }

      const error = await connect;

      expect(error).toBeInstanceOf(AggregateError);
      const aggregateError = error as AggregateError;
      expect((aggregateError.errors[0] as Error).message).toBe(
        `Failed to connect after ${MAX_SERIAL_CONNECT_ATTEMPTS} attempts`,
      );
      expect(aggregateError.errors[1]).toBe(detachError);
      expect(serialDriverMock.off).toHaveBeenCalledWith("reset", expect.any(Function));
      expect(serialDriverMock.off).toHaveBeenCalledWith("received", expect.any(Function));
      expect(serialDriverMock.off).toHaveBeenCalledWith("close", expect.any(Function));
    });

    it("should detach the existing serial reset listener when reconnect attempts fail", async () => {
      let initialized = false;
      serialDriverMock.connect.mockImplementation(() => {
        initialized = true;
        return Promise.resolve();
      });
      serialDriverMock.close.mockImplementation(() => {
        initialized = false;
        return Promise.resolve();
      });
      serialDriverMock.isInitialized.mockImplementation(() => initialized);

      await blz.connect(serialPortOptions);
      const runtimeResetHandler = serialDriverMock.on.mock.calls
        .filter((call) => call[0] === "reset")
        .at(-1)?.[1];
      serialDriverMock.connect.mockRejectedValue(new Error("Connection failed"));
      serialDriverMock.off.mockClear();

      const reconnect = blz.connect(serialPortOptions);
      const rejection = expect(reconnect).rejects.toThrow("Failed to connect");

      for (let i = 1; i < MAX_SERIAL_CONNECT_ATTEMPTS; i++) {
        await vi.advanceTimersByTimeAsync(
          SERIAL_CONNECT_NEW_ATTEMPT_MIN_DELAY * i,
        );
      }

      await rejection;

      expect(runtimeResetHandler).toBeDefined();
      expect(serialDriverMock.off).toHaveBeenCalledWith("reset", runtimeResetHandler);
      expect(serialDriverMock.removeAllListeners).not.toHaveBeenCalled();
    });

    it("should preserve failed-attempt cleanup when connect errors cannot expose a message", async () => {
      const errorLog = vi.spyOn(logger, "error").mockImplementation(() => {});
      const connectError = new Error("Connection failed");
      Object.defineProperty(connectError, "message", {
        configurable: true,
        get: () => {
          throw new Error("connect message stringification failed");
        },
      });
      serialDriverMock.connect.mockRejectedValue(connectError);
      serialDriverMock.isInitialized.mockReturnValue(false);
      serialDriverMock.close.mockResolvedValue(undefined);

      const connect = blz
        .connect(serialPortOptions)
        .catch((caught: Error) => caught);

      for (let i = 1; i < MAX_SERIAL_CONNECT_ATTEMPTS; i++) {
        await vi.advanceTimersByTimeAsync(
          SERIAL_CONNECT_NEW_ATTEMPT_MIN_DELAY * i,
        );
      }

      const error = await connect;

      expect(error.message).toBe(
        `Failed to connect after ${MAX_SERIAL_CONNECT_ATTEMPTS} attempts`,
      );
      expect(error.cause).toBe(connectError);
      expect(serialDriverMock.connect).toHaveBeenCalledTimes(
        MAX_SERIAL_CONNECT_ATTEMPTS,
      );
      expect(serialDriverMock.close).toHaveBeenCalledTimes(
        MAX_SERIAL_CONNECT_ATTEMPTS,
      );
      expect(errorLog).toHaveBeenCalledWith(expect.any(Function), NS);
    });

    it("should close the serial driver when failed-attempt runtime cleanup fails", async () => {
      const cleanupError = new Error("runtime cleanup failed");
      const queue = (blz as unknown as {queue: {clear: (error: Error) => void}}).queue;
      queue.clear = vi.fn((): void => {
        throw cleanupError;
      });
      serialDriverMock.close.mockResolvedValue(undefined);

      await expect(
        (blz as unknown as {cleanupFailedConnectAttempt: (connectGeneration: number) => Promise<void>}).cleanupFailedConnectAttempt(0),
      ).rejects.toThrow(cleanupError);

      expect(serialDriverMock.close).toHaveBeenCalledWith(false);
    });

    it("should preserve failed-attempt cleanup when non-error connect failures cannot be stringified", async () => {
      vi.spyOn(logger, "error").mockImplementation(() => {});
      const connectFailure = {
        toString: () => {
          throw new Error("connect object stringification failed");
        },
      };
      serialDriverMock.connect.mockRejectedValue(connectFailure);
      serialDriverMock.isInitialized.mockReturnValue(false);
      serialDriverMock.close.mockResolvedValue(undefined);

      const connect = blz
        .connect(serialPortOptions)
        .catch((caught: Error) => caught);

      for (let i = 1; i < MAX_SERIAL_CONNECT_ATTEMPTS; i++) {
        await vi.advanceTimersByTimeAsync(
          SERIAL_CONNECT_NEW_ATTEMPT_MIN_DELAY * i,
        );
      }

      const error = await connect;
      const cause = error.cause as Error & { cause?: unknown };

      expect(error.message).toBe(
        `Failed to connect after ${MAX_SERIAL_CONNECT_ATTEMPTS} attempts`,
      );
      expect(cause.message).toBe("<unprintable error>");
      expect(cause.cause).toBe(connectFailure);
      expect(serialDriverMock.connect).toHaveBeenCalledTimes(
        MAX_SERIAL_CONNECT_ATTEMPTS,
      );
      expect(serialDriverMock.close).toHaveBeenCalledTimes(
        MAX_SERIAL_CONNECT_ATTEMPTS,
      );
    });

    it("should preserve connect retry handling when failed-attempt close errors cannot be stringified", async () => {
      const closeError = new Error("close failed");
      closeError.toString = () => {
        throw new Error("close stringification failed");
      };
      vi.spyOn(console, "debug").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      serialDriverMock.connect.mockRejectedValue(new Error("Connection failed"));
      serialDriverMock.isInitialized.mockReturnValue(false);
      serialDriverMock.close.mockRejectedValue(closeError);

      const connect = blz
        .connect(serialPortOptions)
        .catch((caught: Error) => caught);

      for (let i = 1; i < MAX_SERIAL_CONNECT_ATTEMPTS; i++) {
        await vi.advanceTimersByTimeAsync(
          SERIAL_CONNECT_NEW_ATTEMPT_MIN_DELAY * i,
        );
      }

      const error = await connect;

      expect(error.message).toBe(
        `Failed to connect after ${MAX_SERIAL_CONNECT_ATTEMPTS} attempts`,
      );
      expect((error.cause as Error).message).toBe("Connection failed");
      expect(serialDriverMock.connect).toHaveBeenCalledTimes(
        MAX_SERIAL_CONNECT_ATTEMPTS,
      );
      expect(serialDriverMock.close).toHaveBeenCalledTimes(
        MAX_SERIAL_CONNECT_ATTEMPTS,
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
      expect(serialDriverMock.off.mock.calls.filter((call) => call[0] === "reset")).toHaveLength(1);
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
      const watchdogState = getWatchdog();
      const watchdog = watchdogState.run.bind(watchdogState);
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
      const watchdogState = getWatchdog();
      const watchdog = watchdogState.run.bind(watchdogState);
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

    it("should preserve watchdog reset handling when heartbeat errors cannot be stringified", async () => {
      const reset = vi.fn();
      const watchdogState = getWatchdog();
      const watchdog = watchdogState.run.bind(watchdogState);
      const heartbeatError = new Error("heartbeat miss");
      heartbeatError.toString = () => {
        throw new Error("heartbeat stringification failed");
      };
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(blz, "getVersion").mockRejectedValue(heartbeatError);
      watchdogState.failures = 2;
      blz.on("reset", reset);

      await expect(watchdog()).resolves.toBeUndefined();

      expect(reset).toHaveBeenCalledTimes(1);
      expect(watchdogState.failures).toBe(0);
    });

    it("should ignore watchdog failures after close interrupts an in-flight heartbeat", async () => {
      let rejectHeartbeat: ((error: Error) => void) | undefined;
      const reset = vi.fn();
      const watchdogState = getWatchdog();
      const watchdog = watchdogState.run.bind(watchdogState);
      vi.spyOn(blz, "getVersion").mockReturnValue(
        new Promise((_, reject) => {
          rejectHeartbeat = reject;
        }),
      );
      watchdogState.failures = 2;
      serialDriverMock.close.mockResolvedValue(undefined);
      blz.on("reset", reset);

      const run = watchdog();
      await vi.advanceTimersByTimeAsync(0);
      await blz.close(false);
      rejectHeartbeat?.(new Error("heartbeat closed"));
      await run;

      expect(reset).not.toHaveBeenCalled();
    });

    it("should skip overlapping watchdog heartbeats", async () => {
      let finishHeartbeat: (() => void) | undefined;
      const watchdogState = getWatchdog();
      const watchdog = watchdogState.run.bind(watchdogState);
      const getVersion = vi.spyOn(blz, "getVersion")
        .mockReturnValueOnce(
          new Promise<void>((resolve) => {
            finishHeartbeat = resolve;
          }),
        )
        .mockResolvedValueOnce(undefined);

      const firstHeartbeat = watchdog();
      await vi.advanceTimersByTimeAsync(0);
      await watchdog();

      expect(getVersion).toHaveBeenCalledTimes(1);

      finishHeartbeat?.();
      await firstHeartbeat;
      await watchdog();

      expect(getVersion).toHaveBeenCalledTimes(2);
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

    it("should reject getValue when the command status is not success", async () => {
      vi.spyOn(blz, "execCommand").mockResolvedValue({
        status: BlzStatus.GENERAL_ERROR,
        value: Buffer.from([1, 2]),
      } as BLZFrameData);

      await expect(
        blz.getValue(BlzValueId.BLZ_VALUE_ID_STACK_VERSION),
      ).rejects.toThrow("Failed to get value BLZ_VALUE_ID_STACK_VERSION: status 1");
    });

    it("should preserve getValue status failures when the result cannot be JSON stringified", async () => {
      vi.spyOn(logger, "error").mockImplementation(() => {});
      vi.spyOn(blz, "execCommand").mockResolvedValue({
        status: BlzStatus.GENERAL_ERROR,
        value: Buffer.from([1, 2]),
        toJSON: () => {
          throw new Error("getValue result stringification failed");
        },
      } as unknown as BLZFrameData);

      await expect(
        blz.getValue(BlzValueId.BLZ_VALUE_ID_STACK_VERSION),
      ).rejects.toThrow("Failed to get value BLZ_VALUE_ID_STACK_VERSION: status 1");
    });

    it("should not stringify network command results unless debug logging evaluates the message", async () => {
      const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
      const networkInitResult = {status: BlzStatus.SUCCESS};
      const leaveNetworkResult = {status: BlzStatus.SUCCESS};
      vi.spyOn(blz, "execCommand")
        .mockResolvedValueOnce(networkInitResult as BLZFrameData)
        .mockResolvedValueOnce(leaveNetworkResult as BLZFrameData);
      const stringify = vi.spyOn(JSON, "stringify").mockImplementation((value: unknown) => {
        if (value === networkInitResult || value === leaveNetworkResult) {
          throw new Error("eager network command result stringify");
        }

        return "{}";
      });

      try {
        await expect(blz.networkInit()).resolves.toBe(true);
        await expect(blz.leaveNetwork()).resolves.toBe(BlzStatus.SUCCESS);

        expect(debug).toHaveBeenCalledWith(
          expect.any(Function),
          expect.any(String),
        );
      } finally {
        stringify.mockRestore();
        debug.mockRestore();
      }
    });

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

    it("should not stringify setValue buffers unless debug logging evaluates the message", async () => {
      const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
      const value = Buffer.from([0xaa, 0xbb]);
      const toStringSpy = vi.spyOn(value, "toString").mockImplementation(() => {
        throw new Error("eager setValue buffer string");
      });
      const execCommand = vi.spyOn(blz, "execCommand").mockResolvedValue({
        status: BlzStatus.SUCCESS,
      } as BLZFrameData);

      try {
        await blz.setValue(BlzValueId.BLZ_VALUE_ID_STACK_VERSION, value);

        expect(execCommand).toHaveBeenCalledWith("setValue", {
          valueId: BlzValueId.BLZ_VALUE_ID_STACK_VERSION,
          valueLength: value.length,
          value,
        });
        expect(debug).toHaveBeenCalledWith(expect.any(Function), expect.any(String));
      } finally {
        toStringSpy.mockRestore();
        debug.mockRestore();
      }
    });

    it("should reject setValue when the command status is not success", async () => {
      vi.spyOn(blz, "execCommand").mockResolvedValue({
        status: BlzStatus.GENERAL_ERROR,
      } as BLZFrameData);

      await expect(
        blz.setValue(BlzValueId.BLZ_VALUE_ID_STACK_VERSION, 0x12345678),
      ).rejects.toThrow("Failed to set value BLZ_VALUE_ID_STACK_VERSION: status 1");
    });

    it("should preserve setValue status failures when the result cannot be JSON stringified", async () => {
      vi.spyOn(logger, "error").mockImplementation(() => {});
      vi.spyOn(blz, "execCommand").mockResolvedValue({
        status: BlzStatus.GENERAL_ERROR,
        toJSON: () => {
          throw new Error("setValue result stringification failed");
        },
      } as unknown as BLZFrameData);

      await expect(
        blz.setValue(BlzValueId.BLZ_VALUE_ID_STACK_VERSION, 0x12345678),
      ).rejects.toThrow("Failed to set value BLZ_VALUE_ID_STACK_VERSION: status 1");
    });

    it("should preserve leave network status failures when the result cannot be JSON stringified", async () => {
      vi.spyOn(logger, "debug").mockImplementation(() => {});
      vi.spyOn(blz, "execCommand").mockResolvedValue({
        status: BlzStatus.GENERAL_ERROR,
        toJSON: () => {
          throw new Error("leave network result stringification failed");
        },
      } as unknown as BLZFrameData);

      await expect(blz.leaveNetwork()).rejects.toThrow("Failure to leave network: status 1");
    });

    it("should preserve form network status failures when the result cannot be JSON stringified", async () => {
      vi.spyOn(logger, "error").mockImplementation(() => {});
      vi.spyOn(blz, "execCommand").mockResolvedValue({
        status: BlzStatus.GENERAL_ERROR,
        toJSON: () => {
          throw new Error("form network result stringification failed");
        },
      } as unknown as BLZFrameData);

      await expect(
        blz.formNetwork(
          0 as unknown as Parameters<Blz["formNetwork"]>[0],
          0x1234 as unknown as Parameters<Blz["formNetwork"]>[1],
          11 as unknown as Parameters<Blz["formNetwork"]>[2],
        ),
      ).rejects.toThrow("Failure forming network: status 1");
    });

    it("should not retain waiters for reset commands that do not wait for response", async () => {
      serialDriverMock.sendDATA.mockResolvedValue(undefined);

      await blz.execCommand("reset");

      expect(
        (blz as unknown as {commandWaiters: {count: () => number}}).commandWaiters.count(),
      ).toBe(0);
    });

    it("should not throw when matching an unknown numeric frame waiter", () => {
      const result = (
        blz as unknown as {
          commandWaiters: {
            matches: (
            payload: {frameName: string},
            matcher: {frameId: number},
          ) => boolean;
          };
        }
      ).commandWaiters.matches(
        {frameName: "getValue"},
        {frameId: 0xffff},
      );

      expect(result).toBe(false);
    });

    it("should reject unknown numeric frame waiters without empty array matching churn", () => {
      const includesSpy = vi.spyOn(Array.prototype, "includes").mockImplementation(() => {
        throw new Error("Array.includes used");
      });
      let result = true;

      try {
        result = (
          blz as unknown as {
            commandWaiters: {
              matches: (
              payload: {frameName: string},
              matcher: {frameId: number},
            ) => boolean;
            };
          }
        ).commandWaiters.matches(
          {frameName: "getValue"},
          {frameId: 0xffff},
        );
      } finally {
        includesSpy.mockRestore();
      }

      expect(result).toBe(false);
      expect(includesSpy).not.toHaveBeenCalled();
    });

    it("should match string frame waiters without array matching churn", () => {
      const includesSpy = vi.spyOn(Array.prototype, "includes").mockImplementation(() => {
        throw new Error("Array.includes used");
      });
      let result = false;

      try {
        result = (
          blz as unknown as {
            commandWaiters: {
              matches: (
              payload: {frameName: string},
              matcher: {frameId: string},
            ) => boolean;
            };
          }
        ).commandWaiters.matches(
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

    it("should cancel active commands before forcing a UART reset", async () => {
      serialDriverMock.sendDATA.mockReturnValue(new Promise<void>(() => {}));
      serialDriverMock.reset.mockResolvedValue(undefined);

      const command = blz.execCommand("getValue", {
        valueId: BlzValueId.BLZ_VALUE_ID_STACK_VERSION,
      });
      const commandResult = command.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      await vi.advanceTimersByTimeAsync(0);

      await blz.forceReset();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      const observed = await Promise.race([
        commandResult,
        Promise.resolve("pending"),
      ]);

      void command.catch(() => {});

      expect(observed).toBe("rejected:Connection reset");
    });

    it("should not force reset after close interrupts the connection", async () => {
      serialDriverMock.close.mockResolvedValue(undefined);
      serialDriverMock.reset.mockResolvedValue(undefined);
      serialDriverMock.isInitialized.mockImplementationOnce(() => {
        void blz.close(false);
        return true;
      });

      await expect(blz.forceReset()).rejects.toThrow("Connection closed");

      expect(serialDriverMock.reset).not.toHaveBeenCalled();
    });

    it("should preserve direct UART reset failures that cannot be stringified", async () => {
      const resetError = new Error("uart reset failed");
      resetError.toString = () => {
        throw new Error("reset stringification failed");
      };
      vi.spyOn(console, "error").mockImplementation(() => {});
      serialDriverMock.isInitialized.mockReturnValue(true);
      serialDriverMock.reset.mockRejectedValue(resetError);

      await expect(blz.forceReset()).rejects.toBe(resetError);

      expect((blz as unknown as {inResetingProcess: boolean}).inResetingProcess).toBe(false);
    });

    it("should restore reset state when force reset cleanup fails before UART reset", async () => {
      const cleanupError = new Error("pending command cleanup failed");
      serialDriverMock.isInitialized.mockReturnValue(true);
      vi.spyOn(
        blz as unknown as {clearPendingCommands: (error: Error) => void},
        "clearPendingCommands",
      ).mockImplementation(() => {
        throw cleanupError;
      });

      await expect(blz.forceReset()).rejects.toBe(cleanupError);

      expect(serialDriverMock.reset).not.toHaveBeenCalled();
      expect((blz as unknown as {inResetingProcess: boolean}).inResetingProcess).toBe(false);
    });

    it("should handle send failures before command waiters start", async () => {
      const sendError = new Error("send failed");
      serialDriverMock.sendDATA.mockRejectedValue(sendError);

      const command = blz.execCommand("getValue", {
        valueId: BlzValueId.BLZ_VALUE_ID_STACK_VERSION,
      });

      await expect(command).rejects.toThrow("Failure send getValue");
      await expect(command).rejects.toHaveProperty("cause", sendError);
    });

    it("should preserve send failures when frame data cannot be JSON stringified", async () => {
      const sendError = new Error("send failed");
      let sentData: Buffer | undefined;
      serialDriverMock.sendDATA.mockImplementation((data: Buffer) => {
        sentData = data;
        Object.defineProperty(data, "toJSON", {
          configurable: true,
          value: () => {
            throw new Error("frame data stringification failed");
          },
        });
        return Promise.reject(sendError);
      });

      let rejection: unknown;
      try {
        await blz.execCommand("getValue", {
          valueId: BlzValueId.BLZ_VALUE_ID_STACK_VERSION,
        });
      } catch (error) {
        rejection = error;
      } finally {
        if (sentData) {
          Reflect.deleteProperty(sentData, "toJSON");
        }
      }

      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toContain("Failure send getValue");
      expect(rejection).toHaveProperty("cause", sendError);
    });
  });

  describe("Event handling", () => {
    beforeEach(async () => {
      serialDriverMock.connect.mockResolvedValue(undefined);
      serialDriverMock.isInitialized.mockReturnValue(true);
      await blz.connect(serialPortOptions);
    });

    const waitForCommandResponse = (): {
      start: () => { promise: Promise<unknown>; ID: number };
      ID: number;
    } =>
      (
        blz as unknown as {
          commandWaiters: {
            waitFor: (
            frameId: string,
            timeout?: number,
          ) => { start: () => { promise: Promise<unknown>; ID: number }; ID: number };
          };
        }
      ).commandWaiters.waitFor("getValue", 1000);

    it("should handle close events", () => {
      const callback = vi.fn();
      blz.on("close", callback);

      serialDriverMock.on.mock.calls.find((call) => call[0] === "close")?.[1]();
      expect(callback).toHaveBeenCalled();
    });

    it("should clear BLZ waiters with the close reason on serial driver close", async () => {
      const waiter = waitForCommandResponse();
      const waiterResult = waiter.start().promise.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );

      serialDriverMock.on.mock.calls.find((call) => call[0] === "close")?.[1]();
      const observed = await Promise.race([
        waiterResult,
        new Promise((resolve) => setImmediate(() => resolve("pending"))),
      ]);

      expect(observed).toBe("rejected:Connection closed");
    });

    it("should clear BLZ waiters with the reset reason on serial driver reset", async () => {
      const waiter = waitForCommandResponse();
      const waiterResult = waiter.start().promise.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      const resetHandler = serialDriverMock.on.mock.calls
        .filter((call) => call[0] === "reset")
        .at(-1)?.[1];

      expect(resetHandler).toBeDefined();
      resetHandler();
      const observed = await Promise.race([
        waiterResult,
        new Promise((resolve) => setImmediate(() => resolve("pending"))),
      ]);

      expect(observed).toBe("rejected:Connection reset");
    });

    it("should clear BLZ waiters with the close reason when closing", async () => {
      const waiter = waitForCommandResponse();
      const waiterResult = waiter.start().promise.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );

      await blz.close(false);
      const observed = await Promise.race([
        waiterResult,
        Promise.resolve("pending"),
      ]);

      expect(observed).toBe("rejected:Connection closed");
    });

    it("should clear BLZ waiters with the reset reason when forcing reset", async () => {
      serialDriverMock.reset.mockResolvedValue(undefined);
      const waiter = waitForCommandResponse();
      const waiterResult = waiter.start().promise.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );

      await blz.forceReset();
      const observed = await Promise.race([
        waiterResult,
        Promise.resolve("pending"),
      ]);

      expect(observed).toBe("rejected:Connection reset");
    });

    it("should release reset close suppression after a successful standalone force reset", async () => {
      const callback = vi.fn();
      blz.on("close", callback);
      serialDriverMock.reset.mockResolvedValue(undefined);

      await blz.forceReset();
      serialDriverMock.on.mock.calls.find((call) => call[0] === "close")?.[1]();

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("should suppress serial close events while force reset owns the reset state", async () => {
      const callback = vi.fn();
      blz.on("close", callback);
      serialDriverMock.reset.mockImplementation(async () => {
        serialDriverMock.on.mock.calls.find((call) => call[0] === "close")?.[1]();
      });

      await expect(blz.forceReset()).rejects.toThrow("Connection closed");

      expect(callback).not.toHaveBeenCalled();
    });

    it("should clear BLZ state when the serial driver closes unexpectedly", async () => {
      const clearIntervalSpy = vi.spyOn(global, "clearInterval");
      serialDriverMock.sendDATA.mockReturnValue(new Promise<void>(() => {}));
      const command = blz.execCommand("getValue", {
        valueId: BlzValueId.BLZ_VALUE_ID_STACK_VERSION,
      });
      const commandResult = command.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      await vi.advanceTimersByTimeAsync(0);

      serialDriverMock.on.mock.calls.find((call) => call[0] === "close")?.[1]();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      const observed = await Promise.race([
        commandResult,
        Promise.resolve("pending"),
      ]);

      void command.catch(() => {});

      expect(observed).toBe("rejected:Connection closed");
      expect(clearIntervalSpy).toHaveBeenCalled();
      expect(
        (blz as unknown as {commandWaiters: {count: () => number}}).commandWaiters.count(),
      ).toBe(0);
    });

    it("should emit close and release listener ownership when serial close cleanup fails", () => {
      const callback = vi.fn();
      blz.on("close", callback);
      serialDriverMock.off.mockImplementation((event: string) => {
        if (event === "received") {
          throw new Error("received listener detach failed");
        }
      });
      const closeHandler = serialDriverMock.on.mock.calls.find((call) => call[0] === "close")?.[1];

      expect(closeHandler).toBeDefined();
      expect(() => closeHandler()).not.toThrow();

      expect(serialDriverMock.off).toHaveBeenCalledWith("received", expect.any(Function));
      expect(serialDriverMock.off).toHaveBeenCalledWith("close", expect.any(Function));
      expect(serialDriverMock.off).toHaveBeenCalledWith("reset", expect.any(Function));
      expect((blz as unknown as {serialDriverEventBridgeAttached: boolean}).serialDriverEventBridgeAttached).toBe(false);
      expect((blz as unknown as {serialDriverResetListenerAttached: boolean}).serialDriverResetListenerAttached).toBe(false);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("should clear BLZ state when the serial driver requests reset recovery", async () => {
      const clearIntervalSpy = vi.spyOn(global, "clearInterval");
      const reset = vi.fn();
      serialDriverMock.sendDATA.mockReturnValue(new Promise<void>(() => {}));
      blz.on("reset", reset);
      const command = blz.execCommand("getValue", {
        valueId: BlzValueId.BLZ_VALUE_ID_STACK_VERSION,
      });
      const commandResult = command.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      await vi.advanceTimersByTimeAsync(0);

      const resetHandler = serialDriverMock.on.mock.calls
        .filter((call) => call[0] === "reset")
        .at(-1)?.[1];
      expect(resetHandler).toBeDefined();
      resetHandler();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      const observed = await Promise.race([
        commandResult,
        Promise.resolve("pending"),
      ]);

      void command.catch(() => {});

      expect(observed).toBe("rejected:Connection reset");
      expect(clearIntervalSpy).toHaveBeenCalled();
      expect(reset).toHaveBeenCalledTimes(1);
      expect(
        (blz as unknown as {commandWaiters: {count: () => number}}).commandWaiters.count(),
      ).toBe(0);
    });

    it("should emit reset and release listener ownership when serial reset cleanup fails", () => {
      const callback = vi.fn();
      blz.on("reset", callback);
      serialDriverMock.off.mockImplementation((event: string) => {
        if (event === "received") {
          throw new Error("received listener detach failed");
        }
      });
      const resetHandler = serialDriverMock.on.mock.calls
        .filter((call) => call[0] === "reset")
        .at(-1)?.[1];

      expect(resetHandler).toBeDefined();
      expect(() => resetHandler()).not.toThrow();

      expect(serialDriverMock.off).toHaveBeenCalledWith("received", expect.any(Function));
      expect(serialDriverMock.off).toHaveBeenCalledWith("close", expect.any(Function));
      expect(serialDriverMock.off).toHaveBeenCalledWith("reset", expect.any(Function));
      expect((blz as unknown as {serialDriverEventBridgeAttached: boolean}).serialDriverEventBridgeAttached).toBe(false);
      expect((blz as unknown as {serialDriverResetListenerAttached: boolean}).serialDriverResetListenerAttached).toBe(false);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("should not stringify received frames unless debug logging evaluates the message", () => {
      const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
      const receivedHandler = serialDriverMock.on.mock.calls.find(
        (call) => call[0] === "received",
      )?.[1];
      const data = Buffer.from([0x00, 0x00, 0x03, 0x00, 0x00, 0x00]);
      const toStringSpy = vi.spyOn(data, "toString").mockImplementation(() => {
        throw new Error("eager received frame hex string");
      });

      try {
        expect(() => receivedHandler(data)).not.toThrow();
        expect(debug).toHaveBeenCalledWith(expect.any(Function), NS);
      } finally {
        toStringSpy.mockRestore();
        debug.mockRestore();
      }
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

    it("should normalize non-Buffer received frames without Buffer.from", () => {
      const frame = vi.fn();
      const data = new Uint8Array([0x00, 0x00, 0x03, 0x00, 0x00, 0x00]);
      blz.on("frame", frame);

      const receivedHandler = serialDriverMock.on.mock.calls.find(
        (call) => call[0] === "received",
      )?.[1];
      const originalFrom = Buffer.from;
      const fromSpy = vi.spyOn(Buffer, "from").mockImplementation(((value: unknown, ...args: unknown[]) => {
        if (value === data) {
          throw new Error("received frame clone used");
        }

        return (originalFrom as (...parameters: unknown[]) => Buffer)(value, ...args);
      }) as typeof Buffer.from);

      try {
        expect(() => receivedHandler(data as Buffer)).not.toThrow();
        expect(frame).toHaveBeenCalled();
        expect(fromSpy).not.toHaveBeenCalledWith(data);
      } finally {
        fromSpy.mockRestore();
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
        expect(error).toHaveBeenCalledWith(expect.any(Function), NS);
        const [message] = error.mock.calls[0];
        expect((message as () => string)()).toContain(
          "Failed to parse BLZ frame 0xffff",
        );
      } finally {
        error.mockRestore();
      }
    });

    it("should ignore received frames whose decode errors cannot be stringified", () => {
      const frame = vi.fn();
      const error = vi.spyOn(logger, "error").mockImplementation(() => {});
      const originalErrorToString = Error.prototype.toString;
      const errorToString = vi
        .spyOn(Error.prototype, "toString")
        .mockImplementation(function errorToString() {
          if (this.message.includes("Unrecognized frame FrameID")) {
            throw new Error("decode stringification failed");
          }

          return originalErrorToString.call(this);
        });
      blz.on("frame", frame);

      const receivedHandler = serialDriverMock.on.mock.calls.find(
        (call) => call[0] === "received",
      )?.[1];
      const data = Buffer.alloc(6);
      data.writeUInt16LE(0xffff, 2);

      try {
        expect(() => receivedHandler(data)).not.toThrow();
        expect(frame).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith(expect.any(Function), NS);
      } finally {
        errorToString.mockRestore();
        error.mockRestore();
      }
    });
  });
});
