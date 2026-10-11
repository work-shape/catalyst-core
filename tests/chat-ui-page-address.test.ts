import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@vivd-catalyst/api-client";
import {
  PAGE_ADDRESS_RENEWAL_MARGIN_MS,
  PAGE_ADDRESS_RENEWAL_MIN_WAIT_MS,
  keepPageAddress,
  pageAddressRemaining,
  pageAddressRenewalDelay,
  pageAddressToShow,
  type PageAddressState
} from "@vivd-catalyst/chat-ui/pages";

// The address of a Page holds a token that serves for an hour. A preview that stays open asks
// for the next address before that hour ends, and moves its frame only when the address it
// holds has stopped serving.
// Every test here fails without the renewal: the module it reads did not exist, and the
// address was asked for once per mount of the surface.

const HOUR_MS = 60 * 60_000;
const START = Date.parse("2026-03-02T09:00:00.000Z");

const addressAt = (now: number, name: string) => ({
  url: `/app-content/set-1/${name}/`,
  expiresAt: new Date(now + HOUR_MS).toISOString()
});

describe("the address a frame holds", () => {
  const first = addressAt(START, "first");
  const second = addressAt(START + HOUR_MS - PAGE_ADDRESS_RENEWAL_MARGIN_MS, "second");

  it("is the first one the instance gives", () => {
    expect(pageAddressToShow(undefined, undefined, START)).toBeUndefined();
    expect(pageAddressToShow(undefined, first, START)).toBe(first);
  });

  it("stays while it serves, so a renewed address does not load the Page again", () => {
    expect(pageAddressToShow(first, second, START + HOUR_MS - 1)).toBe(first);
    expect(pageAddressRemaining(first, START + HOUR_MS - 1)).toBe(1);
  });

  it("becomes the newest one at the moment its own stops serving", () => {
    expect(pageAddressToShow(first, second, START + HOUR_MS)).toBe(second);
    expect(pageAddressRemaining(first, START + HOUR_MS + 5)).toBe(0);
  });

  it("stays when the instance gave no newer one", () => {
    expect(pageAddressToShow(first, first, START + 2 * HOUR_MS)).toBe(first);
    expect(pageAddressToShow(first, undefined, START + 2 * HOUR_MS)).toBe(first);
  });

  it("is asked for again the margin before it expires, and never in a loop", () => {
    expect(pageAddressRenewalDelay(first, START)).toBe(HOUR_MS - PAGE_ADDRESS_RENEWAL_MARGIN_MS);
    expect(pageAddressRenewalDelay(first, START + HOUR_MS - 1000)).toBe(
      PAGE_ADDRESS_RENEWAL_MIN_WAIT_MS
    );
    expect(pageAddressRenewalDelay(first, START + 3 * HOUR_MS)).toBe(
      PAGE_ADDRESS_RENEWAL_MIN_WAIT_MS
    );
  });
});

describe("a preview that stays open", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: START });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function watch(answer: (call: number) => ReturnType<typeof addressAt>) {
    let calls = 0;
    let state: PageAddressState<ReturnType<typeof addressAt>> = { gone: false, failed: false };
    const kept = keepPageAddress(
      () => {
        calls += 1;
        return Promise.resolve().then(() => answer(calls));
      },
      (next) => {
        state = next;
      }
    );
    return { calls: () => calls, state: () => state, again: kept.again, stop: kept.stop };
  }

  it("asks for the next address the margin before the token expires", async () => {
    const preview = watch((call) => addressAt(Date.now(), `token-${call}`));
    await vi.advanceTimersByTimeAsync(0);
    expect(preview.calls()).toBe(1);
    expect(preview.state().shown?.url).toContain("token-1");

    await vi.advanceTimersByTimeAsync(HOUR_MS - PAGE_ADDRESS_RENEWAL_MARGIN_MS - 1);
    expect(preview.calls()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(preview.calls()).toBe(2);
    preview.stop();
  });

  it("keeps the frame on its address until that one expires, then moves it to the renewed one", async () => {
    const preview = watch((call) => addressAt(Date.now(), `token-${call}`));
    await vi.advanceTimersByTimeAsync(HOUR_MS - 1);

    expect(preview.calls()).toBe(2);
    expect(preview.state().shown?.url).toContain("token-1");

    await vi.advanceTimersByTimeAsync(1);
    expect(preview.state().shown?.url).toContain("token-2");
    expect(preview.calls()).toBe(2);

    // The second address is renewed and replaced the same way.
    await vi.advanceTimersByTimeAsync(HOUR_MS - PAGE_ADDRESS_RENEWAL_MARGIN_MS);
    expect(preview.state().shown?.url).toContain("token-3");
    preview.stop();
  });

  it("learns at the renewal that the viewer lost the Page, and stops asking", async () => {
    const preview = watch((call) => {
      if (call > 1) {
        throw new ApiError(403, "Forbidden", { error: { code: "FORBIDDEN" } });
      }
      return addressAt(Date.now(), "token-1");
    });
    await vi.advanceTimersByTimeAsync(HOUR_MS - PAGE_ADDRESS_RENEWAL_MARGIN_MS);

    expect(preview.calls()).toBe(2);
    expect(preview.state().gone).toBe(true);

    preview.again();
    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);
    expect(preview.calls()).toBe(2);
    preview.stop();
  });

  it("asks again soon when the instance did not answer, and shows the Page once it does", async () => {
    const preview = watch((call) => {
      if (call < 3) {
        throw new Error("The instance did not answer.");
      }
      return addressAt(Date.now(), `token-${call}`);
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(preview.state()).toEqual({ shown: undefined, gone: false, failed: true });

    await vi.advanceTimersByTimeAsync(PAGE_ADDRESS_RENEWAL_MIN_WAIT_MS);
    expect(preview.calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(PAGE_ADDRESS_RENEWAL_MIN_WAIT_MS);
    expect(preview.state().failed).toBe(false);
    expect(preview.state().shown?.url).toContain("token-3");
    preview.stop();
  });

  it("asks nothing after the surface closed", async () => {
    const preview = watch((call) => addressAt(Date.now(), `token-${call}`));
    await vi.advanceTimersByTimeAsync(0);
    preview.stop();

    await vi.advanceTimersByTimeAsync(3 * HOUR_MS);
    expect(preview.calls()).toBe(1);
  });
});
