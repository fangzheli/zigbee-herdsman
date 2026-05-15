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
        let firstError: unknown;
        let hasError = false;

        try {
            for (const item of items) {
                try {
                    callback(item);
                } catch (error) {
                    if (!hasError) {
                        firstError = error;
                        hasError = true;
                    }
                }
            }
        } finally {
            this.items.clear();
        }

        if (hasError) {
            throw firstError;
        }
    }

    public count(): number {
        return this.items.size;
    }
}
