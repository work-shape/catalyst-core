import { MAX_WAITING, QUEUE_MS, type CaptureOutcome } from "./protocol";

const CAPTURE_BUSY: CaptureOutcome = { status: "refused", code: "capture_busy" };

/** A waiting capture owns no browser context or slot until an earlier one finishes. */
export class CaptureSlots {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly slots: number) {}
  /** Runs `work` in a free slot, or answers `busy` when none frees up in time. */
  async run(deadline: number, work: () => Promise<CaptureOutcome>): Promise<CaptureOutcome>;
  async run<T>(deadline: number, work: () => Promise<T>, busy: T): Promise<T>;
  async run(
    deadline: number,
    work: () => Promise<unknown>,
    refused: unknown = CAPTURE_BUSY
  ): Promise<unknown> {
    if (this.running >= this.slots) {
      if (this.waiting.length >= MAX_WAITING) return refused;
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
      if (!admitted) return refused;
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
