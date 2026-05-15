import Adapter, {type ClusterWaitressMatcher, type ZclWaitressPayload} from "../../adapter";
import type {ZclPayload} from "../../events";
import {WaitressBackedWaiters} from "../waitressBackedWaiters";

export interface ZclResponseWaiter {
    start: () => {promise: Promise<ZclPayload>};
    cancel: () => void;
}

export class ZclResponseWaiters {
    private readonly waiters = new WaitressBackedWaiters<ZclWaitressPayload, ClusterWaitressMatcher>(
        Adapter.zclWaitressValidator,
        Adapter.clusterWaitressTimeoutFormatter,
    );

    public waitFor(
        networkAddress: number | undefined,
        endpoint: number,
        transactionSequenceNumber: number | undefined,
        clusterID: number,
        commandIdentifier: number,
        timeout: number,
    ): ZclResponseWaiter {
        return this.waiters.waitForCancellable(
            {
                address: networkAddress,
                endpoint,
                clusterId: clusterID,
                commandId: commandIdentifier,
                transactionSequenceNumber,
            },
            timeout,
        );
    }

    public resolve(payload: ZclPayload): boolean {
        if (!this.hasHeader(payload)) {
            return false;
        }

        return this.waiters.resolve(payload);
    }

    public cancel(waiter: ZclResponseWaiter | null): void {
        this.waiters.cancel(waiter);
    }

    public clear(error: Error): void {
        this.waiters.clear(error);
    }

    public count(): number {
        return this.waiters.count();
    }

    private hasHeader(payload: ZclPayload): payload is ZclWaitressPayload {
        return payload.header !== undefined;
    }
}
