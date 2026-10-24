import type { UsageBreakdownDimension } from "@work-shape/catalyst-api-client";
import { USAGE_BREAKDOWN_DIMENSIONS } from "@work-shape/catalyst-core";
import {
  Banner,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader,
  SkeletonPage,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger
} from "@work-shape/catalyst-ui";
import { useState } from "react";
import {
  useSharedWorkspaceUsageQuery,
  useWorkspaceMemberUsageQuery
} from "../../../shared/api/usage-reports";
import { useTranslation } from "../../../shared/i18n";
import { useSettingsPage } from "../../../shared/settings-page-context";
import { apiErrorMessage } from "../../../shared/workspace-utils";
import {
  UsageBreakdownPanel,
  usageBreakdownFilter,
  usagePeriodDays,
  type UsageBreakdownState
} from "../../control-plane/usage-breakdown";
import { formatBillableCost } from "../../control-plane/usage-cost-format";
import { usageMonths, WorkspaceMembersUsagePanel } from "../../control-plane/usage-people";
import { DailyUsageCard, UsageActivityCard } from "../../control-plane/usage-view";

/** A workspace's own Breakdown: its usage is all in it, so it is not grouped by workspace. */
const WORKSPACE_DIMENSIONS: readonly UsageBreakdownDimension[] = USAGE_BREAKDOWN_DIMENSIONS.filter(
  (dimension) => dimension !== "workspace"
);

const WORKSPACE_USAGE_TABS = ["overview", "breakdown", "members"] as const;
type WorkspaceUsageTab = (typeof WORKSPACE_USAGE_TABS)[number];

/**
 * Workspace > Usage (LU-3): what the shared workspace used, for its Owners and Admins. The
 * figures per member show only for whoever holds `usage.view_users` for it.
 */
export function WorkspaceUsagePage() {
  const { apiBaseUrl, authScope, client, config, workspace } = useSettingsPage();
  const i18n = useTranslation();
  const { t, locale } = i18n;
  const [tab, setTab] = useState<WorkspaceUsageTab>("overview");
  const [state, setState] = useState<UsageBreakdownState>({
    period: "this_month",
    groupBy: "agent",
    path: []
  });
  const [month, setMonth] = useState(() => usageMonths()[0]);
  const agentLabel = (agentName: string) =>
    config.agents.find((agent) => agent.name === agentName)?.displayName;
  const query = useSharedWorkspaceUsageQuery({
    apiBaseUrl,
    authScope,
    client,
    collaborationWorkspaceId: workspace?.id ?? "",
    enabled: workspace !== undefined,
    query: {
      ...usagePeriodDays(state.period),
      groupBy: state.groupBy === "workspace" ? "agent" : state.groupBy,
      ...usageBreakdownFilter(state.path)
    }
  });
  const header = <PageHeader title={t("usageReports.workspacePage")} />;
  if (query.error && !query.data) {
    return (
      <>
        {header}
        <Banner tone="danger">
          {apiErrorMessage(query.error, t("usageReports.loadFailed")) ??
            t("usageReports.loadFailed")}
        </Banner>
      </>
    );
  }
  const usage = query.data;
  if (!usage || !workspace) {
    return (
      <>
        {header}
        <SkeletonPage />
      </>
    );
  }
  return (
    <>
      {header}
      <Tabs
        className="grid min-w-0 gap-4"
        value={tab}
        onValueChange={(value) => {
          const next = WORKSPACE_USAGE_TABS.find((candidate) => candidate === value);
          if (next) setTab(next);
        }}
      >
        <TabsList label={t("usageReports.tabs")}>
          <TabsTrigger value="overview">{t("usageReports.tabOverview")}</TabsTrigger>
          <TabsTrigger value="breakdown">{t("usageReports.tabBreakdown")}</TabsTrigger>
          {usage.membersVisible ? (
            <TabsTrigger value="members">{t("usageReports.tabMembers")}</TabsTrigger>
          ) : null}
        </TabsList>
        <TabsContent value="overview" className="grid min-w-0 content-start gap-4">
          <Card padding="md" data-testid="workspace-usage-month">
            <CardHeader>
              <CardTitle>
                {t("usageReports.workspaceMonth", { name: usage.workspaceName })}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-1">
              <p className="text-title">{formatBillableCost(usage.month.cost, i18n)}</p>
              <p className="text-caption text-muted-foreground">
                {t("settings.usageCallsAndTokens", {
                  calls: usage.month.modelCallCount.toLocaleString(locale),
                  tokens: usage.month.totalTokens.toLocaleString(locale)
                })}
              </p>
            </CardContent>
          </Card>
          <UsageActivityCard activity={usage.activity} />
          <DailyUsageCard
            days={usage.days}
            defaultMetric={usage.month.cost.complete ? "cost" : "tokens"}
            title={t("usageReports.dailyThisMonth")}
          />
        </TabsContent>
        <TabsContent value="breakdown" className="min-w-0">
          <UsageBreakdownPanel
            state={state}
            onStateChange={setState}
            breakdown={usage.breakdown}
            loading={query.isPlaceholderData}
            dimensions={WORKSPACE_DIMENSIONS}
            agentLabel={agentLabel}
          />
        </TabsContent>
        {usage.membersVisible ? (
          <TabsContent value="members" className="min-w-0">
            {tab === "members" ? (
              <WorkspaceMembers workspaceId={workspace.id} month={month} onMonthChange={setMonth} />
            ) : null}
          </TabsContent>
        ) : null}
      </Tabs>
    </>
  );
}

/** Asked only while its tab is open: each answer is an audit event of who looked. */
function WorkspaceMembers({
  workspaceId,
  month,
  onMonthChange
}: {
  workspaceId: string;
  month: string;
  onMonthChange(month: string): void;
}) {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const { t } = useTranslation();
  const query = useWorkspaceMemberUsageQuery({
    apiBaseUrl,
    authScope,
    client,
    collaborationWorkspaceId: workspaceId,
    month
  });
  return (
    <WorkspaceMembersUsagePanel
      members={query.data}
      month={month}
      onMonthChange={onMonthChange}
      {...(query.error
        ? { error: apiErrorMessage(query.error, t("usageReports.loadFailed")) }
        : {})}
    />
  );
}
