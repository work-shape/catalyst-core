import { describe, expect, it } from "vitest";
import { cronSchedule, scheduleCron } from "@work-shape/catalyst-chat-ui/workflows";
import type { ScheduleValue } from "@work-shape/catalyst-ui";

// A schedule of the Workflow's Settings as cron and back (WF-EDIT-5, Events check 128): each
// form of `ScheduleField` writes one cron and reads back as itself; a cron outside these forms
// reads as none, so the Settings leave it untouched; a schedule that is not whole writes none.

const ZONE = "Europe/Berlin";

describe("a schedule as cron and back", () => {
  it.each<[ScheduleValue, string]>([
    [{ kind: "hour", minute: 15, zone: ZONE }, "15 * * * *"],
    [{ kind: "day", time: "06:05", zone: ZONE }, "5 6 * * *"],
    [{ kind: "weekday", time: "07:30", zone: ZONE }, "30 7 * * 1-5"],
    [{ kind: "week", days: [1, 3, 7], time: "18:00", zone: ZONE }, "0 18 * * 0,1,3"],
    [{ kind: "month", day: 31, time: "23:59", zone: ZONE }, "59 23 31 * *"]
  ])("writes %o as %s and reads it back", (value, cron) => {
    expect(scheduleCron(value)).toBe(cron);
    expect(cronSchedule(cron, ZONE)).toEqual(value);
  });

  it("reads Sunday written as 7 as Sunday", () => {
    expect(cronSchedule("0 8 * * 7", ZONE)).toEqual({
      kind: "week",
      days: [7],
      time: "08:00",
      zone: ZONE
    });
  });

  it.each([
    "0 9 1 1 *",
    "*/15 * * * *",
    "0 9-17 * * *",
    "0 9 * * 1-3",
    "0 9 1 * 1",
    "0 9 * * 8",
    "60 9 * * *",
    "0 24 * * *",
    "0 9 * *",
    "@daily"
  ])("reads %s as no form of the field", (cron) => {
    expect(cronSchedule(cron, ZONE)).toBeUndefined();
  });

  it("writes nothing for a schedule that is not whole", () => {
    expect(scheduleCron({ kind: "day", time: "", zone: ZONE })).toBeUndefined();
    expect(scheduleCron({ kind: "week", days: [], time: "09:00", zone: ZONE })).toBeUndefined();
  });
});
