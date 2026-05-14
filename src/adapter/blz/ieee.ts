export type IeeeAddressLike = {
  toString(): string;
};

export function normalizeIeeeAddress(ieee: IeeeAddressLike): string {
  return ieee.toString().replace(/^0x/i, "").toLowerCase();
}

export function formatIeeeAddress(ieee: IeeeAddressLike): string {
  return `0x${normalizeIeeeAddress(ieee)}`;
}
