import {normalizeIeeeAddress} from "../ieee";
import {BlzEUI64} from "./types/named";

export type AddressCacheInput = BlzEUI64 | ArrayLike<number> | string | number | bigint;

export class AddressCache {
    private readonly eui64ToNodeId = new Map<string, number>();
    private readonly nodeIdToEui64 = new Map<number, BlzEUI64>();

    public set(nwk: number, ieee: AddressCacheInput): BlzEUI64 {
        const eui64 = AddressCache.toEui64(ieee);
        const normalized = normalizeIeeeAddress(eui64);
        const previousEui64 = this.nodeIdToEui64.get(nwk);
        const previousNwk = this.eui64ToNodeId.get(normalized);

        if (previousEui64) {
            this.eui64ToNodeId.delete(normalizeIeeeAddress(previousEui64));
        }

        if (previousNwk !== undefined && previousNwk !== nwk) {
            this.nodeIdToEui64.delete(previousNwk);
        }

        this.eui64ToNodeId.set(normalized, nwk);
        this.nodeIdToEui64.set(nwk, eui64);

        return new BlzEUI64(eui64);
    }

    public getEui64(nwk: number): BlzEUI64 | undefined {
        const eui64 = this.nodeIdToEui64.get(nwk);
        return eui64 ? new BlzEUI64(eui64) : undefined;
    }

    public getNodeId(ieee: AddressCacheInput): number | undefined {
        return this.eui64ToNodeId.get(normalizeIeeeAddress(AddressCache.toEui64(ieee)));
    }

    public remove(nwk: number, ieeeAddr: string): void {
        const normalized = normalizeIeeeAddress(ieeeAddr);
        const cachedNwk = this.eui64ToNodeId.get(normalized);
        if (cachedNwk !== undefined && cachedNwk !== nwk) {
            return;
        }

        const cachedEui64 = this.nodeIdToEui64.get(nwk);
        if (cachedEui64) {
            this.eui64ToNodeId.delete(normalizeIeeeAddress(cachedEui64));
        }

        this.nodeIdToEui64.delete(nwk);
        this.eui64ToNodeId.delete(normalized);
    }

    public clear(): void {
        this.eui64ToNodeId.clear();
        this.nodeIdToEui64.clear();
    }

    private static toEui64(ieee: AddressCacheInput): BlzEUI64 {
        if (ieee instanceof BlzEUI64) {
            return new BlzEUI64(ieee);
        }

        const source = typeof ieee === "number" || typeof ieee === "bigint" ? ieee.toString(16).padStart(16, "0") : ieee;
        return new BlzEUI64(source);
    }
}
