import {describe, expect, it} from "vitest";

import {
    errorFromUnknown,
    errorFromUnknownWithSafeMessage,
    formatErrorMessage,
    formatLogMessage,
    formatUnknownError,
} from "../../../src/adapter/blz/errorUtils";

describe("BLZ error utilities", () => {
    it("formats unknown values with a safe string conversion fallback", () => {
        const value = {
            toString() {
                throw new Error("stringify failed");
            },
        };

        expect(formatUnknownError(new Error("boom"))).toBe("Error: boom");
        expect(formatUnknownError(value)).toBe("<unprintable error>");
    });

    it("formats Error messages without adding the Error prefix", () => {
        expect(formatErrorMessage(new Error("boom"))).toBe("boom");
        expect(formatErrorMessage("boom")).toBe("boom");
    });

    it("converts unknown values to Error while preserving Error instances", () => {
        const error = new Error("boom");
        const converted = errorFromUnknown("bad");

        expect(errorFromUnknown(error)).toBe(error);
        expect(converted).toBeInstanceOf(Error);
        expect(converted.message).toBe("bad");
        expect(converted.cause).toBe("bad");
    });

    it("can replace Error instances whose message cannot be read", () => {
        const error = new Error("boom");
        Object.defineProperty(error, "message", {
            configurable: true,
            get: () => {
                throw new Error("message failed");
            },
        });

        const converted = errorFromUnknownWithSafeMessage(error);

        expect(Object.is(errorFromUnknown(error), error)).toBe(true);
        expect(Object.is(converted, error)).toBe(false);
        expect(converted.message).toBe("<unprintable error>");
        expect(converted.cause).toBe(error);
    });

    it("guards lazy log message formatting", () => {
        expect(formatLogMessage(() => "ok")).toBe("ok");
        expect(
            formatLogMessage(() => {
                throw new Error("message failed");
            }),
        ).toBe("Log message formatting failed: Error: message failed");
    });
});
