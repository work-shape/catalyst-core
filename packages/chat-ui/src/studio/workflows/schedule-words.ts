import type { TranslationContextValue } from "../../shared/i18n";

// C9: the contract gives a schedule as a cron expression. Until it gives a form the interface
// can put into words, the three forms a person would write are read here: every day, every
// week on one day, every month on one day, each at one time. Every other expression is
// "On a schedule".

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
  if (!NUMBER.test(minute) || !NUMBER.test(hour) || month !== "*") {
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
