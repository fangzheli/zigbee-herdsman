interface BlzWatchdogOptions {
    periodSeconds: number;
    maxFailures: number;
    heartbeat: () => Promise<void>;
    isResetting: () => boolean;
    emitReset: () => void;
    debug: (message: string) => void;
    error: (message: () => string) => void;
}

export class BlzWatchdog {
    private timer?: NodeJS.Timeout;
    private generation = 0;
    private failures = 0;
    private heartbeatPromise?: Promise<void>;
    private readonly handler = this.run.bind(this);

    public constructor(private readonly options: BlzWatchdogOptions) {}

    public start(): void {
        this.clear();

        if (this.options.periodSeconds) {
            this.timer = setInterval(this.handler, this.options.periodSeconds * 1000);
        }
    }

    public clear(): void {
        this.generation += 1;
        this.heartbeatPromise = undefined;

        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    public resetFailures(): void {
        this.failures = 0;
    }

    public async run(): Promise<void> {
        if (this.heartbeatPromise !== undefined) {
            this.options.debug("Watchdog heartbeat already in progress");
            return;
        }

        const heartbeatPromise = this.performHeartbeat();
        this.heartbeatPromise = heartbeatPromise;

        try {
            await heartbeatPromise;
        } finally {
            if (this.heartbeatPromise === heartbeatPromise) {
                this.heartbeatPromise = undefined;
            }
        }
    }

    private async performHeartbeat(): Promise<void> {
        const generation = this.generation;
        this.options.debug(`Time to watchdog ... ${this.failures}`);

        if (this.options.isResetting()) {
            this.options.debug("The reset process is in progress...");
            return;
        }

        try {
            await this.options.heartbeat();
            if (!this.isActive(generation)) {
                return;
            }
            this.failures = 0;
        } catch (error) {
            if (!this.isActive(generation)) {
                return;
            }
            this.options.error(() => `Watchdog heartbeat timeout ${error}`);

            if (!this.options.isResetting()) {
                this.failures += 1;

                if (this.failures > this.options.maxFailures) {
                    this.failures = 0;
                    this.options.emitReset();
                }
            }
        }
    }

    private isActive(generation: number): boolean {
        return generation === this.generation;
    }
}
