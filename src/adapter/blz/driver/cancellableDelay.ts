import {CallbackRegistry} from "./callbackRegistry";

export class CancellableDelay {
  private readonly waiters = new CallbackRegistry<() => void>();

  public cancel(): void {
    this.waiters.notify((cancel) => {
      cancel();
    });
  }

  public async wait(
    milliseconds: number,
    isActive: () => boolean = () => true,
  ): Promise<boolean> {
    if (!isActive()) {
      return false;
    }

    let cancel!: () => void;
    return await new Promise<boolean>((resolve, reject): void => {
      const timer = setTimeout((): void => {
        this.waiters.delete(cancel);
        try {
          resolve(isActive());
        } catch (error) {
          reject(error);
        }
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

  public count(): number {
    return this.waiters.count();
  }
}
