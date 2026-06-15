export class AsyncLimiter {
  private readonly limit: number;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active += 1;
        task()
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            this.queue.shift()?.();
          });
      };

      if (this.active < this.limit) {
        start();
        return;
      }
      this.queue.push(start);
    });
  }
}
