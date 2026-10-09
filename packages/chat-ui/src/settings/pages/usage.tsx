import { useWorkspaceUsageQuery } from "../../api/workspace-queries";
import { UsageView } from "../../control-plane/usage-view";
import { apiErrorMessage } from "../../workspace-utils";
import { useSettingsPage } from "../settings-page-context";

/** Instance > Usage: model usage and budgets, with its own data. */
export function UsagePage() {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const usageQuery = useWorkspaceUsageQuery({ apiBaseUrl, authScope, client, enabled: true });

  return (
    <UsageView
      usage={usageQuery.data}
      error={usageQuery.error ? apiErrorMessage(usageQuery.error, undefined) : undefined}
    />
  );
}
