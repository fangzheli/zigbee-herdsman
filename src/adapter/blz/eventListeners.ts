import type {EventEmitter} from "node:events";

type ListenerEvent = Parameters<EventEmitter["on"]>[0];
type Listener = Parameters<EventEmitter["on"]>[1];
type ListenerTarget = Pick<EventEmitter, "off" | "on" | "once">;

export interface OwnedEventListener {
    event: ListenerEvent;
    listener: Listener;
    once?: boolean;
}

export function attachListenersOrRollback(target: ListenerTarget, listeners: readonly OwnedEventListener[]): void {
    try {
        for (const {event, listener, once} of listeners) {
            if (once) {
                target.once(event, listener);
            } else {
                target.on(event, listener);
            }
        }
    } catch (error) {
        detachListeners(target, listeners);
        throw error;
    }
}

export function detachListeners(target: ListenerTarget, listeners: readonly OwnedEventListener[]): void {
    for (const {event, listener} of listeners) {
        target.off(event, listener);
    }
}
