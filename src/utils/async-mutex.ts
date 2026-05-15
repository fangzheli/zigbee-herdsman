interface Waiter {
    resolve: () => void;
    reject: (error: Error) => void;
}

export class AsyncMutex {
    #locked = false;
    readonly #queue: Waiter[] = [];

    get count() {
        return this.#queue.length;
    }

    async run<T>(fn: () => Promise<T>): Promise<T> {
        if (this.#locked) {
            await new Promise<void>((resolve, reject) => this.#queue.push({resolve, reject}));
        }

        this.#locked = true;

        try {
            return await fn();
        } finally {
            this.#locked = false;
            const next = this.#queue.shift();

            if (next) {
                next.resolve();
            }
        }
    }

    clear(error = new Error("AsyncMutex cleared")) {
        for (const waiter of this.#queue) {
            waiter.reject(error);
        }

        this.#queue.length = 0;
    }
}
