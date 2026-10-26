import { afterEach, describe, expect, it, vi } from "vitest";
import { retryAfterSeconds } from "@work-shape/catalyst-core";

const now = new Date("2026-10-09T12:00:00.000Z");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Retry-After parsing", () => {
  it.each([
    ["0", 0],
    ["7", 7],
    [" 30 ", 30],
    ["0007", 7],
    ["999999999", 999999999]
  ] as const)("reads seconds from %s", (header, seconds) => {
    expect(retryAfterSeconds(header)).toBe(seconds);
  });

  it("reads an HTTP date, preserving subsecond waits and clamping past dates", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: now.getTime() + 250 });
    expect(retryAfterSeconds("Fri, 09 Oct 2026 12:00:45 GMT")).toBe(44.75);
    expect(retryAfterSeconds("Fri, 09 Oct 2026 11:00:00 GMT")).toBe(0);
  });

  it.each([
    undefined,
    [],
    ["7", "8"],
    "",
    "garbage",
    "-1",
    "1.5",
    "1e2",
    "1000000000",
    "2026-10-09T12:00:45Z",
    "Fri, 09 Oct 2026 12:00:45 UTC",
    "Friday, 09-Oct-26 12:00:45 GMT",
    "Fri Oct 09 12:00:45 2026",
    "Fri, 99 Xxx 2026 12:00:45 GMT"
  ])("discards invalid advice %j", (header) => {
    expect(retryAfterSeconds(header)).toBeUndefined();
  });

  it("bounds the untrimmed header before parsing", () => {
    vi.useFakeTimers({ toFake: ["Date"], now });
    const parse = vi.spyOn(Date, "parse");
    const date = "Fri, 09 Oct 2026 12:00:45 GMT";
    expect(retryAfterSeconds(date.padEnd(128))).toBe(45);
    parse.mockClear();
    expect(retryAfterSeconds(date.padEnd(129))).toBeUndefined();
    expect(parse).not.toHaveBeenCalled();
    expect(retryAfterSeconds("7".padStart(129))).toBeUndefined();
  });
});
