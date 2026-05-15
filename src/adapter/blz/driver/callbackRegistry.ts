export class CallbackRegistry<T> {
    private readonly items = new Set<T>();

    public add(item: T): void {
        this.items.add(item);
    }

    public delete(item: T): void {
        this.items.delete(item);
    }

    public notify(callback: (item: T) => void): void {
        const items = [...this.items];
        const errors: unknown[] = [];

        try {
            for (const item of items) {
                if (!this.items.has(item)) {
                    continue;
                }

                try {
                    callback(item);
                } catch (error) {
                    errors.push(error);
                }
            }
        } finally {
            for (const item of items) {
                this.items.delete(item);
            }
        }

        if (errors.length === 1) {
            throw errors[0];
        }

        if (errors.length > 1) {
            throw new AggregateError(errors, "Multiple callback notifications failed");
        }
    }

    public count(): number {
        return this.items.size;
    }
}
