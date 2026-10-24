import { useState } from "react";
import {
  usePlatformContextQuery,
  useWorkspaceUsageQuery
} from "../../../shared/api/workspace-queries";
import { useUsageBreakdownQuery, useUsageUsersQuery } from "../../../shared/api/usage-reports";
import {
  UsageBreakdownPanel,
  usageBreakdownFilter,
  usagePeriodDays,
  type UsageBreakdownState
} from "../../control-plane/usage-breakdown";
import { UsageUsersPanel, usageMonths } from "../../control-plane/usage-people";
import { UsageView, type UsageTab } from "../../control-plane/usage-view";
import { useTranslation } from "../../../shared/i18n";
import { apiErrorMessage } from "../../../shared/workspace-utils";
import { useSettingsPage } from "../../../shared/settings-page-context";
import { isRefusal, refusalAskingInstanceAdmin } from "../ask-instance-admin";

/** Instance > Usage: Overview, Breakdown, Users for whoever may see them, and the recent calls. */
export function UsagePage() {
  const { apiBaseUrl, authScope, client, config, user } = useSettingsPage();
  const { t } = useTranslation();
  const api = { apiBaseUrl, authScope, client };
  const usageQuery = useWorkspaceUsageQuery({ ...api, enabled: true });
  const contextQuery = usePlatformContextQuery({ ...api, enabled: true });
  const [tab, setTab] = useState<UsageTab>("overview");
  const [breakdown, setBreakdown] = useState<UsageBreakdownState>({
    period: "this_month",
    groupBy: "workspace",
    path: []
  });
  const [month, setMonth] = useState(() => usageMonths()[0]);
  const viewsUsers = contextQuery.data?.instanceActions.includes("usage.view_users") === true;
  const error = usageQuery.error;
  const agentLabel = (agentName: string) =>
    config.agents.find((agent) => agent.name === agentName)?.displayName;

  return (
    <UsageView
      usage={usageQuery.data}
      agentLabel={agentLabel}
      tab={tab}
      onTabChange={setTab}
      breakdown={
        <InstanceBreakdown state={breakdown} onStateChange={setBreakdown} agentLabel={agentLabel} />
      }
      {...(viewsUsers
        ? {
            users: tab === "users" ? <InstanceUsers month={month} onMonthChange={setMonth} /> : null
          }
        : {})}
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

function InstanceBreakdown({
  state,
  onStateChange,
  agentLabel
}: {
  state: UsageBreakdownState;
  onStateChange(state: UsageBreakdownState): void;
  agentLabel(agentName: string): string | undefined;
}) {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const { t } = useTranslation();
  const query = useUsageBreakdownQuery({
    apiBaseUrl,
    authScope,
    client,
    query: {
      ...usagePeriodDays(state.period),
      groupBy: state.groupBy,
      ...usageBreakdownFilter(state.path)
    }
  });
  return (
    <UsageBreakdownPanel
      state={state}
      onStateChange={onStateChange}
      breakdown={query.data}
      loading={query.isPlaceholderData}
      {...(query.error
        ? { error: apiErrorMessage(query.error, t("usageReports.loadFailed")) }
        : {})}
      agentLabel={agentLabel}
    />
  );
}

/** Asked only while its tab is open: each answer is an audit event of who looked. */
function InstanceUsers({
  month,
  onMonthChange
}: {
  month: string;
  onMonthChange(month: string): void;
}) {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const { t } = useTranslation();
  const query = useUsageUsersQuery({ apiBaseUrl, authScope, client, month });
  return (
    <UsageUsersPanel
      users={query.data}
      month={month}
      onMonthChange={onMonthChange}
      {...(query.error
        ? { error: apiErrorMessage(query.error, t("usageReports.loadFailed")) }
        : {})}
    />
  );
}
