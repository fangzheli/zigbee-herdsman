export class CallbackRegistry<T> {
    private readonly items = new Set<T>();

    public add(item: T): void {
        this.items.add(item);
    }

    public delete(item: T): void {
        this.items.delete(item);
    }

    public notify(callback: (item: T) => void): void {
        try {
            for (const item of this.items) {
                callback(item);
            }
        } finally {
            this.items.clear();
        }
    }

    public count(): number {
        return this.items.size;
    }
}
