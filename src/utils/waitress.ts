import {logger} from './logger';

interface Waiter<TPayload, TMatcher> {
    ID: number;
    resolve: (payload: TPayload) => void;
    reject: (error: Error) => void;
    timer?: NodeJS.Timeout;
    resolved: boolean;
    timedout: boolean;
    matcher: TMatcher;
}

type Validator<TPayload, TMatcher> = (payload: TPayload, matcher: TMatcher) => boolean;
type TimeoutFormatter<TMatcher> = (matcher: TMatcher, timeout: number) => string;

export class Waitress<TPayload, TMatcher> {
    private waiters: Map<number, Waiter<TPayload, TMatcher>>;
    private readonly validator: Validator<TPayload, TMatcher>;
    private readonly timeoutFormatter: TimeoutFormatter<TMatcher>;
    private currentID: number;
    private readonly name: string;
    private lastMemoryCheck: number = 0;
    private readonly MEMORY_CHECK_INTERVAL = 5000; // Check every 5 seconds
    private createdWaitersCount = 0;
    private resolvedWaitersCount = 0;
    private timedoutWaitersCount = 0;

    public constructor(
        validator: Validator<TPayload, TMatcher>, 
        timeoutFormatter: TimeoutFormatter<TMatcher>,
        name: string = 'unknown'
    ) {
        this.waiters = new Map();
        this.timeoutFormatter = timeoutFormatter;
        this.validator = validator;
        this.currentID = 0;
        this.name = name;
    }

    private getMemoryUsage() {
        return process.memoryUsage();
    }

    public clear(): void {
        for (const [, waiter] of this.waiters) {
            clearTimeout(waiter.timer);
        }

        this.waiters.clear();
        logger.info(`[${this.name}] Cleared all waiters - was: ${this.waiters.size}`, 'zh:memory-leak');
    }

    private logMemoryStatus(event: string, extraInfo: string = ''): void {
        const now = Date.now();
        if (now - this.lastMemoryCheck > this.MEMORY_CHECK_INTERVAL) {
            const memUsage = this.getMemoryUsage();
            const waitersCount = this.waiters.size;
            const timedOutCount = Array.from(this.waiters.values()).filter(w => w.timedout).length;
            const activeCount = waitersCount - timedOutCount;
            
            logger.info(
                `[${this.name}] MEMORY TRACKING [${event}]: ` +
                `waiters=${waitersCount} (active=${activeCount}, timedout=${timedOutCount}), ` +
                `created=${this.createdWaitersCount}, resolved=${this.resolvedWaitersCount}, ` +
                `heap=${Math.round(memUsage.heapUsed / 1024 / 1024)}MB, ` +
                `heapTotal=${Math.round(memUsage.heapTotal / 1024 / 1024)}MB, ` +
                `external=${Math.round(memUsage.external / 1024 / 1024)}MB` +
                (extraInfo ? `, ${extraInfo}` : ''),
                'zh:memory-leak'
            );
            this.lastMemoryCheck = now;
        }
    }

    public resolve(payload: TPayload): boolean {
        this.logMemoryStatus('RESOLVE');
        return this.forEachMatching(payload, (waiter) => waiter.resolve(payload));
    }

    public reject(payload: TPayload, message: string): boolean {
        return this.forEachMatching(payload, (waiter) => waiter.reject(new Error(message)));
    }

    public remove(id: number): void {
        const waiter = this.waiters.get(id);
        if (waiter) {
            if (!waiter.timedout && waiter.timer) {
                clearTimeout(waiter.timer);
                logger.debug(
                    `[${this.name}] Manual waiter removal: ID=${id}, timedout=${waiter.timedout}, resolved=${waiter.resolved}`,
                    'zh:memory-leak'
                );
            }

            this.waiters.delete(id);
        }
    }

    public waitFor(matcher: TMatcher, timeout: number): {ID: number; start: () => {promise: Promise<TPayload>; ID: number}} {
        this.logMemoryStatus('WAIT_FOR', `timeout=${timeout}ms`);
        
        this.currentID += 1;
        const ID = this.currentID;
        this.createdWaitersCount++;

        const promise: Promise<TPayload> = new Promise((resolve, reject): void => {
            const object: Waiter<TPayload, TMatcher> = {matcher, resolve, reject, timedout: false, resolved: false, ID};
            this.waiters.set(ID, object);
            logger.debug(
                `[${this.name}] Waiter created: ID=${ID}, total_waiters=${this.waiters.size}, timeout=${timeout}ms`,
                'zh:memory-leak'
            );
        });

        const start = (): {promise: Promise<TPayload>; ID: number} => {
            const waiter = this.waiters.get(ID);
            if (waiter && !waiter.resolved && !waiter.timer) {
                // Capture the stack trace from the caller of start()
                const error = new Error(this.timeoutFormatter(matcher, timeout));
                Error.captureStackTrace(error);
                waiter.timer = setTimeout((): void => {
                    this.timedoutWaitersCount++;
                    waiter.timedout = true;
                    
                    logger.warning(
                        `[${this.name}] TIMEOUT EVENT: ID=${ID}, timeout=${timeout}ms, ` +
                        `total_waiters=${this.waiters.size}, total_timeouts=${this.timedoutWaitersCount}`,
                        'zh:memory-leak'
                    );
                    
                    // Log memory status immediately after timeout
                    this.lastMemoryCheck = 0; // Force immediate logging
                    this.logMemoryStatus('TIMEOUT', `waiter_id=${ID}`);
                    
                    waiter.reject(error);
                }, timeout);
            }

            return {promise, ID};
        };

        return {ID, start};
    }

    private forEachMatching(payload: TPayload, action: (waiter: Waiter<TPayload, TMatcher>) => void): boolean {
        let foundMatching = false;
        for (const [index, waiter] of this.waiters.entries()) {
            if (waiter.timedout) {
                this.waiters.delete(index);
                logger.debug(`[${this.name}] Cleaned timed out waiter: ID=${waiter.ID}`, 'zh:memory-leak');
            } else if (this.validator(payload, waiter.matcher)) {
                clearTimeout(waiter.timer);
                waiter.resolved = true;
                this.resolvedWaitersCount++;
                this.waiters.delete(index);
                action(waiter);
                logger.debug(
                    `[${this.name}] Waiter resolved: ID=${waiter.ID}, total_resolved=${this.resolvedWaitersCount}`,
                    'zh:memory-leak'
                );
                foundMatching = true;
            }
        }
        return foundMatching;
    }
    
    public getMemoryStats(): {total: number; active: number; timedout: number; created: number; resolved: number; timedoutTotal: number} {
        const total = this.waiters.size;
        const timedout = Array.from(this.waiters.values()).filter(w => w.timedout).length;
        return {total, active: total - timedout, timedout, created: this.createdWaitersCount, resolved: this.resolvedWaitersCount, timedoutTotal: this.timedoutWaitersCount};
    }
}