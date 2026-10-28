import { MAX_WAITING, QUEUE_MS, type CaptureOutcome } from "./protocol";

/** A waiting capture owns no browser context or slot until an earlier one finishes. */
export class CaptureSlots {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly slots: number) {}
  async run(deadline: number, work: () => Promise<CaptureOutcome>): Promise<CaptureOutcome> {
    if (this.running >= this.slots) {
      if (this.waiting.length >= MAX_WAITING) return { status: "refused", code: "capture_busy" };
      const admitted = await new Promise<boolean>((resolve) => {
        const take = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(
          () => {
            const index = this.waiting.indexOf(take);
            if (index >= 0) this.waiting.splice(index, 1);
            resolve(false);
          },
          Math.max(0, Math.min(QUEUE_MS, deadline - Date.now()))
        );
        this.waiting.push(take);
      });
      if (!admitted) return { status: "refused", code: "capture_busy" };
    } else this.running++;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}
