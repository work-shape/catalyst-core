import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptureSlots } from "@work-shape/catalyst-preview-capture";
import type { CaptureOutcome } from "@work-shape/catalyst-preview-capture";
const failed: CaptureOutcome = { status: "refused", code: "capture_failed" };
afterEach(() => vi.useRealTimers());
describe("capture admission", () => {
  it("bounds contexts and waiting work, passes a slot directly to its oldest waiter", async () => {
    const slots = new CaptureSlots(1);
    let active = 0;
    let max = 0;
    const releases: (() => void)[] = [];
    const work = async () => {
      active++;
      max = Math.max(max, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return failed;
    };
    const pending = Array.from({ length: 5 }, () => slots.run(Date.now() + 20_000, work));
    expect(await slots.run(Date.now() + 20_000, work)).toEqual({
      status: "refused",
      code: "capture_busy"
    });
    for (let n = 0; n < 5; n++) {
      releases.shift()?.();
      await pending[n];
    }
    expect(max).toBe(1);
  });
  it("refuses a ten-second wait, and a timed-out waiter cannot later occupy a context", async () => {
    vi.useFakeTimers();
    const slots = new CaptureSlots(1);
    let release: (() => void) | undefined;
    let called = false;
    const first = slots.run(Date.now() + 20_000, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return failed;
    });
    const waiting = slots.run(Date.now() + 20_000, async () => {
      called = true;
      return failed;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await waiting).toMatchObject({ code: "capture_busy" });
    release?.();
    await first;
    expect(called).toBe(false);
    expect(await slots.run(Date.now() + 1000, async () => failed)).toEqual(failed);
  });
});
