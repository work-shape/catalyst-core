import { isScheduleZone, scheduleZoneWords, type ScheduleValue } from "@work-shape/catalyst-ui";
import type { TranslationContextValue, TranslationKey } from "../../shared/i18n";
import { uiLabelsFor } from "../../shared/ui-labels";
import type { InstanceTimeZone } from "./workflow-model";
import type { WorkflowStepView, WorkflowView } from "./workflow-views";

// C9: the contract gives a schedule as a cron expression. Until it gives a form the interface
// can put into words, the forms a person would write are read here: every day, every week on
// one day, every month on one day, every year on one date, each at one time. Every other
// expression is "On a schedule". The time is the cron's wall-clock time in the schedule's zone
// and is never converted to the reader's (E1).

const NUMBER = /^\d{1,2}$/u;

type ScheduleForm = "daily" | "weekly" | "monthly" | "yearly";

/** A schedule as a title, "Every Monday, 08:00", and as a sentence, "Runs every Monday at 08:00". */
const SCHEDULE_KEYS: Readonly<
  Record<"title" | "sentence", Readonly<Record<ScheduleForm, TranslationKey>>>
> = {
  title: {
    daily: "workflows.schedule.daily",
    weekly: "workflows.schedule.weekly",
    monthly: "workflows.schedule.monthly",
    yearly: "workflows.schedule.yearly"
  },
  sentence: {
    daily: "workflows.when.daily",
    weekly: "workflows.when.weekly",
    monthly: "workflows.when.monthly",
    yearly: "workflows.when.yearly"
  }
};

/**
 * A cron expression in words, or nothing where it is none of the forms read here. As a
 * sentence it reads what the schedule field writes besides: every hour, Monday to Friday, and
 * several days of a week.
 */
export function scheduleInWords(
  cron: string,
  { t, locale }: Pick<TranslationContextValue, "locale" | "t">,
  as: "title" | "sentence" = "title"
): string | undefined {
  const keys = SCHEDULE_KEYS[as];
  const fields = cron.trim().split(/\s+/u);
  if (fields.length !== 5) {
    return undefined;
  }
  const [minute = "", hour = "", day = "", month = "", weekday = ""] = fields;
  if (
    as === "sentence" &&
    NUMBER.test(minute) &&
    Number(minute) <= 59 &&
    [hour, day, month, weekday].every((field) => field === "*")
  ) {
    return Number(minute) === 0
      ? t("workflows.when.hourly")
      : t("workflows.when.hourlyPast", { minute: Number(minute) });
  }
  if (!NUMBER.test(minute) || !NUMBER.test(hour) || (month !== "*" && !NUMBER.test(month))) {
    return undefined;
  }
  if (Number(minute) > 59 || Number(hour) > 23) {
    return undefined;
  }
  // A clock time has no day: any day in UTC gives the same words.
  const time = new Date(Date.UTC(2026, 0, 1, Number(hour), Number(minute))).toLocaleTimeString(
    locale,
    { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }
  );
  if (month !== "*") {
    // One date a year. 2028 is a leap year, so 29 February is a date too.
    const at = new Date(Date.UTC(2028, Number(month) - 1, Number(day)));
    return weekday === "*" && NUMBER.test(day) && at.getUTCMonth() === Number(month) - 1
      ? t(keys.yearly, {
          date: at.toLocaleDateString(locale, { day: "numeric", month: "long", timeZone: "UTC" }),
          time
        })
      : undefined;
  }
  if (day === "*" && weekday === "*") {
    return t(keys.daily, { time });
  }
  if (as === "sentence" && day === "*" && weekday === "1-5") {
    return t("workflows.when.weekdays", { time });
  }
  if (as === "sentence" && day === "*" && /^[0-7](,[0-7])+$/u.test(weekday)) {
    // Several days of the week, Monday first: "every Monday and Wednesday".
    const days = [...new Set(weekday.split(",").map((entry) => Number(entry) % 7 || 7))].sort(
      (a, b) => a - b
    );
    const names = days.map((entry) =>
      // 4 January 2026 is a Sunday; the field's day 7.
      new Date(Date.UTC(2026, 0, 4 + (entry % 7))).toLocaleDateString(locale, {
        weekday: "long",
        timeZone: "UTC"
      })
    );
    return t("workflows.when.weekly", {
      weekday: new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names),
      time
    });
  }
  if (day === "*" && NUMBER.test(weekday) && Number(weekday) <= 7) {
    // 4 January 2026 is a Sunday, which cron counts as 0 and as 7.
    const name = new Date(Date.UTC(2026, 0, 4 + (Number(weekday) % 7))).toLocaleDateString(locale, {
      weekday: "long",
      timeZone: "UTC"
    });
    return t(keys.weekly, { weekday: name, time });
  }
  if (weekday === "*" && NUMBER.test(day) && Number(day) >= 1 && Number(day) <= 31) {
    const ordinal =
      locale === "en" ? `${day}${ordinalSuffix(Number(day))}` : `${String(Number(day))}.`;
    return t(keys.monthly, { day: ordinal, time });
  }
  return undefined;
}

function ordinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) {
    return "th";
  }
  return day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
}

