import { describe, expect, it } from "vitest";
import { lastDueWithin, nextDueAfter, parseCron } from "@work-shape/catalyst-core";
import { required } from "./support/assertions";

// The rule on the two days a year a zone's clock is changed:
// - set back: a reading the clock shows twice is due the first time only;
// - set forward: readings the clock skips are due once, together, at the first minute after
//   the gap.
// So a schedule runs once for every time of day it names, on both days.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (iso: string) => new Date(iso);
const iso = (date: Date | undefined) => date?.toISOString();

/** What the clock of a zone shows at a moment, as a count of milliseconds. */
function wallOf(timeZone: string) {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric"
  });
  return (time: number) => {
    const part: Record<string, number> = {};
    for (const { type, value } of format.formatToParts(time)) part[type] = Number(value);
    return Date.UTC(
      part.year ?? 0,
      (part.month ?? 1) - 1,
      part.day ?? 1,
      part.hour ?? 0,
      part.minute ?? 0
    );
  };
}

/** The rule above, minute by minute: what a schedule naming these times of day fires at. */
function expectedFires(cron: string, timeZone: string, from: number, to: number): string[] {
  const parsed = required(parseCron(cron));
  const named = (wall: number) => {
    const date = new Date(wall);
    return parsed.hours.has(date.getUTCHours()) && parsed.minutes.has(date.getUTCMinutes());
  };
  const wall = wallOf(timeZone);
  const shown = new Set<number>();
  const fires: string[] = [];
  let previous = wall(from - MINUTE);
  for (let time = from; time <= to; time += MINUTE) {
    const reading = wall(time);
    let due = named(reading) && !shown.has(reading);
    for (let skipped = previous + MINUTE; skipped < reading; skipped += MINUTE)
      due ||= named(skipped);
    if (due) fires.push(new Date(time).toISOString());
    shown.add(reading);
    previous = reading;
  }
  return fires;
}

function firesForward(cron: string, timeZone: string, from: number, to: number): string[] {
  const fires: string[] = [];
  let next = nextDueAfter([required(parseCron(cron))], new Date(from - 1), timeZone);
  while (next && next.getTime() <= to) {
    fires.push(next.toISOString());
    next = nextDueAfter([required(parseCron(cron))], next, timeZone);
  }
  return fires;
}

function firesBackward(cron: string, timeZone: string, from: number, to: number): string[] {
  const fires: string[] = [];
  let last = lastDueWithin([required(parseCron(cron))], new Date(from), new Date(to), timeZone);
  while (last) {
    fires.unshift(last.toISOString());
    last = lastDueWithin(
      [required(parseCron(cron))],
      new Date(from),
      new Date(last.getTime() - 1),
      timeZone
    );
  }
  return fires;
}

describe("a cron schedule across the days the clock is changed", () => {
  it("runs the repeated Berlin hour once, the first time it is shown", () => {
    const hourly = [required(parseCron("0 * * * *"))];
    // 25 October 2026: 03:00 summer time becomes 02:00 winter time at 01:00 UTC, so 02:00 is
    // shown at 00:00 and again at 01:00 UTC.
    expect(iso(nextDueAfter(hourly, at("2026-10-24T23:30:00Z"), "Europe/Berlin"))).toBe(
      "2026-10-25T00:00:00.000Z"
    );
    expect(iso(nextDueAfter(hourly, at("2026-10-25T00:00:00Z"), "Europe/Berlin"))).toBe(
      "2026-10-25T02:00:00.000Z"
    );
    // A late tick inside the repeated hour catches up with the 02:00 it missed: its first
    // showing.
    expect(
      iso(
        lastDueWithin(
          hourly,
          at("2026-10-24T20:00:00Z"),
          at("2026-10-25T01:30:00Z"),
          "Europe/Berlin"
        )
      )
    ).toBe("2026-10-25T00:00:00.000Z");
    const halfPastTwo = [required(parseCron("30 2 * * *"))];
    expect(iso(nextDueAfter(halfPastTwo, at("2026-10-24T12:00:00Z"), "Europe/Berlin"))).toBe(
      "2026-10-25T00:30:00.000Z"
    );
    expect(iso(nextDueAfter(halfPastTwo, at("2026-10-25T00:30:00Z"), "Europe/Berlin"))).toBe(
      "2026-10-26T01:30:00.000Z"
    );
  });

  it("runs a skipped Berlin time once, at the first minute after the gap", () => {
    // 28 March 2027: 02:00 winter time becomes 03:00 summer time at 01:00 UTC.
    const halfPastTwo = [required(parseCron("30 2 * * *"))];
    expect(iso(nextDueAfter(halfPastTwo, at("2027-03-27T12:00:00Z"), "Europe/Berlin"))).toBe(
      "2027-03-28T01:00:00.000Z"
    );
    expect(iso(nextDueAfter(halfPastTwo, at("2027-03-28T01:00:00Z"), "Europe/Berlin"))).toBe(
      "2027-03-29T00:30:00.000Z"
    );
    expect(
      iso(
        lastDueWithin(
          halfPastTwo,
          at("2027-03-27T12:00:00Z"),
          at("2027-03-28T06:00:00Z"),
          "Europe/Berlin"
        )
      )
    ).toBe("2027-03-28T01:00:00.000Z");
    // 03:00 and the skipped quarter hours before it run once together.
    const quarterly = [required(parseCron("*/15 * * * *"))];
    expect(iso(nextDueAfter(quarterly, at("2027-03-28T00:45:00Z"), "Europe/Berlin"))).toBe(
      "2027-03-28T01:00:00.000Z"
    );
    expect(iso(nextDueAfter(quarterly, at("2027-03-28T01:00:00Z"), "Europe/Berlin"))).toBe(
      "2027-03-28T01:15:00.000Z"
    );
  });

  // Each zone's change in the autumn and the spring, a whole hour or, on Lord Howe Island,
  // half an hour.
  const changes = [
    ["Europe/Berlin", "2026-10-25T01:00:00Z"],
    ["Europe/Berlin", "2027-03-28T01:00:00Z"],
    ["America/New_York", "2026-11-01T06:00:00Z"],
    ["America/New_York", "2027-03-14T07:00:00Z"],
    ["Australia/Lord_Howe", "2026-10-03T15:30:00Z"],
    ["Australia/Lord_Howe", "2027-04-03T15:00:00Z"]
  ] as const;
  const crons = ["0 * * * *", "*/15 * * * *", "30 1 * * *", "30 2 * * *", "0 2 * * *"];

  it.each(changes)("fires once for every named time in %s around %s", (timeZone, change) => {
    const wall = wallOf(timeZone);
    const moment = Date.parse(change);
    // The fixtures are real changes of the clock.
    expect(Math.abs(wall(moment) - wall(moment - MINUTE) - MINUTE)).toBeGreaterThanOrEqual(
      29 * MINUTE
    );
    const from = moment - 26 * HOUR;
    const to = moment + 26 * HOUR;
    for (const cron of crons) {
      const expected = expectedFires(cron, timeZone, from, to);
      expect(firesForward(cron, timeZone, from, to), cron).toEqual(expected);
      expect(firesBackward(cron, timeZone, from, to), cron).toEqual(expected);
      // Never twice for one reading of the clock.
      const readings = expected.map((time) => wall(Date.parse(time)));
      expect(new Set(readings).size, cron).toBe(readings.length);
    }
  });
});
