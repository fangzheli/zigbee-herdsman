import type {EventEmitter} from "node:events";

type ListenerEvent = Parameters<EventEmitter["on"]>[0];
type Listener = Parameters<EventEmitter["on"]>[1];
type ListenerTarget = Pick<EventEmitter, "off" | "on" | "once">;
type DetachListenerTarget = Pick<EventEmitter, "off">;

export interface OwnedEventListener {
    event: ListenerEvent;
    listener: Listener;
    once?: boolean;
}

export function attachListenersOrRollback(target: ListenerTarget, listeners: readonly OwnedEventListener[]): void {
    const attached: OwnedEventListener[] = [];

    try {
        for (const registration of listeners) {
            const {event, listener, once} = registration;
            if (once) {
                target.once(event, listener);
            } else {
                target.on(event, listener);
            }

            attached.push(registration);
        }
    } catch (attachError) {
        try {
            detachListeners(target, attached);
        } catch (rollbackError) {
            throw new AggregateError([attachError, rollbackError], "Failed to attach event listeners and rollback cleanup failed");
        }

        throw attachError;
    }
}

export function detachListeners(target: DetachListenerTarget, listeners: readonly OwnedEventListener[]): void {
    const errors: unknown[] = [];

    for (const {event, listener} of listeners) {
        try {
            target.off(event, listener);
        } catch (error) {
            errors.push(error);
        }
    }

    if (errors.length === 1) {
        throw errors[0];
    }

    if (errors.length > 1) {
        throw new AggregateError(errors, "Failed to detach event listeners");
    }
}
