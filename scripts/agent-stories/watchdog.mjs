import { budgetStop, usageTotal } from "./safety.mjs";

// One invocation owns this accumulator, even across UTC period boundaries and diagnostic work.
export class UsageWatchdog {
  baseline = new Set();
  inheritedMicros = 0;
  usage = usageTotal([]);
  peak = { tokens: 0, micros: 0 };
  reason = undefined;
  constructor({ deadline, cancel, limits }) {
    this.deadline = deadline;
    this.cancel = cancel;
    this.limits = limits;
  }
  async sample(rows, now = Date.now()) {
    this.usage = usageTotal(rows.filter((row) => !this.baseline.has(row.id)));
    this.peak.tokens = Math.max(this.peak.tokens, this.usage.tokens);
    this.peak.micros = Math.max(this.peak.micros, this.usage.micros);
    const reason = budgetStop(this.usage, now, this.deadline, this.inheritedMicros, this.limits);
    if (reason && !this.reason) {
      this.reason = reason;
      await this.cancel(reason);
    }
    return this.usage;
  }
}
