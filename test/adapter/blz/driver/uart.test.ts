import * as fs from "node:fs";

import { vi, describe, it, expect, beforeEach } from "vitest";
import { SerialPort } from "../../../../src/adapter/serialPort";
import { SerialDriver } from "../../../../src/adapter/blz/driver/uart";
import { Frame } from "../../../../src/adapter/blz/driver/frame";
import { Parser } from "../../../../src/adapter/blz/driver/parser";
import { Writer } from "../../../../src/adapter/blz/driver/writer";
import { SerialPortOptions } from "../../../../src/adapter/tstype";
import {logger} from "../../../../src/utils/logger";

const socketConstructorMock = vi.hoisted(() => vi.fn());

vi.mock("net", () => ({
  default: {
    Socket: socketConstructorMock,
  },
}));
vi.mock("../../../../src/adapter/serialPort");
vi.mock("../../../../src/adapter/blz/driver/parser");
vi.mock("../../../../src/adapter/blz/driver/writer");

// Don't mock Frame since we need its actual implementation
vi.mock("../../../../src/adapter/blz/driver/frame", () => {
  return {
    Frame: vi.fn().mockImplementation((buffer: Buffer) => {
      return {
        control: buffer[0],
        sequence: buffer[1],
        frameId: buffer.readUInt16LE(2),
        payload: buffer.subarray(4, -2),
        buffer: buffer,
        checkCRC: vi.fn(),
        toString: () => buffer.toString("hex"),
      };
    }),
  };
});

