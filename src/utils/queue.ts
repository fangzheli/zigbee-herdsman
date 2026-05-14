interface Job {
    key?: string | number;
    running: boolean;
    start?: () => void;
    rejectStart?: (error: Error) => void;
    rejectRun?: (error: Error) => void;
}

export class Queue {
    readonly #concurrent: number;
    readonly #jobs: Job[] = [];
    #running = 0;

    constructor(concurrent = 1) {
        this.#concurrent = concurrent;
    }

    public async execute<T>(func: () => Promise<T>, key?: string | number): Promise<T> {
        const job: Job = {key, running: false};
        const clearPromise = new Promise<never>((_, reject): void => {
            job.rejectRun = reject;
        });
        this.#jobs.push(job);

        // Minor optimization/workaround: various tests like the idea that a job that is immediately runnable is run without an event loop spin.
        // This also helps with stack traces in some cases, so avoid an `await` if we can help it.
        if (this.#getNext() !== job) {
            await new Promise<void>((resolve, reject): void => {
                job.start = (): void => {
                    job.running = true;
                    this.#running += 1;
                    resolve();
                };
                job.rejectStart = (error: Error): void => {
                    reject(error);
                };

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

    #executeNext(): void {
        const job = this.#getNext();

        if (job) {
            // biome-ignore lint/style/noNonNullAssertion: if we get here, start is always defined for job
            job.start!();
        }
    }

    #getNext(): Job | undefined {
        if (this.#running > this.#concurrent - 1) {
            return undefined;
        }

        for (let i = 0; i < this.#jobs.length; i++) {
            const job = this.#jobs[i];

            if (!job.running && (!job.key || !this.#jobs.find((j) => j.key === job.key && j.running))) {
                return job;
            }
        }

        return undefined;
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

    public count(): number {
        return this.#jobs.length;
    }
}
