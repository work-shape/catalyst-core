import type { LocaleCode } from "@vivd-catalyst/api-client";
import type { TranslationContextValue } from "../i18n";

/** How long before its retention date a conversation is marked as about to be deleted. */
const RETENTION_WARNING_DAYS = 7;

/** The retention date, once it is close enough to warn about. */
export function retentionWarningDate(retainedUntil: string, now = Date.now()): Date | undefined {
  const date = new Date(retainedUntil);
  const remaining = date.getTime() - now;
  return remaining <= RETENTION_WARNING_DAYS * 24 * 60 * 60 * 1000 ? date : undefined;
}

/** The one sentence that says when: the rail's hint and the line in the open conversation. */
export function retentionWarningText(
  expiresAt: Date,
  { locale, t }: { locale: LocaleCode; t: TranslationContextValue["t"] },
  now = Date.now()
): string {
  // The hourly retention job may not have reached a conversation whose date has passed.
  return expiresAt.getTime() <= now
    ? t("conversationExpiresShortly")
    : t("conversationExpiresOn", {
        date: new Intl.DateTimeFormat(locale, {
          weekday: "long",
          month: "long",
          day: "numeric"
        }).format(expiresAt)
      });
}
