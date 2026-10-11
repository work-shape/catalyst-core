import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@vivd-catalyst/api-client";
import {
  heldPageAddress,
  keepPageAddress,
  PAGE_ADDRESS_LIFETIME_MS,
  PAGE_ADDRESS_RENEWAL_MARGIN_MS,
  PAGE_ADDRESS_RETRY_MAX_MS,
  PAGE_ADDRESS_RETRY_MS,
  pageAddressRetryDelay,
  pageAddressToShow,
  type PageAddressState
} from "@vivd-catalyst/chat-ui/pages";

// The address of a Page holds a token that serves for an hour. A preview that stays open asks
// for the next address before that hour ends, and moves its frame only when the address it
// holds has stopped serving.
// Every test here fails without the renewal: the module it reads did not exist, and the
// address was asked for once per mount of the surface.

const HOUR_MS = PAGE_ADDRESS_LIFETIME_MS;
const RENEWAL_MS = HOUR_MS - PAGE_ADDRESS_RENEWAL_MARGIN_MS;
const START = Date.parse("2026-03-02T09:00:00.000Z");

interface Address {
  url: string;
  expiresAt: string;
}

/** An address as an instance gives it, whose clock is `serverAhead` in front of the device. */
const addressOf = (name: string, serverAhead = 0): Address => ({
  url: `/app-content/set-1/${name}/`,
  expiresAt: new Date(Date.now() + serverAhead + HOUR_MS).toISOString()
});

const tooMany = (retryAfterSeconds?: number) =>
  new ApiError(429, "Too many requests", {
    error: {
      code: "RATE_LIMITED",
      ...(retryAfterSeconds === undefined ? {} : { details: { retryAfterSeconds } })
    }
  });

describe("the address a frame holds", () => {
  const first = heldPageAddress({ url: "first" }, START);
  const second = heldPageAddress({ url: "second" }, START + RENEWAL_MS);

  it("serves the known lifetime from the moment it was asked for", () => {
    expect(first.servesUntil).toBe(START + HOUR_MS);
  });

  it("is the first one the instance gives", () => {
    expect(pageAddressToShow(undefined, undefined, START)).toBeUndefined();
    expect(pageAddressToShow(undefined, first, START)).toBe(first);
  });

  it("stays while it serves, so a renewed address does not load the Page again", () => {
    expect(pageAddressToShow(first, second, START + HOUR_MS - 1)).toBe(first);
  });

  it("becomes the newest one at the moment its own stops serving", () => {
    expect(pageAddressToShow(first, second, START + HOUR_MS)).toBe(second);
  });

  it("is never replaced by one that has expired itself", () => {
    expect(pageAddressToShow(first, second, START + 9 * HOUR_MS)).toBe(first);
    expect(pageAddressToShow(undefined, second, START + 9 * HOUR_MS)).toBeUndefined();
    expect(pageAddressToShow(first, first, START + 2 * HOUR_MS)).toBe(first);
  });
});

describe("the wait after an asking that failed", () => {
  const failure = new Error("The instance did not answer.");

  it("doubles from 30 seconds up to the ceiling", () => {
    expect([0, 1, 2, 3, 4, 9].map((attempt) => pageAddressRetryDelay(attempt, failure, 0))).toEqual(
      [30_000, 60_000, 120_000, 240_000, PAGE_ADDRESS_RETRY_MAX_MS, PAGE_ADDRESS_RETRY_MAX_MS]
    );
    expect(PAGE_ADDRESS_RETRY_MS).toBe(30_000);
    expect(PAGE_ADDRESS_RETRY_MAX_MS).toBe(5 * 60_000);
  });

  it("is shortened at random by up to half, never lengthened", () => {
    expect(pageAddressRetryDelay(0, failure, 0.5)).toBe(22_500);
    expect(pageAddressRetryDelay(0, failure, 0.999)).toBeGreaterThanOrEqual(15_000);
    expect(pageAddressRetryDelay(9, failure, 0.999)).toBeLessThan(PAGE_ADDRESS_RETRY_MAX_MS);
  });

  it("is what the instance says when it limits the asking", () => {
    expect(pageAddressRetryDelay(0, tooMany(90), 0.7)).toBe(90_000);
    expect(pageAddressRetryDelay(6, tooMany(600), 0)).toBe(600_000);
    // Without a wait from the instance the doubling applies.
    expect(pageAddressRetryDelay(1, tooMany(), 0)).toBe(60_000);
  });
});

