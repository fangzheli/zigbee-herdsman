import {Waitress} from "../../../utils";
import Adapter, {type ClusterWaitressMatcher, type ZclWaitressPayload} from "../../adapter";
import type {ZclPayload} from "../../events";

export interface ZclResponseWaiter {
    start: () => {promise: Promise<ZclPayload>};
    cancel: () => void;
}

export class ZclResponseWaiters {
    private readonly waitress = new Waitress<ZclWaitressPayload, ClusterWaitressMatcher>(
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
        const waiter = this.waitress.waitFor(
            {
                address: networkAddress,
                endpoint,
                clusterId: clusterID,
                commandId: commandIdentifier,
                transactionSequenceNumber,
            },
            timeout,
        );
        const cancel = (): void => this.waitress.remove(waiter.ID);

        return {start: waiter.start, cancel};
    }

    public resolve(payload: ZclPayload): boolean {
        if (!this.hasHeader(payload)) {
            return false;
        }

        return this.waitress.resolve(payload);
    }

    public cancel(waiter: ZclResponseWaiter | null): void {
        waiter?.cancel();
    }

    public clear(error: Error): void {
        this.waitress.clear(error);
    }

    public count(): number {
        return this.waitress.count();
    }

    private hasHeader(payload: ZclPayload): payload is ZclWaitressPayload {
        return payload.header !== undefined;
    }
}
