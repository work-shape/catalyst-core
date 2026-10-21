import { scheduleZoneWords } from "@work-shape/catalyst-ui";
import type { TranslationContextValue } from "../../shared/i18n";
import { uiLabelsFor } from "../../shared/ui-labels";
import type { InstanceTimeZone } from "./workflow-model";
import type { WorkflowStepView } from "./workflow-views";

// C9: the contract gives a schedule as a cron expression. Until it gives a form the interface
// can put into words, the forms a person would write are read here: every day, every week on
// one day, every month on one day, every year on one date, each at one time. Every other
// expression is "On a schedule". The time is the cron's wall-clock time in the schedule's zone
// and is never converted to the reader's (E1).

const NUMBER = /^\d{1,2}$/u;

/** A cron expression in words, or nothing where it is none of the forms read here. */
export function scheduleInWords(
  cron: string,
  { t, locale }: Pick<TranslationContextValue, "locale" | "t">
): string | undefined {
  const fields = cron.trim().split(/\s+/u);
  if (fields.length !== 5) {
    return undefined;
  }
  const [minute = "", hour = "", day = "", month = "", weekday = ""] = fields;
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
      ? t("workflows.schedule.yearly", {
          date: at.toLocaleDateString(locale, { day: "numeric", month: "long", timeZone: "UTC" }),
          time
        })
      : undefined;
  }
  if (day === "*" && weekday === "*") {
    return t("workflows.schedule.daily", { time });
  }
  if (day === "*" && NUMBER.test(weekday) && Number(weekday) <= 7) {
    // 4 January 2026 is a Sunday, which cron counts as 0 and as 7.
    const name = new Date(Date.UTC(2026, 0, 4 + (Number(weekday) % 7))).toLocaleDateString(locale, {
      weekday: "long",
      timeZone: "UTC"
    });
    return t("workflows.schedule.weekly", { weekday: name, time });
  }
  if (weekday === "*" && NUMBER.test(day) && Number(day) >= 1 && Number(day) <= 31) {
    const ordinal =
      locale === "en" ? `${day}${ordinalSuffix(Number(day))}` : `${String(Number(day))}.`;
    return t("workflows.schedule.monthly", { day: ordinal, time });
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
 * A schedule in words with the zone its time is in, the zone said as the schedule field says
 * it: "(Berlin time)", never its id.
 */
export function withZone(
  words: string,
  zone: string,
  { t, locale }: Pick<TranslationContextValue, "locale" | "t">
): string {
  return t("workflows.schedule.zone", {
    schedule: words,
    zone: scheduleZoneWords(zone, uiLabelsFor(locale))
  });
}