/**
 * What starts a Workflow as its trigger's title: the schedule in words with the zone its time is
 * in, "On a schedule" where it has no words, or that a person starts it. A schedule saved
 * without a zone runs in the instance's, and UTC where the instance sets none says so.
 */
export function triggerInWords(
  starts: NonNullable<WorkflowStepView["starts"]>,
  text: Pick<TranslationContextValue, "locale" | "t">,
  instance: InstanceTimeZone | undefined
): string {
  const { t } = text;
  if (!starts.onSchedule) {
    return t("workflows.schedule.manualOnly");
  }
  const words =
    (starts.cron === undefined ? undefined : scheduleInWords(starts.cron, text)) ??
    t("workflows.schedule.custom");
  const zone = starts.timeZone ?? instance?.timeZone;
  if (starts.timeZone === undefined && instance?.defaulted === true) {
    return t("workflows.schedule.zoneDefault", { schedule: words });
  }
  return zone === undefined ? words : withZone(words, zone, text);
}

/**
 * When a Workflow runs, in one line under its name: its schedule as a sentence, and every other
 * way that starts it without a person. One a person alone starts says so. The zone of the
 * schedule is named where it is not the instance's own, since the trigger on the canvas names it
 * in any case. Nothing where the Workflow has no trigger to read.
 */
export function workflowWhen(
  workflow: Pick<WorkflowView, "steps">,
  text: Pick<TranslationContextValue, "locale" | "t">,
  instance: InstanceTimeZone | undefined
): string | undefined {
  const { t } = text;
  const starts = workflow.steps.find((step) => step.kind === "trigger")?.starts;
  if (starts === undefined) return undefined;
  const ways: string[] = [];
  if (starts.onSchedule) {
    const words =
      (starts.cron === undefined ? undefined : scheduleInWords(starts.cron, text, "sentence")) ??
      t("workflows.when.custom");
    ways.push(
      starts.timeZone === undefined
        ? instance?.defaulted === true
          ? t("workflows.schedule.zoneDefault", { schedule: words })
          : words
        : starts.timeZone === instance?.timeZone
          ? words
          : withZone(words, starts.timeZone, text)
    );
  }
  if (starts.onEvent === true) ways.push(t("workflows.when.event"));
  if (starts.bySystem === true) ways.push(t("workflows.when.system"));
  if (starts.byParent === true) ways.push(t("workflows.when.parent"));
  if (ways.length > 0) return ways.join(" · ");
  return starts.byHand ? t("workflows.schedule.manualOnly") : undefined;
}

/**
 * A zone as the schedule field says it: "Berlin time", never its id. A zone the browser does
 * not know, or a phrase such as "the instance's time zone", is said as given.
 */
export function zoneInWords(zone: string, locale: TranslationContextValue["locale"]): string {
  return isScheduleZone(zone) ? scheduleZoneWords(zone, uiLabelsFor(locale)) : zone;
}

/** A schedule in words with the zone its time is in: "Every day, 09:00 (Berlin time)". */
export function withZone(
  words: string,
  zone: string,
  { t, locale }: Pick<TranslationContextValue, "locale" | "t">
): string {
  return t("workflows.schedule.zone", { schedule: words, zone: zoneInWords(zone, locale) });
}

/**
 * The schedule on its button, in one line: "Daily at 02:00". Days of a week are named short,
 * and a schedule that is no whole one yet asks for one.
 */
export function scheduleValueWords(
  form: ScheduleValue,
  { locale, t }: Pick<TranslationContextValue, "locale" | "t">
): string {
  if (form.kind === "hour") {
    return t("knowledgeSources.whenHour", { minute: String(form.minute).padStart(2, "0") });
  }
  const [hour = 0, minute = 0] = form.time.split(":").map(Number);
  if (form.time === "" || Number.isNaN(hour) || Number.isNaN(minute)) {
    return t("knowledgeSources.whenChoose");
  }
  // A clock time has no day: any day in UTC gives the same words.
  const time = new Date(Date.UTC(2026, 0, 1, hour, minute)).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC"
  });
  switch (form.kind) {
    case "day":
      return t("knowledgeSources.whenDay", { time });
    case "weekday":
      return t("knowledgeSources.whenWeekday", { time });
    case "month":
      return t("knowledgeSources.whenMonth", { day: form.day, time });
    case "week":
      if (form.days.length === 0) return t("knowledgeSources.whenChoose");
      if (form.days.length === 1) {
        // One day is named in full: "Every Monday at 08:00".
        return t("knowledgeSources.whenWeekOne", {
          day: new Date(Date.UTC(2026, 0, 4 + (form.days[0] ?? 1))).toLocaleDateString(locale, {
            weekday: "long",
            timeZone: "UTC"
          }),
          time
        });
      }
      return t("knowledgeSources.whenWeek", {
        // 5 January 2026 is a Monday, the field's day 1.
        days: new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(
          form.days.map((day) =>
            new Date(Date.UTC(2026, 0, 4 + day)).toLocaleDateString(locale, {
              weekday: "short",
              timeZone: "UTC"
            })
          )
        ),
        time
      });
  }
}
