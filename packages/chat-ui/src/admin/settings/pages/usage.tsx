import { useWorkspaceUsageQuery } from "../../../shared/api/workspace-queries";
import { UsageView } from "../../control-plane/usage-view";
import { useTranslation } from "../../../shared/i18n";
import { apiErrorMessage } from "../../../shared/workspace-utils";
import { useSettingsPage } from "../../../shared/settings-page-context";
import { isRefusal, refusalAskingInstanceAdmin } from "../ask-instance-admin";

/** Instance > Usage: model usage and budgets, with its own data. */
export function UsagePage() {
  const { apiBaseUrl, authScope, client, user } = useSettingsPage();
  const { t } = useTranslation();
  const usageQuery = useWorkspaceUsageQuery({ apiBaseUrl, authScope, client, enabled: true });
  const error = usageQuery.error;

  return (
    <UsageView
      usage={usageQuery.data}
      error={
        !error
          ? undefined
          : isRefusal(error)
            ? {
                message: refusalAskingInstanceAdmin(
                  t("settings.usageRefused"),
                  t,
                  user.instanceAdminName
                ),
                refused: true
              }
            : {
                message:
                  apiErrorMessage(error, t("settings.requestFailed")) ??
                  t("settings.requestFailed"),
                refused: false
              }
      }
    />
  );
}