describe("BLZ Serial Driver", () => {
  let driver: SerialDriver;
  let serialPortMock: {
    asyncOpen: ReturnType<typeof vi.fn>;
    asyncFlushAndClose: ReturnType<typeof vi.fn>;
    pipe: ReturnType<typeof vi.fn>;
    unpipe: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    removeAllListeners: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    isOpen: boolean;
  };
  let socketPortMock: {
    setNoDelay: ReturnType<typeof vi.fn>;
    setKeepAlive: ReturnType<typeof vi.fn>;
    pipe: ReturnType<typeof vi.fn>;
    unpipe: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
    removeAllListeners: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  let parserMock: {
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    removeAllListeners: ReturnType<typeof vi.fn>;
  };
  let writerMock: {
    pipe: ReturnType<typeof vi.fn>;
    unpipe: ReturnType<typeof vi.fn>;
    sendACK: ReturnType<typeof vi.fn>;
    sendReset: ReturnType<typeof vi.fn>;
    sendData: ReturnType<typeof vi.fn>;
  };

  const serialPortOptions: SerialPortOptions = {
    path: "/dev/ttyUSB0",
    baudRate: 115200,
    rtscts: false,
  };

  const tcpPortOptions: SerialPortOptions = {
    path: "tcp://127.0.0.1:6638",
    baudRate: 115200,
    rtscts: false,
  };

  function createFrame(
    frameId: number,
    sequence: number,
    control: number,
    payload?: Buffer,
  ): Frame {
    const headerLength = 4; // control + sequence + frameId
    const crcLength = 2;
    const payloadLength = payload ? payload.length : 0;
    const buffer = Buffer.alloc(headerLength + payloadLength + crcLength);

    buffer[0] = control;
    buffer[1] = sequence;
    buffer.writeUInt16LE(frameId, 2);

    if (payload) {
      payload.copy(buffer, headerLength);
    }

    // Mock CRC bytes
    buffer[buffer.length - 2] = 0xff;
    buffer[buffer.length - 1] = 0xff;

    return new Frame(buffer);
  }

  beforeEach(() => {
    serialPortMock = {
      asyncOpen: vi.fn(),
      asyncFlushAndClose: vi.fn(),
      pipe: vi.fn(),
      unpipe: vi.fn(),
      once: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      removeAllListeners: vi.fn(),
      destroy: vi.fn(),
      isOpen: true,
    };

    socketPortMock = {
      setNoDelay: vi.fn(),
      setKeepAlive: vi.fn(),
      pipe: vi.fn(),
      unpipe: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn(),
      removeAllListeners: vi.fn(),
      connect: vi.fn(),
      destroy: vi.fn(),
    };

    parserMock = {
      on: vi.fn(),
      off: vi.fn(),
      reset: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    writerMock = {
      pipe: vi.fn(),
      unpipe: vi.fn(),
      sendACK: vi.fn(),
      sendReset: vi.fn(),
      sendData: vi.fn(),
    };

    vi.mocked(SerialPort).mockImplementation(() => serialPortMock as any);
    socketConstructorMock.mockImplementation(() => socketPortMock);
    vi.mocked(Parser).mockImplementation(() => parserMock as any);
    vi.mocked(Writer).mockImplementation(() => writerMock as any);

    driver = new SerialDriver();
  });

  describe("Connection", () => {
    it("should keep low-level UART waiters behind driver internals", () => {
      const source = fs.readFileSync("src/adapter/blz/driver/uart.ts", "utf8");

      expect(source).toContain("private waitFor(");
      expect(source).not.toContain("public waitFor(");
      expect(source).toContain("private cancelWaiter(");
      expect(source).toContain("this.cancelWaiter(waiter);");
      expect(source).toContain("private cancelSendRetryDelay(): void");
      expect(source).toContain("this.cancelSendRetryDelay();");
      expect(source.match(/this\.sendRetryDelay\.cancel\(\);/g)).toHaveLength(1);
      expect(source).toContain("private enterClosedState(error: Error): void");
      expect(source.match(/this\.enterClosedState\(closeError\);/g)).toHaveLength(2);
      expect(source).toContain("private createConnectionClosedError(): Error");
      expect(source.match(/this\.createConnectionClosedError\(\)/g)).toHaveLength(8);
      expect(source).toContain("private createConnectionResetError(): Error");
      expect(source.match(/this\.createConnectionResetError\(\)/g)).toHaveLength(2);
      expect(source).toContain("private createPortCloseError(err: boolean | Error): Error");
      expect(source).toContain("const closeError = this.createPortCloseError(err);");
      expect(source).toContain("private createSendCancelledError(cause?: unknown): Error");
      expect(source.match(/this\.createSendCancelledError\(/g)).toHaveLength(4);
      expect(source.match(/new Error\("Connection closed"\)/g)).toHaveLength(1);
      expect(source.match(/new Error\("Connection reset"\)/g)).toHaveLength(1);
      expect(source.match(/new Error\("Send cancelled by driver reset or close"\)/g)).toHaveLength(1);
      expect(source).toContain("private cancelConnectOperations(error: Error): void");
      expect(source).toContain("this.cancelConnectOperations(closeError);");
      expect(source.match(/this\.connectOperations\.cancel\(error\);/g)).toHaveLength(1);
      expect(source).toContain("private isOperationGenerationActive(generation: number): boolean");
      expect(source.match(/this\.isOperationGenerationActive\(generation\)/g)).toHaveLength(3);
      expect(source.match(/this\.operationGeneration === generation && this\.initialized/g)).toHaveLength(1);
      expect(source).toContain("private onParsed(frame: Frame): void");
      expect(source).not.toContain("private async onParsed");
      expect(source).toContain("private handleError(frame: Frame): void");
      expect(source).not.toContain("private async handleError");
      expect(source).toContain("const onReady = (): void");
      expect(source).not.toContain("const onReady = async");
      expect(source).toContain("void handleSocketReady().catch");
      expect(source).toContain("private async runSocketReadyReset(port: net.Socket): Promise<void>");
      expect(source).toContain("await this.runSocketReadyReset(socketPort);");
      expect(source).not.toContain("@ts-ignore");
      expect(source).toContain("private destroyActivePort(): void");
      expect(source).toContain("private attachParserToPort(port: SerialPort | net.Socket): void");
      expect(source.match(/this\.writer\.pipe\(/g)).toHaveLength(1);
      expect(source.match(/this\.parser\.on\("parsed"/g)).toHaveLength(1);
      expect(source).toContain("private cleanupFailedOpenPort(port: SerialPort | net.Socket): void");
      expect(source).not.toContain("const cleanupOpen = (): void");
      expect(source).toContain("private attachSocketOpenListeners(");
      expect(source).toContain("private detachSocketOpenListeners(");
      expect(source).toContain("this.attachSocketOpenListeners(");
      expect(source).toContain("this.detachSocketOpenListeners(");
      expect(source).toContain("private attachRuntimePortListeners(port: SerialPort | net.Socket): void");
      expect(source).toContain("private detachRuntimePortListeners(port: SerialPort | net.Socket): void");
      expect(source.match(/port\.once\("close", this\.onPortCloseHandler\);/g)).toHaveLength(1);
      expect(source.match(/port\.off\("close", this\.onPortCloseHandler\);/g)).toHaveLength(1);
    });

    it("should connect successfully", async () => {
      serialPortMock.asyncOpen.mockResolvedValue(undefined);

      await driver.connect(serialPortOptions);

      expect(SerialPort).toHaveBeenCalledWith({
        path: serialPortOptions.path,
        baudRate: serialPortOptions.baudRate,
        rtscts: serialPortOptions.rtscts,
        autoOpen: false,
        parity: "none",
        stopBits: 1,
        xon: false,
        xoff: false,
      });
      expect(serialPortMock.asyncOpen).toHaveBeenCalled();
      expect(driver.isInitialized()).toBe(true);
    });

    it("should not stringify serial open options unless debug logging evaluates the message", async () => {
      const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
      const stringify = vi.spyOn(JSON, "stringify").mockImplementation((value: unknown) => {
        if (
          typeof value === "object" &&
          value !== null &&
          (value as {path?: string}).path === serialPortOptions.path
        ) {
          throw new Error("eager serial open options stringify");
        }

        return "{}";
      });
      serialPortMock.asyncOpen.mockResolvedValue(undefined);

      try {
        await expect(driver.connect(serialPortOptions)).resolves.toBeUndefined();

        expect(debug).toHaveBeenCalledWith(expect.any(Function), expect.any(String));
      } finally {
        stringify.mockRestore();
        debug.mockRestore();
      }
    });

    it("should close an existing serial connection before opening a replacement", async () => {
      const firstPort = {
        ...serialPortMock,
        asyncOpen: vi.fn().mockResolvedValue(undefined),
        asyncFlushAndClose: vi.fn().mockResolvedValue(undefined),
        pipe: vi.fn(),
        unpipe: vi.fn(),
        once: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        destroy: vi.fn(),
        isOpen: true,
      };
      const secondPort = {
        ...serialPortMock,
        asyncOpen: vi.fn().mockResolvedValue(undefined),
        asyncFlushAndClose: vi.fn().mockResolvedValue(undefined),
        pipe: vi.fn(),
        unpipe: vi.fn(),
        once: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        destroy: vi.fn(),
        isOpen: true,
      };
      vi.mocked(SerialPort)
        .mockImplementationOnce(() => firstPort as any)
        .mockImplementationOnce(() => secondPort as any);

      await driver.connect(serialPortOptions);
      await driver.connect(serialPortOptions);

      expect(writerMock.unpipe).toHaveBeenCalledWith(firstPort);
      expect(firstPort.unpipe).toHaveBeenCalledWith(parserMock);
      expect(firstPort.off).toHaveBeenCalledWith("close", expect.any(Function));
      expect(firstPort.off).toHaveBeenCalledWith("error", expect.any(Function));
      expect(firstPort.asyncFlushAndClose).toHaveBeenCalled();
      expect(secondPort.asyncOpen).toHaveBeenCalled();
      expect((driver as unknown as {serialPort?: unknown}).serialPort).toBe(secondPort);
    });

    it("should coalesce concurrent serial connect attempts", async () => {
      let finishOpen: (() => void) | undefined;
      serialPortMock.asyncOpen.mockReturnValue(
        new Promise<void>((resolve) => {
          finishOpen = resolve;
        }),
      );

      const firstConnect = driver.connect(serialPortOptions);
      const secondConnect = driver.connect(serialPortOptions);

      await Promise.resolve();

      expect(serialPortMock.asyncOpen).toHaveBeenCalledTimes(1);
      expect(serialPortMock.destroy).not.toHaveBeenCalled();

      finishOpen?.();
      await Promise.all([firstConnect, secondConnect]);

      expect(driver.isInitialized()).toBe(true);
    });

    it("should handle connection failure", async () => {
      serialPortMock.asyncOpen.mockRejectedValue(
        new Error("Connection failed"),
      );

      await expect(driver.connect(serialPortOptions)).rejects.toThrow(
        "Connection failed",
      );
      expect(driver.isInitialized()).toBe(false);
    });

    it("should clean listeners and pipes when serial open fails", async () => {
      serialPortMock.asyncOpen.mockRejectedValue(
        new Error("Connection failed"),
      );

      await expect(driver.connect(serialPortOptions)).rejects.toThrow(
        "Connection failed",
      );

      expect(writerMock.unpipe).toHaveBeenCalledWith(serialPortMock);
      expect(serialPortMock.unpipe).toHaveBeenCalledWith(parserMock);
      expect(parserMock.off).toHaveBeenCalledWith("parsed", expect.any(Function));
      expect(parserMock.reset).toHaveBeenCalled();
      expect(serialPortMock.off).toHaveBeenCalledWith("close", expect.any(Function));
      expect(serialPortMock.off).toHaveBeenCalledWith("error", expect.any(Function));
      expect(serialPortMock.destroy).toHaveBeenCalled();
    });

    it("should reject pending serial connect when closing before open finishes", async () => {
      const connect = driver.connect(serialPortOptions);
      const connectResult = connect.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );

      await driver.close(false);
      const observed = await Promise.race([
        connectResult,
        new Promise((resolve) => setImmediate(() => resolve("pending"))),
      ]);

      expect(observed).toBe("rejected:Connection closed");
      expect(writerMock.unpipe).toHaveBeenCalledWith(serialPortMock);
      expect(serialPortMock.unpipe).toHaveBeenCalledWith(parserMock);
      expect(parserMock.off).toHaveBeenCalledWith("parsed", expect.any(Function));
      expect(parserMock.reset).toHaveBeenCalled();
      expect(serialPortMock.destroy).toHaveBeenCalled();
      expect(
        (driver as unknown as {serialPort?: unknown}).serialPort,
      ).toBeUndefined();
    });

    it("should not clean the same serial port twice when close cancels open", async () => {
      const connect = driver.connect(serialPortOptions);
      const connectResult = connect.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );

      await driver.close(false);
      await expect(connectResult).resolves.toBe("rejected:Connection closed");

      expect(serialPortMock.destroy).toHaveBeenCalledTimes(1);
      expect(writerMock.unpipe).toHaveBeenCalledWith(serialPortMock);
      expect(serialPortMock.unpipe).toHaveBeenCalledWith(parserMock);
    });

    it("should handle disconnection", async () => {
      serialPortMock.asyncOpen.mockResolvedValue(undefined);
      serialPortMock.asyncFlushAndClose.mockResolvedValue(undefined);

      await driver.connect(serialPortOptions);
      await driver.close(true);

      expect(serialPortMock.asyncFlushAndClose).toHaveBeenCalled();
      expect(driver.isInitialized()).toBe(false);
    });

    it("should coalesce concurrent close calls against the same serial port", async () => {
      let finishClose: (() => void) | undefined;
      const callback = vi.fn();
      serialPortMock.asyncOpen.mockResolvedValue(undefined);
      serialPortMock.asyncFlushAndClose.mockReturnValue(
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
      );

      await driver.connect(serialPortOptions);
      driver.on("close", callback);

      const firstClose = driver.close(false);
      await Promise.resolve();
      const secondClose = driver.close(true);
      await Promise.resolve();

      expect(serialPortMock.asyncFlushAndClose).toHaveBeenCalledTimes(1);
      expect(serialPortMock.destroy).not.toHaveBeenCalled();

      finishClose?.();
      await Promise.all([firstClose, secondClose]);

      expect(callback).toHaveBeenCalledTimes(1);
      expect((driver as unknown as {serialPort?: unknown}).serialPort).toBeUndefined();
    });

    it("should remove serial port listeners when closing", async () => {
      serialPortMock.asyncOpen.mockResolvedValue(undefined);
      serialPortMock.asyncFlushAndClose.mockResolvedValue(undefined);

      await driver.connect(serialPortOptions);
      await driver.close(true);

      expect(parserMock.off).toHaveBeenCalledWith("parsed", expect.any(Function));
      expect(serialPortMock.off).toHaveBeenCalledWith("close", expect.any(Function));
      expect(serialPortMock.off).toHaveBeenCalledWith("error", expect.any(Function));
    });

    it("should detach owned serial listeners without broad listener cleanup", async () => {
      serialPortMock.asyncOpen.mockResolvedValue(undefined);
      serialPortMock.asyncFlushAndClose.mockResolvedValue(undefined);

      await driver.connect(serialPortOptions);
      parserMock.off.mockClear();
      parserMock.removeAllListeners.mockClear();
      serialPortMock.off.mockClear();
      serialPortMock.removeAllListeners.mockClear();

      await driver.close(true);

      expect(parserMock.off).toHaveBeenCalledWith("parsed", expect.any(Function));
      expect(serialPortMock.off).toHaveBeenCalledWith("close", expect.any(Function));
      expect(serialPortMock.off).toHaveBeenCalledWith("error", expect.any(Function));
      expect(parserMock.removeAllListeners).not.toHaveBeenCalled();
      expect(serialPortMock.removeAllListeners).not.toHaveBeenCalled();
    });

    it("should release the serial port reference when closing", async () => {
      serialPortMock.asyncOpen.mockResolvedValue(undefined);
      serialPortMock.asyncFlushAndClose.mockResolvedValue(undefined);

      await driver.connect(serialPortOptions);
      await driver.close(true);

      expect(
        (driver as unknown as {serialPort?: unknown}).serialPort,
      ).toBeUndefined();
    });

    it("should release the serial port reference when flush close fails", async () => {
      serialPortMock.asyncOpen.mockResolvedValue(undefined);
      serialPortMock.asyncFlushAndClose.mockRejectedValue(
        new Error("Flush close failed"),
      );

      await driver.connect(serialPortOptions);

      await expect(driver.close(true)).rejects.toThrow("Flush close failed");

      expect(serialPortMock.destroy).toHaveBeenCalled();
      expect(
        (driver as unknown as {serialPort?: unknown}).serialPort,
      ).toBeUndefined();
    });

    it("should clean listeners and pipes when TCP socket open fails", async () => {
      const connect = driver.connect(tcpPortOptions);
      socketPortMock.once.mock.calls.find((call) => call[0] === "error")?.[1](
        new Error("Socket failed"),
      );

      await expect(connect).rejects.toThrow("Socket failed");

      expect(writerMock.unpipe).toHaveBeenCalledWith(socketPortMock);
      expect(socketPortMock.unpipe).toHaveBeenCalledWith(parserMock);
      expect(parserMock.off).toHaveBeenCalledWith("parsed", expect.any(Function));
      expect(parserMock.reset).toHaveBeenCalled();
      expect(socketPortMock.off).toHaveBeenCalledWith("connect", expect.any(Function));
      expect(socketPortMock.off).toHaveBeenCalledWith("ready", expect.any(Function));
      expect(socketPortMock.off).toHaveBeenCalledWith("error", expect.any(Function));
      expect(socketPortMock.off).toHaveBeenCalledWith("close", expect.any(Function));
      expect(socketPortMock.destroy).toHaveBeenCalled();
    });

    it("should reject and clean listeners when TCP socket closes before ready", async () => {
      const connect = driver.connect(tcpPortOptions);
      const closeBeforeReady = socketPortMock.once.mock.calls.find(
        (call) => call[0] === "close",
      )?.[1];

      expect(closeBeforeReady).toBeDefined();
      closeBeforeReady();

      await expect(connect).rejects.toThrow("Socket closed before ready");

      expect(writerMock.unpipe).toHaveBeenCalledWith(socketPortMock);
      expect(socketPortMock.unpipe).toHaveBeenCalledWith(parserMock);
      expect(parserMock.off).toHaveBeenCalledWith("parsed", expect.any(Function));
      expect(parserMock.reset).toHaveBeenCalled();
      expect(socketPortMock.off).toHaveBeenCalledWith("connect", expect.any(Function));
      expect(socketPortMock.off).toHaveBeenCalledWith("ready", expect.any(Function));
      expect(socketPortMock.off).toHaveBeenCalledWith("error", expect.any(Function));
      expect(socketPortMock.off).toHaveBeenCalledWith("close", expect.any(Function));
      expect(socketPortMock.destroy).toHaveBeenCalled();
    });

    it("should reject pending TCP connect when closing before ready", async () => {
      const connect = driver.connect(tcpPortOptions);
      const connectResult = connect.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );

      await driver.close(false);
      const observed = await Promise.race([
        connectResult,
        new Promise((resolve) => setImmediate(() => resolve("pending"))),
      ]);

      expect(observed).toBe("rejected:Connection closed");
      expect(writerMock.unpipe).toHaveBeenCalledWith(socketPortMock);
      expect(socketPortMock.unpipe).toHaveBeenCalledWith(parserMock);
      expect(parserMock.off).toHaveBeenCalledWith("parsed", expect.any(Function));
      expect(parserMock.reset).toHaveBeenCalled();
      expect(socketPortMock.destroy).toHaveBeenCalled();
    });

    it("should not clean the same TCP socket twice when close cancels open", async () => {
      const connect = driver.connect(tcpPortOptions);
      const connectResult = connect.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );

      await driver.close(false);
      await expect(connectResult).resolves.toBe("rejected:Connection closed");

      expect(socketPortMock.destroy).toHaveBeenCalledTimes(1);
      expect(writerMock.unpipe).toHaveBeenCalledWith(socketPortMock);
      expect(socketPortMock.unpipe).toHaveBeenCalledWith(parserMock);
    });

    it("should stay closed when TCP connect is closed while ready reset is pending", async () => {
      let finishReset!: () => void;
      vi.spyOn(driver, "reset").mockReturnValue(
        new Promise<void>((resolve) => {
          finishReset = resolve;
        }),
      );

      const connect = driver.connect(tcpPortOptions);
      const connectResult = connect.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );
      const ready = socketPortMock.on.mock.calls.find(
        (call) => call[0] === "ready",
      )?.[1];

      expect(ready).toBeDefined();
      const readyResult = ready();
      await Promise.resolve();
      expect(driver.reset).toHaveBeenCalled();

      await driver.close(false);

      const observed = await Promise.race([
        connectResult,
        new Promise((resolve) => setImmediate(() => resolve("pending"))),
      ]);
      expect(observed).toBe("rejected:Connection closed");

      finishReset();
      await readyResult;

      expect(driver.isInitialized()).toBe(false);
      expect(
        (driver as unknown as {socketPort?: unknown}).socketPort,
      ).toBeUndefined();
    });

    it("should ignore repeated TCP ready events while reset is pending", async () => {
      let finishReset!: () => void;
      vi.spyOn(driver, "reset").mockReturnValue(
        new Promise<void>((resolve) => {
          finishReset = resolve;
        }),
      );

      const connect = driver.connect(tcpPortOptions);
      const ready = socketPortMock.on.mock.calls.find(
        (call) => call[0] === "ready",
      )?.[1];

      expect(ready).toBeDefined();
      const firstReady = ready();
      const secondReady = ready();
      await Promise.resolve();

      expect(driver.reset).toHaveBeenCalledTimes(1);

      finishReset();
      await firstReady;
      await secondReady;
      await connect;
    });

    it("should keep TCP open error listeners until ready reset finishes", async () => {
      let finishReset!: () => void;
      vi.spyOn(driver, "reset").mockReturnValue(
        new Promise<void>((resolve) => {
          finishReset = resolve;
        }),
      );

      const connect = driver.connect(tcpPortOptions);
      const ready = socketPortMock.on.mock.calls.find(
        (call) => call[0] === "ready",
      )?.[1];

      expect(ready).toBeDefined();
      const readyResult = ready();
      await Promise.resolve();

      expect(socketPortMock.off).not.toHaveBeenCalledWith("error", expect.any(Function));
      expect(socketPortMock.off).not.toHaveBeenCalledWith("close", expect.any(Function));

      finishReset();
      await readyResult;
      await connect;
    });

    it("should release TCP open listeners after ready reset succeeds", async () => {
      const connect = driver.connect(tcpPortOptions);
      const ready = socketPortMock.on.mock.calls.find(
        (call) => call[0] === "ready",
      )?.[1];

      expect(ready).toBeDefined();
      await ready();
      await connect;

      expect(socketPortMock.off).toHaveBeenCalledWith("connect", expect.any(Function));
      expect(socketPortMock.off).toHaveBeenCalledWith("ready", expect.any(Function));
      expect(socketPortMock.off).toHaveBeenCalledWith("error", expect.any(Function));
      expect(socketPortMock.off).toHaveBeenCalledWith("close", expect.any(Function));
    });

    it("should remove TCP socket listeners when closing", async () => {
      const connect = driver.connect(tcpPortOptions);
      await socketPortMock.on.mock.calls.find((call) => call[0] === "ready")?.[1]();
      await connect;

      await driver.close(true);

      expect(parserMock.off).toHaveBeenCalledWith("parsed", expect.any(Function));
      expect(socketPortMock.off).toHaveBeenCalledWith("connect", expect.any(Function));
      expect(socketPortMock.off).toHaveBeenCalledWith("ready", expect.any(Function));
      expect(socketPortMock.off).toHaveBeenCalledWith("close", expect.any(Function));
      expect(socketPortMock.off).toHaveBeenCalledWith("error", expect.any(Function));
      expect(socketPortMock.destroy).toHaveBeenCalled();
    });

    it("should detach owned TCP socket listeners without broad listener cleanup", async () => {
      const connect = driver.connect(tcpPortOptions);
      await socketPortMock.on.mock.calls.find((call) => call[0] === "ready")?.[1]();
      await connect;
      socketPortMock.off.mockClear();
      socketPortMock.removeAllListeners.mockClear();

      await driver.close(true);

      expect(socketPortMock.off).toHaveBeenCalledWith("close", expect.any(Function));
      expect(socketPortMock.off).toHaveBeenCalledWith("error", expect.any(Function));
      expect(socketPortMock.off).not.toHaveBeenCalledWith("connect", expect.any(Function));
      expect(socketPortMock.off).not.toHaveBeenCalledWith("ready", expect.any(Function));
      expect(socketPortMock.removeAllListeners).not.toHaveBeenCalled();
    });

    it("should reject and clean listeners when TCP reset fails after socket ready", async () => {
      writerMock.sendReset.mockImplementation(() => {
        throw new Error("Reset failed");
      });
      const connect = driver.connect(tcpPortOptions);

      const readyResult = socketPortMock.on.mock.calls.find((call) => call[0] === "ready")?.[1]();
      await readyResult?.catch?.(() => undefined);
      const result = await Promise.race([
        connect.then(
          () => ({ status: "resolved" }),
          (error: Error) => ({ status: "rejected", message: error.message }),
        ),
        new Promise((resolve) => setImmediate(() => resolve({ status: "pending" }))),
      ]);

      expect(result).toMatchObject({
        status: "rejected",
        message: expect.stringContaining("Reset error"),
      });
      expect(driver.isInitialized()).toBe(false);
      expect(writerMock.unpipe).toHaveBeenCalledWith(socketPortMock);
      expect(socketPortMock.unpipe).toHaveBeenCalledWith(parserMock);
      expect(parserMock.off).toHaveBeenCalledWith("parsed", expect.any(Function));
      expect(parserMock.reset).toHaveBeenCalled();
      expect(socketPortMock.off).toHaveBeenCalledWith("connect", expect.any(Function));
      expect(socketPortMock.off).toHaveBeenCalledWith("ready", expect.any(Function));
      expect(socketPortMock.off).toHaveBeenCalledWith("close", expect.any(Function));
      expect(socketPortMock.off).toHaveBeenCalledWith("error", expect.any(Function));
      expect(socketPortMock.destroy).toHaveBeenCalled();
    });
  });

  describe("Frame handling", () => {
    beforeEach(async () => {
      serialPortMock.asyncOpen.mockResolvedValue(undefined);
      await driver.connect(serialPortOptions);
    });

    it("should handle DATA frames", () => {
      const callback = vi.fn();
      driver.on("received", callback);

      const payload = Buffer.from([1, 2, 3]);
      const frame = createFrame(0x0000, 0x01, 0x00, payload);

      parserMock.on.mock.calls.find((call) => call[0] === "parsed")?.[1](frame);

      expect(writerMock.sendACK).toHaveBeenCalledWith(frame.sequence & 0x07);
      expect(callback).toHaveBeenCalledWith(frame.buffer);
    });

    it("should not stringify parsed DATA frames unless debug logging evaluates the message", () => {
      const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
      const error = vi.spyOn(logger, "error").mockImplementation(() => {});
      const frame = createFrame(0x0000, 0x01, 0x00, Buffer.from([1]));
      const toStringSpy = vi.spyOn(frame, "toString").mockImplementation(() => {
        throw new Error("eager parsed DATA frame string");
      });

      try {
        parserMock.on.mock.calls.find((call) => call[0] === "parsed")?.[1](frame);

        expect(writerMock.sendACK).toHaveBeenCalledWith(frame.sequence & 0x07);
        expect(debug).toHaveBeenCalledWith(expect.any(Function), expect.any(String));
        expect(error).not.toHaveBeenCalled();
      } finally {
        toStringSpy.mockRestore();
        debug.mockRestore();
        error.mockRestore();
      }
    });

    it("should handle ACK frames", () => {
      const frame = createFrame(0x0001, 0x01, 0x00);

      parserMock.on.mock.calls.find((call) => call[0] === "parsed")?.[1](frame);

      // ACK frames are handled internally by the waitress
      expect(writerMock.sendACK).not.toHaveBeenCalled();
    });

    it("should not stringify parsed ACK frames unless debug logging evaluates the message", async () => {
      const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
      const error = vi.spyOn(logger, "error").mockImplementation(() => {});
      const frame = createFrame(0x0001, 0x01, 0x00);
      const waiter = (
        driver as unknown as {
          waitFor: (
            frameId: number,
            timeout?: number,
          ) => { start: () => { promise: Promise<unknown>; ID: number }; ID: number };
          waitress: { remove: (id: number) => void };
        }
      ).waitFor(0x0001, 1000);
      const waiterResult = waiter.start().promise.then(
        () => "resolved",
        (waitError: Error) => `rejected:${waitError.message}`,
      );
      const toStringSpy = vi.spyOn(frame, "toString").mockImplementation(() => {
        throw new Error("eager parsed ACK frame string");
      });

      try {
        parserMock.on.mock.calls.find((call) => call[0] === "parsed")?.[1](frame);
        const observed = await Promise.race([
          waiterResult,
          new Promise((resolve) => setImmediate(() => resolve("pending"))),
        ]);

        expect(observed).toBe("resolved");
        expect(debug).toHaveBeenCalledWith(expect.any(Function), expect.any(String));
        expect(error).not.toHaveBeenCalled();
      } finally {
        (driver as unknown as {waitress: { remove: (id: number) => void }}).waitress.remove(waiter.ID);
        await waiterResult;
        toStringSpy.mockRestore();
        debug.mockRestore();
        error.mockRestore();
      }
    });

    it("should handle RESET frames", () => {
      const frame = createFrame(0x0003, 0x01, 0x00);

      parserMock.on.mock.calls.find((call) => call[0] === "parsed")?.[1](frame);

      // RESET frames are just logged
      expect(writerMock.sendACK).not.toHaveBeenCalled();
    });

    it("should not stringify parsed RESET frames unless warning logging evaluates the message", () => {
      const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
      const warning = vi.spyOn(logger, "warning").mockImplementation(() => {});
      const error = vi.spyOn(logger, "error").mockImplementation(() => {});
      const frame = createFrame(0x0003, 0x01, 0x00);
      const toStringSpy = vi.spyOn(frame, "toString").mockImplementation(() => {
        throw new Error("eager parsed RESET frame string");
      });

      try {
        parserMock.on.mock.calls.find((call) => call[0] === "parsed")?.[1](frame);

        expect(debug).toHaveBeenCalledWith(expect.any(Function), expect.any(String));
        expect(warning).toHaveBeenCalledWith(expect.any(Function), expect.any(String));
        expect(error).not.toHaveBeenCalled();
      } finally {
        toStringSpy.mockRestore();
        debug.mockRestore();
        warning.mockRestore();
        error.mockRestore();
      }
    });

    it("should not stringify parsed RESET_ACK frames unless debug logging evaluates the message", () => {
      const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
      const error = vi.spyOn(logger, "error").mockImplementation(() => {});
      const frame = createFrame(0x0004, 0x01, 0x00);
      const toStringSpy = vi.spyOn(frame, "toString").mockImplementation(() => {
        throw new Error("eager parsed RESET_ACK frame string");
      });

      try {
        parserMock.on.mock.calls.find((call) => call[0] === "parsed")?.[1](frame);

        expect(debug).toHaveBeenCalledWith(expect.any(Function), expect.any(String));
        expect(error).not.toHaveBeenCalled();
      } finally {
        toStringSpy.mockRestore();
        debug.mockRestore();
        error.mockRestore();
      }
    });

    it("should handle ERROR frames", async () => {
      const frame = createFrame(0x0002, 0x01, 0x00);

      parserMock.on.mock.calls.find((call) => call[0] === "parsed")?.[1](frame);

      // ERROR frames are just logged (reset is commented out in the actual code)
      // The frame is handled but no ACK is sent
      expect(writerMock.sendACK).not.toHaveBeenCalled();
    });

    it("should not retain unused parser reject state after malformed frames", () => {
      const frame = createFrame(0x0000, 0x01, 0x80, Buffer.from([1]));
      vi.mocked(frame.checkCRC).mockImplementation(() => {
        throw new Error("bad crc");
      });

      parserMock.on.mock.calls.find((call) => call[0] === "parsed")?.[1](frame);

      expect(
        "rejectCondition" in (driver as unknown as Record<string, unknown>),
      ).toBe(false);
    });

    it("should reject DATA frames with invalid CRC when the debug flag is clear", () => {
      const callback = vi.fn();
      driver.on("received", callback);
      const frame = createFrame(0x0000, 0x01, 0x00, Buffer.from([1]));
      vi.mocked(frame.checkCRC).mockImplementation(() => {
        throw new Error("bad crc");
      });

      parserMock.on.mock.calls.find((call) => call[0] === "parsed")?.[1](frame);

      expect(writerMock.sendACK).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();
    });

    it("should not stringify parse errors unless error logging evaluates the message", () => {
      const errorLog = vi.spyOn(logger, "error").mockImplementation(() => {});
      const frame = createFrame(0x0000, 0x01, 0x00, Buffer.from([1]));
      const parseError = new Error("bad crc");
      parseError.toString = () => {
        throw new Error("eager parse error stringification");
      };
      vi.mocked(frame.checkCRC).mockImplementation(() => {
        throw parseError;
      });

      try {
        expect(() => parserMock.on.mock.calls.find((call) => call[0] === "parsed")?.[1](frame)).not.toThrow();

        expect(writerMock.sendACK).not.toHaveBeenCalled();
        expect(errorLog).toHaveBeenCalledWith(expect.any(Function), expect.any(String));
      } finally {
        errorLog.mockRestore();
      }
    });
  });

  describe("Data sending", () => {
    beforeEach(async () => {
      serialPortMock.asyncOpen.mockResolvedValue(undefined);
      await driver.connect(serialPortOptions);
    });

    const waitForDataAck = (): {
      start: () => { promise: Promise<unknown>; ID: number };
      ID: number;
    } =>
      (
        driver as unknown as {
          waitFor: (
            frameId: number,
            timeout?: number,
          ) => { start: () => { promise: Promise<unknown>; ID: number }; ID: number };
        }
      ).waitFor(0x0000, 1000);

    it("should send data successfully", async () => {
      const data = Buffer.from([1, 2, 3]);
      const frameId = 0x0000;

      // Mock successful send with proper async timing
      writerMock.sendData.mockImplementation(() => {
        setImmediate(() => {
          const frame = createFrame(frameId, 0x01, 0x00);
          parserMock.on.mock.calls.find((call) => call[0] === "parsed")?.[1](
            frame,
          );
        });
        return Promise.resolve();
      });

      await driver.sendDATA(data, frameId);
      expect(writerMock.sendData).toHaveBeenCalledWith(
        data,
        expect.any(Number),
        expect.any(Number),
        frameId,
        false,
        false,
      );
    });

    it("should serialize concurrent DATA sends before ACK", async () => {
      const frameId = 0x0000;
      writerMock.sendData.mockReturnValue(undefined);

      const firstSend = driver.sendDATA(Buffer.from([0x01]), frameId);
      const secondSend = driver.sendDATA(Buffer.from([0x02]), frameId);
      await Promise.resolve();

      expect(writerMock.sendData).toHaveBeenCalledTimes(1);
      expect(writerMock.sendData.mock.calls[0][1]).toBe(0);

      parserMock.on.mock.calls.find((call) => call[0] === "parsed")?.[1](
        createFrame(frameId, 0x01, 0x00),
      );
      await firstSend;
      await Promise.resolve();

      expect(writerMock.sendData).toHaveBeenCalledTimes(2);
      expect(writerMock.sendData.mock.calls[1][1]).toBe(1);

      parserMock.on.mock.calls.find((call) => call[0] === "parsed")?.[1](
        createFrame(frameId, 0x02, 0x00),
      );
      await secondSend;
    });

    it("should clear UART waiters with the reset reason when resetting", async () => {
      const waiter = waitForDataAck();
      const waiterResult = waiter.start().promise.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );

      await driver.reset();
      const observed = await Promise.race([
        waiterResult,
        new Promise((resolve) => setImmediate(() => resolve("pending"))),
      ]);

      expect(observed).toBe("rejected:Connection reset");
    });

    it("should clear UART waiters with the close reason when closing", async () => {
      serialPortMock.asyncFlushAndClose.mockResolvedValue(undefined);
      const waiter = waitForDataAck();
      const waiterResult = waiter.start().promise.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );

      await driver.close(false);
      const observed = await Promise.race([
        waiterResult,
        new Promise((resolve) => setImmediate(() => resolve("pending"))),
      ]);

      expect(observed).toBe("rejected:Connection closed");
    });

    it("should handle send failure with retries", async () => {
      vi.useFakeTimers();
      try {
        const data = Buffer.from([1, 2, 3]);
        const frameId = 0x0000;

        // Mock failed send with proper timeout handling
        writerMock.sendData.mockReturnValue(undefined);

        const send = driver.sendDATA(data, frameId, 1);
        const rejection = expect(send).rejects.toThrow(
          "Failed to send data after 1 retries",
        );

        await vi.advanceTimersByTimeAsync(3000);
        await rejection;
        expect(writerMock.sendData).toHaveBeenCalledTimes(2); // Initial + 1 retry
        expect(writerMock.sendData).toHaveBeenNthCalledWith(
          1,
          data,
          expect.any(Number),
          expect.any(Number),
          frameId,
          false,
          false,
        );
        expect(writerMock.sendData).toHaveBeenNthCalledWith(
          2,
          data,
          expect.any(Number),
          expect.any(Number),
          frameId,
          true,
          false,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("should reject pending send waiters when resetting", async () => {
      const data = Buffer.from([1, 2, 3]);
      const frameId = 0x0000;
      writerMock.sendData.mockReturnValue(undefined);

      const send = driver.sendDATA(data, frameId, 0);
      const sendResult = send.then(
        () => "resolved",
        (error: Error) => `rejected:${error.message}`,
      );

      await driver.reset();
      const observed = await Promise.race([
        sendResult,
        new Promise((resolve) => setImmediate(() => resolve("pending"))),
      ]);

      parserMock.on.mock.calls.find((call) => call[0] === "parsed")?.[1](
        createFrame(frameId, 0x01, 0x00),
      );
      await send.catch(() => {});

      expect(observed).toBe("rejected:Send cancelled by driver reset or close");
    });

    it("should not send reset after close interrupts parser reset", async () => {
      serialPortMock.asyncFlushAndClose.mockResolvedValue(undefined);
      parserMock.reset.mockImplementationOnce(() => {
        void driver.close(false);
      });

      await expect(driver.reset()).rejects.toThrow("Connection closed");

      expect(writerMock.sendReset).not.toHaveBeenCalled();
    });

    it("should emit reset when UART reset logging sees an unstringifiable error", async () => {
      const resetCallback = vi.fn();
      const resetError = new Error("reset failed");
      resetError.toString = () => {
        throw new Error("reset stringification failed");
      };
      writerMock.sendReset.mockImplementation(() => {
        throw resetError;
      });
      driver.on("reset", resetCallback);

      await expect(driver.reset()).rejects.toThrow("Reset error: reset failed");

      expect(resetCallback).toHaveBeenCalledTimes(1);
    });

    it("should not retry pending sends after reset clears waiters", async () => {
      vi.useFakeTimers();
      try {
        const data = Buffer.from([1, 2, 3]);
        const frameId = 0x0000;
        writerMock.sendData.mockReturnValue(undefined);

        const send = driver.sendDATA(data, frameId, 1);
        const sendResult = send.then(
          () => "resolved",
          (error: Error) => `rejected:${error.message}`,
        );

        await driver.reset();
        await vi.advanceTimersByTimeAsync(3000);
        const observed = await sendResult;

        expect(observed).toBe("rejected:Send cancelled by driver reset or close");
        expect(writerMock.sendData).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should cancel send retry delay when closing", async () => {
      vi.useFakeTimers();
      try {
        writerMock.sendData.mockImplementation(() => {
          throw new Error("write failed");
        });

        const send = driver.sendDATA(Buffer.from([1, 2, 3]), 0x0000, 1);
        const sendResult = send.then(
          () => "resolved",
          (error: Error) => `rejected:${error.message}`,
        );

        await vi.advanceTimersByTimeAsync(0);
        await driver.close(false);
        await vi.advanceTimersByTimeAsync(0);
        const observed = await Promise.race([
          sendResult,
          Promise.resolve("pending"),
        ]);
        await vi.advanceTimersByTimeAsync(1000);
        await send.catch(() => {});

        expect(observed).toBe("rejected:Send cancelled by driver reset or close");
        expect(writerMock.sendData).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should not retain waiters for reset frames that do not wait for response", async () => {
      await driver.sendDATA(Buffer.from([1, 2, 3]), 0x0003);

      expect(
        (driver as unknown as {waitress: {count: () => number}}).waitress.count(),
      ).toBe(0);
    });

    it("should handle synchronous writer failures before waiters start", async () => {
      writerMock.sendData.mockImplementation(() => {
        throw new Error("write failed");
      });

      await expect(driver.sendDATA(Buffer.from([1, 2, 3]), 0x0000, 0)).rejects.toThrow(
        "Failed to send data after 0 retries",
      );
    });
  });

  describe("Error handling", () => {
    beforeEach(async () => {
      serialPortMock.asyncOpen.mockResolvedValue(undefined);
      await driver.connect(serialPortOptions);
    });

    it("should handle port errors", () => {
      const callback = vi.fn();
      driver.on("reset", callback);

      // Trigger error event synchronously
      serialPortMock.on.mock.calls.find((call) => call[0] === "error")?.[1](
        new Error("Port error"),
      );

      // Port errors are just logged
      expect(callback).not.toHaveBeenCalled();
    });

    it("should not throw when port error cannot be stringified", () => {
      const portError = new Error("Port error");
      portError.toString = () => {
        throw new Error("port error stringification failed");
      };

      expect(() => serialPortMock.on.mock.calls.find((call) => call[0] === "error")?.[1](portError)).not.toThrow();
    });

    it("should handle port close with error", () => {
      const callback = vi.fn();
      driver.on("reset", callback);

      // Trigger close event synchronously
      serialPortMock.once.mock.calls.find((call) => call[0] === "close")?.[1](
        new Error("Close error"),
      );

      expect(callback).toHaveBeenCalled();
      expect(driver.isInitialized()).toBe(false);
    });

    it("should release serial resources after an unexpected port close", () => {
      serialPortMock.once.mock.calls.find((call) => call[0] === "close")?.[1](
        new Error("Close error"),
      );

      expect(writerMock.unpipe).toHaveBeenCalledWith(serialPortMock);
      expect(serialPortMock.unpipe).toHaveBeenCalledWith(parserMock);
      expect(serialPortMock.off).toHaveBeenCalledWith("close", expect.any(Function));
      expect(serialPortMock.off).toHaveBeenCalledWith("error", expect.any(Function));
      expect(
        (driver as unknown as {serialPort?: unknown}).serialPort,
      ).toBeUndefined();
    });

    it("should release serial resources when port close error cannot be stringified", () => {
      const callback = vi.fn();
      const closeError = new Error("Close error");
      closeError.toString = () => {
        throw new Error("close stringification failed");
      };
      driver.on("reset", callback);

      expect(() => serialPortMock.once.mock.calls.find((call) => call[0] === "close")?.[1](closeError)).not.toThrow();

      expect(callback).toHaveBeenCalledTimes(1);
      expect(writerMock.unpipe).toHaveBeenCalledWith(serialPortMock);
      expect(serialPortMock.unpipe).toHaveBeenCalledWith(parserMock);
      expect(serialPortMock.off).toHaveBeenCalledWith("close", expect.any(Function));
      expect(serialPortMock.off).toHaveBeenCalledWith("error", expect.any(Function));
      expect(
        (driver as unknown as {serialPort?: unknown}).serialPort,
      ).toBeUndefined();
    });

    it("should release serial resources after an error close", async () => {
      serialPortMock.once.mock.calls.find((call) => call[0] === "close")?.[1](
        new Error("Close error"),
      );

      await driver.close(false);

      expect(writerMock.unpipe).toHaveBeenCalledWith(serialPortMock);
      expect(serialPortMock.unpipe).toHaveBeenCalledWith(parserMock);
      expect(serialPortMock.off).toHaveBeenCalledWith("close", expect.any(Function));
      expect(serialPortMock.off).toHaveBeenCalledWith("error", expect.any(Function));
      expect(serialPortMock.destroy).toHaveBeenCalled();
      expect(
        (driver as unknown as {serialPort?: unknown}).serialPort,
      ).toBeUndefined();
    });

    it("should handle normal port close", () => {
      const callback = vi.fn();
      driver.on("close", callback);

      // Trigger close event synchronously
      serialPortMock.once.mock.calls.find((call) => call[0] === "close")?.[1](
        false,
      );

      expect(callback).toHaveBeenCalled();
      expect(driver.isInitialized()).toBe(false);
    });
  });
});
