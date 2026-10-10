import type { LocaleCode, SafeConfig } from "@vivd-catalyst/api-client";
import type { TranslationContextValue } from "../i18n";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long before its retention date a conversation is marked as about to be deleted. */
const RETENTION_WARNING_DAYS = 7;

/**
 * The warning never covers more than this share of the retention period. A message moves the
 * date a whole period ahead, so with a period of seven days or less a longer warning would
 * mark every conversation always, also the one just written in.
 */
const RETENTION_WARNING_MAX_SHARE_OF_PERIOD = 0.5;

/** How long before its date an instance warns; nothing where it deletes nothing for age. */
function retentionWarningWindowMs(retention: SafeConfig["retention"] | undefined) {
  if (!retention?.expireConversations) {
    return undefined;
  }
  return (
    Math.min(
      RETENTION_WARNING_DAYS,
      retention.conversationDays * RETENTION_WARNING_MAX_SHARE_OF_PERIOD
    ) * DAY_MS
  );
}

/** The retention date, once it is close enough to warn about on this instance. */
export function retentionWarningDate(
  retainedUntil: string,
  retention: SafeConfig["retention"] | undefined,
  now = Date.now()
): Date | undefined {
  const window = retentionWarningWindowMs(retention);
  if (window === undefined) {
    return undefined;
  }
  const date = new Date(retainedUntil);
  return date.getTime() - now <= window ? date : undefined;
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
