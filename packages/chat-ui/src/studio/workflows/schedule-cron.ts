import type { ScheduleValue, ScheduleWeekday } from "@work-shape/catalyst-ui";

// A schedule as the Workflow's Settings edit it (workflow-canvas 9.7, WF-EDIT-5): the forms
// `ScheduleField` offers, written as the cron a `schedule` trigger holds, and read back from
// it. A cron that is none of these forms is no value of the field: the Settings leave it as it
// is and say it in words, or "On a schedule".

const NUMBER = /^\d{1,2}$/u;
const TIME = /^(\d{2}):(\d{2})$/u;

const within = (text: string, low: number, high: number): number | undefined => {
  if (!NUMBER.test(text)) return undefined;
  const value = Number(text);
  return value >= low && value <= high ? value : undefined;
};

const pad = (value: number) => String(value).padStart(2, "0");

/** The field's day of a cron weekday: cron counts Sunday as 0 and as 7, the field as 7. */
const CRON_WEEKDAYS: readonly ScheduleWeekday[] = [7, 1, 2, 3, 4, 5, 6, 7];

/** The hour and minute of a time such as "07:30", or nothing where it is no time. */
function clock(time: string): { hour: number; minute: number } | undefined {
  const match = TIME.exec(time);
  const hour = within(match?.[1] ?? "", 0, 23);
  const minute = within(match?.[2] ?? "", 0, 59);
  return hour === undefined || minute === undefined ? undefined : { hour, minute };
}

/**
 * The cron of a schedule, or nothing where the field holds no whole schedule yet: a time not
 * filled in, or a week with no day.
 */
export function scheduleCron(value: ScheduleValue): string | undefined {
  if (value.kind === "hour") {
    return value.minute >= 0 && value.minute <= 59 ? `${String(value.minute)} * * * *` : undefined;
  }
  const at = clock(value.time);
  if (at === undefined) return undefined;
  const head = `${String(at.minute)} ${String(at.hour)}`;
  switch (value.kind) {
    case "day":
      return `${head} * * *`;
    case "weekday":
      return `${head} * * 1-5`;
    case "week": {
      if (value.days.length === 0) return undefined;
      // Cron counts Sunday as 0; the field counts it as 7.
      const days = [...new Set(value.days.map((day) => day % 7))].sort((a, b) => a - b);
      return `${head} * * ${days.join(",")}`;
    }
    case "month":
      return value.day >= 1 && value.day <= 31 ? `${head} ${String(value.day)} * *` : undefined;
  }
}

/** The schedule a cron says in one of the field's forms, or nothing where it says another. */
export function cronSchedule(cron: string, zone: string): ScheduleValue | undefined {
  const fields = cron.trim().split(/\s+/u);
  if (fields.length !== 5) return undefined;
  const [minuteText = "", hourText = "", day = "", month = "", weekday = ""] = fields;
  const minute = within(minuteText, 0, 59);
  if (minute === undefined || month !== "*") return undefined;
  if (hourText === "*") {
    return day === "*" && weekday === "*" ? { kind: "hour", minute, zone } : undefined;
  }
  const hour = within(hourText, 0, 23);
  if (hour === undefined) return undefined;
  const time = `${pad(hour)}:${pad(minute)}`;
  if (day === "*" && weekday === "*") return { kind: "day", time, zone };
  if (day === "*" && weekday === "1-5") return { kind: "weekday", time, zone };
  if (day === "*") {
    const days = weekday.split(",").map((part) => CRON_WEEKDAYS[within(part, 0, 7) ?? -1]);
    if (days.some((entry) => entry === undefined)) return undefined;
    const named = [...new Set(days.filter((entry) => entry !== undefined))].sort((a, b) => a - b);
    return { kind: "week", days: named, time, zone };
  }
  const date = within(day, 1, 31);
  return date !== undefined && weekday === "*"
    ? { kind: "month", day: date, time, zone }
    : undefined;
}