describe("a preview that stays open", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: START });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  type Answer = Address | Promise<Address>;

  function watch(answer: (call: number) => Answer, random = 0) {
    let calls = 0;
    let told = 0;
    let state: PageAddressState<Address> = { gone: false, failed: false };
    const visible = new Set<() => void>();
    const kept = keepPageAddress<Address>(
      () => {
        calls += 1;
        const call = calls;
        return Promise.resolve().then(() => answer(call));
      },
      (next) => {
        told += 1;
        state = next;
      },
      {
        onVisible: (listener) => {
          visible.add(listener);
          return () => visible.delete(listener);
        },
        random: () => random
      }
    );
    return {
      calls: () => calls,
      told: () => told,
      state: () => state,
      shown: () => state.shown?.url,
      again: kept.again,
      stop: kept.stop,
      comeIntoView: () => visible.forEach((listener) => listener()),
      listening: () => visible.size
    };
  }

  /** An answer that arrives when the test says so. */
  function slow() {
    let resolve: (address: Address) => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const promise = new Promise<Address>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  it("asks for the next address the margin before the token expires", async () => {
    const preview = watch((call) => addressOf(`token-${call}`));
    await vi.advanceTimersByTimeAsync(0);
    expect(preview.calls()).toBe(1);
    expect(preview.shown()).toContain("token-1");

    await vi.advanceTimersByTimeAsync(RENEWAL_MS - 1);
    expect(preview.calls()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(preview.calls()).toBe(2);
    preview.stop();
  });

  it("keeps the frame on its address until that one expires, then moves it to the renewed one", async () => {
    const preview = watch((call) => addressOf(`token-${call}`));
    await vi.advanceTimersByTimeAsync(HOUR_MS - 1);

    expect(preview.calls()).toBe(2);
    expect(preview.shown()).toContain("token-1");

    await vi.advanceTimersByTimeAsync(1);
    expect(preview.shown()).toContain("token-2");
    expect(preview.calls()).toBe(2);

    // The second address is renewed and replaced the same way.
    await vi.advanceTimersByTimeAsync(RENEWAL_MS);
    expect(preview.shown()).toContain("token-3");
    preview.stop();
  });

  // The instance's clock and the device's differ by an hour, either way. The surface counts
  // the lifetime on the device, so it neither asks in a loop nor leaves an address in the
  // frame past the hour it serves.
  it.each([
    ["an hour fast", -HOUR_MS],
    ["an hour slow", HOUR_MS]
  ])("renews and moves on time on a device whose clock is %s", async (_name, serverAhead) => {
    const preview = watch((call) => addressOf(`token-${call}`, serverAhead));
    await vi.advanceTimersByTimeAsync(RENEWAL_MS - 1);
    expect(preview.calls()).toBe(1);
    expect(preview.shown()).toContain("token-1");

    await vi.advanceTimersByTimeAsync(PAGE_ADDRESS_RENEWAL_MARGIN_MS);
    expect(preview.calls()).toBe(2);
    expect(preview.shown()).toContain("token-1");

    await vi.advanceTimersByTimeAsync(1);
    expect(preview.shown()).toContain("token-2");

    // Three more hours: one asking and one new address per lifetime, no more.
    await vi.advanceTimersByTimeAsync(3 * RENEWAL_MS - 60_000);
    expect(preview.calls()).toBe(5);
    expect(preview.shown()).toContain("token-4");
    // Each change of the frame was told once.
    expect(preview.told()).toBe(4);
    preview.stop();
  });

  it("lets a click on Retry join the asking that is on its way", async () => {
    const second = slow();
    const preview = watch((call) => {
      if (call === 1) {
        throw new Error("The instance did not answer.");
      }
      return call === 2 ? second.promise : addressOf(`token-${call}`);
    });
    await vi.advanceTimersByTimeAsync(PAGE_ADDRESS_RETRY_MS);
    expect(preview.calls()).toBe(2);
    expect(preview.state().failed).toBe(true);

    // The automatic retry is slow. Retry is clicked twice meanwhile.
    preview.again();
    preview.again();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(preview.calls()).toBe(2);

    second.resolve(addressOf("token-2"));
    await vi.advanceTimersByTimeAsync(0);
    expect(preview.shown()).toContain("token-2");
    expect(preview.state().failed).toBe(false);

    // One renewal follows, at its time, not two.
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(preview.calls()).toBe(3);
    preview.stop();
  });

  it("asks at once when Retry is clicked while it waits", async () => {
    const preview = watch((call) => {
      if (call === 1) {
        throw new Error("The instance did not answer.");
      }
      return addressOf(`token-${call}`);
    });
    await vi.advanceTimersByTimeAsync(1000);
    preview.again();
    await vi.advanceTimersByTimeAsync(0);
    expect(preview.calls()).toBe(2);
    expect(preview.shown()).toContain("token-2");

    // The wait that was running is gone with the click.
    await vi.advanceTimersByTimeAsync(PAGE_ADDRESS_RETRY_MS);
    expect(preview.calls()).toBe(2);
    preview.stop();
  });

  it("learns at the renewal that the viewer lost the Page, and nothing asks again", async () => {
    const preview = watch((call) => {
      if (call > 1) {
        throw new ApiError(403, "Forbidden", { error: { code: "FORBIDDEN" } });
      }
      return addressOf("token-1");
    });
    await vi.advanceTimersByTimeAsync(RENEWAL_MS);

    expect(preview.calls()).toBe(2);
    expect(preview.state().gone).toBe(true);

    preview.again();
    preview.comeIntoView();
    await vi.advanceTimersByTimeAsync(9 * HOUR_MS);
    preview.comeIntoView();
    await vi.advanceTimersByTimeAsync(0);
    expect(preview.calls()).toBe(2);
    expect(preview.told()).toBe(2);
    preview.stop();
  });

  it("stays lost when a 404 ends a slow asking that Retry had joined", async () => {
    const first = slow();
    const preview = watch(() => first.promise);
    preview.again();
    first.reject(new ApiError(404, "Not found", { error: { code: "NOT_FOUND" } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(preview.state()).toEqual({ shown: undefined, gone: true, failed: false });

    preview.again();
    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);
    expect(preview.calls()).toBe(1);
    preview.stop();
  });

  it("drops an answer that arrives after the surface closed", async () => {
    const first = slow();
    const preview = watch(() => first.promise);
    await vi.advanceTimersByTimeAsync(0);
    preview.stop();
    expect(preview.listening()).toBe(0);

    first.resolve(addressOf("token-1"));
    await vi.advanceTimersByTimeAsync(3 * HOUR_MS);
    preview.again();
    await vi.advanceTimersByTimeAsync(0);

    expect(preview.calls()).toBe(1);
    expect(preview.told()).toBe(0);
    expect(preview.state().shown).toBeUndefined();
  });

  it("drops a failure that arrives after the surface closed, and waits for nothing", async () => {
    const first = slow();
    const preview = watch(() => first.promise);
    await vi.advanceTimersByTimeAsync(0);
    preview.stop();

    first.reject(new Error("The instance did not answer."));
    await vi.advanceTimersByTimeAsync(3 * HOUR_MS);
    expect(preview.calls()).toBe(1);
    expect(preview.told()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("asks nothing after the surface closed", async () => {
    const preview = watch((call) => addressOf(`token-${call}`));
    await vi.advanceTimersByTimeAsync(0);
    preview.stop();

    await vi.advanceTimersByTimeAsync(3 * HOUR_MS);
    expect(preview.calls()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("puts no expired address into the frame after eight hours asleep, and asks for a fresh one", async () => {
    const preview = watch((call) => addressOf(`token-${call}`));
    // The second address is held for the frame when the device falls asleep.
    await vi.advanceTimersByTimeAsync(RENEWAL_MS + 60_000);
    expect(preview.calls()).toBe(2);
    expect(preview.shown()).toContain("token-1");

    // Asleep: the clock moves on and no timer runs. Awake, the timer that was due when the
    // first address expired fires, eight hours late.
    vi.setSystemTime(Date.now() + 8 * HOUR_MS);
    const shownOnWaking: (string | undefined)[] = [];
    await vi.advanceTimersByTimeAsync(PAGE_ADDRESS_RENEWAL_MARGIN_MS - 60_000 - 1);
    shownOnWaking.push(preview.shown());
    await vi.advanceTimersByTimeAsync(1);
    shownOnWaking.push(preview.shown());

    // The address held before the sleep has expired too and is skipped.
    expect(preview.calls()).toBe(3);
    expect(preview.shown()).toContain("token-3");
    expect(shownOnWaking).not.toContain("/app-content/set-1/token-2/");

    // From there on the hour runs as before.
    await vi.advanceTimersByTimeAsync(RENEWAL_MS - 1);
    expect(preview.calls()).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(preview.calls()).toBe(4);
    preview.stop();
  });

  it("asks when the tab comes back into view past the renewal point, before any late timer", async () => {
    const preview = watch((call) => addressOf(`token-${call}`));
    await vi.advanceTimersByTimeAsync(60_000);

    // In view again while the address is young: nothing to ask.
    preview.comeIntoView();
    await vi.advanceTimersByTimeAsync(0);
    expect(preview.calls()).toBe(1);

    vi.setSystemTime(Date.now() + 8 * HOUR_MS);
    preview.comeIntoView();
    preview.comeIntoView();
    expect(preview.calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(preview.shown()).toContain("token-2");
    expect(preview.calls()).toBe(2);
    preview.stop();
  });

  it("waits longer after each failure, obeys the instance, and starts over after a success", async () => {
    const preview = watch((call) => {
      if (call === 3) {
        throw tooMany(600);
      }
      if (call <= 5 || call === 7) {
        throw new Error("The instance did not answer.");
      }
      return addressOf(`token-${call}`);
    });
    const waits: number[] = [];
    let seen = 1;
    let since = Date.now();
    for (let passed = 0; passed < 2 * HOUR_MS && waits.length < 5; passed += 1000) {
      await vi.advanceTimersByTimeAsync(1000);
      if (preview.calls() > seen) {
        waits.push(Date.now() - since);
        seen = preview.calls();
        since = Date.now();
      }
    }
    // 30 s, 60 s, then the ten minutes the instance asked for, then the doubling goes on.
    expect(waits).toEqual([30_000, 60_000, 600_000, 240_000, PAGE_ADDRESS_RETRY_MAX_MS]);
    expect(preview.shown()).toContain("token-6");
    expect(preview.state().failed).toBe(false);

    // The next failure, an hour later, waits the first step again.
    await vi.advanceTimersByTimeAsync(RENEWAL_MS);
    expect(preview.calls()).toBe(7);
    await vi.advanceTimersByTimeAsync(PAGE_ADDRESS_RETRY_MS - 1);
    expect(preview.calls()).toBe(7);
    await vi.advanceTimersByTimeAsync(1);
    expect(preview.calls()).toBe(8);
    preview.stop();
  });

  it("spreads the waits by the random share", async () => {
    const preview = watch((call) => {
      if (call === 1) {
        throw new Error("The instance did not answer.");
      }
      return addressOf(`token-${call}`);
    }, 0.5);
    await vi.advanceTimersByTimeAsync(22_499);
    expect(preview.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(preview.calls()).toBe(2);
    preview.stop();
  });
});
