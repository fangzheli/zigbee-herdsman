/* istanbul ignore file */

export function copyBytes(
  value: ArrayLike<number>,
  target: Buffer,
  offset = 0,
  length = value.length,
): void {
  if (Buffer.isBuffer(value)) {
    value.copy(target, offset, 0, length);
    return;
  }

  for (let i = 0; i < length; i++) {
    target[offset + i] = value[i] & 0xff;
  }
}

export function bufferFromBytes(value: ArrayLike<number>): Buffer {
  const result = Buffer.allocUnsafe(value.length);
  copyBytes(value, result);
  return result;
}

export function bufferForRetention(value: Buffer): Buffer {
  if (value.byteOffset === 0 && value.buffer.byteLength === value.length) {
    return value;
  }

  return bufferFromBytes(value);
}

export function fixedBufferFromBytes(
  value: ArrayLike<number>,
  length: number,
  errorMessage: string,
): Buffer {
  if (value.length !== length) {
    throw new Error(errorMessage);
  }

  const result = Buffer.allocUnsafe(length);
  copyBytes(value, result);
  return result;
}

function hexNibble(value: number, errorMessage: string): number {
  if (value >= 0x30 && value <= 0x39) {
    return value - 0x30;
  }
  if (value >= 0x41 && value <= 0x46) {
    return value - 0x41 + 10;
  }
  if (value >= 0x61 && value <= 0x66) {
    return value - 0x61 + 10;
  }

  throw new Error(errorMessage);
}

export function fixedBufferFromHex(
  value: string,
  length: number,
  lengthErrorMessage: string,
  hexErrorMessage = lengthErrorMessage,
): Buffer {
  if (value.length !== length * 2) {
    throw new Error(lengthErrorMessage);
  }

  const result = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) {
    result[i] =
      (hexNibble(value.charCodeAt(i * 2), hexErrorMessage) << 4) |
      hexNibble(value.charCodeAt(i * 2 + 1), hexErrorMessage);
  }

  return result;
}

export function uint64FromLittleEndianBytes(value: ArrayLike<number>): bigint {
  if (value.length < 8) {
    throw new RangeError(
      `Buffer too small. Expected at least 8 bytes, received ${value.length}`,
    );
  }

  let result = 0n;
  for (let i = 7; i >= 0; i--) {
    result = (result << 8n) | BigInt(value[i] & 0xff);
  }

  return result;
}

export function uint64FromBigEndianBytes(value: ArrayLike<number>): bigint {
  if (value.length < 8) {
    throw new RangeError(
      `Buffer too small. Expected at least 8 bytes, received ${value.length}`,
    );
  }

  let result = 0n;
  for (let i = 0; i < 8; i++) {
    result = (result << 8n) | BigInt(value[i] & 0xff);
  }

  return result;
}

export function uint64ToLittleEndianBuffer(value: bigint | number | string): Buffer {
  const result = Buffer.allocUnsafe(8);
  let remaining = typeof value === "bigint" ? value : BigInt(value);

  for (let i = 0; i < result.length; i++) {
    result[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }

  return result;
}

export function uint64ToBigEndianBuffer(value: bigint | number | string): Buffer {
  const result = Buffer.allocUnsafe(8);
  let remaining = typeof value === "bigint" ? value : BigInt(value);

  for (let i = result.length - 1; i >= 0; i--) {
    result[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }

  return result;
}

export function bytesToHex(value: ArrayLike<number>): string {
  let result = "";
  for (let i = 0; i < value.length; i++) {
    result += (value[i] & 0xff).toString(16).padStart(2, "0");
  }

  return result;
}

export function bytesEqual(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let i = 0; i < left.length; i++) {
    if ((left[i] & 0xff) !== (right[i] & 0xff)) {
      return false;
    }
  }

  return true;
}
