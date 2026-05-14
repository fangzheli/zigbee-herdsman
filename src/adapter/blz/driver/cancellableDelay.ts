export class CancellableDelay {
  private readonly waiters = new Set<() => void>();

  public cancel(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();

    for (const cancel of waiters) {
      cancel();
    }
  }

  public async wait(
    milliseconds: number,
    isActive: () => boolean = () => true,
  ): Promise<boolean> {
    if (!isActive()) {
      return false;
    }

    let cancel!: () => void;
    return await new Promise<boolean>((resolve): void => {
      const timer = setTimeout((): void => {
        this.waiters.delete(cancel);
        resolve(isActive());
      }, milliseconds);
      cancel = (): void => {
        clearTimeout(timer);
        resolve(false);
      };
      this.waiters.add(cancel);
    }).finally(() => {
      this.waiters.delete(cancel);
    });
  }
}
