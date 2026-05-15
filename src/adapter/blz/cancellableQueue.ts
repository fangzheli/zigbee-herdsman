interface QueueJob {
    key?: string | number;
    running: boolean;
    start?: () => void;
    rejectStart?: (error: Error) => void;
    rejectRun?: (error: Error) => void;
}

export class CancellableQueue {
    readonly #jobs: QueueJob[] = [];
    readonly #concurrent: number;
    #running = 0;

    public constructor(concurrent = 1) {
        const normalizedConcurrent = Number.isFinite(concurrent) ? Math.floor(concurrent) : 1;
        this.#concurrent = Math.max(1, normalizedConcurrent);
    }

    public async execute<T>(func: () => Promise<T>, key?: string | number): Promise<T> {
        const job: QueueJob = {key, running: false};
        const clearPromise = new Promise<never>((_, reject): void => {
            job.rejectRun = reject;
        });
        this.#jobs.push(job);

        if (this.#getNext() !== job) {
            await new Promise<void>((resolve, reject): void => {
                job.start = (): void => {
                    job.running = true;
                    this.#running += 1;
                    resolve();
                };
                job.rejectStart = reject;

                this.#executeNext();
            });
        } else {
            job.running = true;
            this.#running += 1;
        }

        const work = (async (): Promise<T> => await func())();
        work.catch(() => {});

        try {
            return await Promise.race([work, clearPromise]);
        } finally {
            job.rejectRun = undefined;
            const index = this.#jobs.indexOf(job);
            if (index !== -1) {
                this.#jobs.splice(index, 1);
                this.#running = Math.max(this.#running - 1, 0);
                this.#executeNext();
            }
        }
    }

    public count(): number {
        return this.#jobs.length;
    }

    public clear(error = new Error("Queue cleared")): void {
        for (const job of this.#jobs) {
            if (!job.running) {
                job.rejectStart?.(error);
            } else {
                job.rejectRun?.(error);
            }
        }

        this.#running = 0;
        this.#jobs.length = 0;
    }

    #executeNext(): void {
        const job = this.#getNext();
        if (job) {
            job.start?.();
        }
    }

    #getNext(): QueueJob | undefined {
        if (this.#running >= this.#concurrent) {
            return undefined;
        }

        for (const job of this.#jobs) {
            if (!job.running && (job.key === undefined || !this.#jobs.find((candidate) => candidate.key === job.key && candidate.running))) {
                return job;
            }
        }

        return undefined;
    }
}
