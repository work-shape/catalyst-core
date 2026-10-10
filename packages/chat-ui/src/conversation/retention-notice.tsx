import { Clock } from "lucide-react";
import type { SafeConfig } from "@vivd-catalyst/api-client";
import { Banner } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import { retentionWarningDate, retentionWarningText } from "./retention-warning";

/**
 * Says in the open conversation that it is about to be deleted, and whether a new message keeps
 * it. Shows nothing while the date is far, or on an instance that deletes nothing for age.
 */
export function RetentionNotice({
  retention,
  retainedUntil
}: {
  retention: SafeConfig["retention"] | undefined;
  /** The open conversation's retention date; absent while none is open or loaded. */
  retainedUntil: string | undefined;
}) {
  const { locale, t } = useTranslation();
  const expiresAt = retainedUntil ? retentionWarningDate(retainedUntil, retention) : undefined;
  if (!expiresAt) {
    return null;
  }
  const hint = retentionWarningText(expiresAt, { locale, t });
  return (
    <Banner
      layout="line"
      tone="warning"
      icon={<Clock aria-hidden="true" />}
      className="mb-2 px-1"
      data-testid="conversation-retention-notice"
    >
      {/* An API from before the setting does not say; the promise is made only when it does. */}
      {retention?.extendOnActivity === true
        ? t("conversationRetentionNoticeKeptByMessage", { hint })
        : t("conversationRetentionNotice", { hint })}
    </Banner>
  );
}
