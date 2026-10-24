import {
  Activity,
  AppWindow,
  Bot,
  CalendarDays,
  DollarSign,
  MessagesSquare,
  Search,
  ShieldCheck,
  Users,
  Workflow
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { PERSONAL_WORKSPACES_KEY, type ModelUsageRefusal } from "@work-shape/catalyst-core";
import type {
  ModelUsageDailyBucket,
  ModelUsageMonthlyBucket,
  UsageActivity,
  UsageSummary
} from "@work-shape/catalyst-api-client";
import {
  Badge,
  Banner,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Chart,
  cn,
  EmptyState,
  PageHeader,
  SegmentedControl,
  SegmentedControlItem,
  SkeletonPage,
  Table,
  TableBody,
  TableCell,
  TableCellDetail,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger
} from "@work-shape/catalyst-ui";
import { formatDate, formatTime } from "../../shared/locale-format";
import { usageCaller, usageRegion, usageStatus } from "./usage-attribution-labels";
import {
  formatBillableCost,
  formatMicrosCost,
  formatWebSearchBillableCost
} from "./usage-cost-format";
import {
  useTranslation,
  type TranslationContextValue,
  type TranslationKey
} from "../../shared/i18n";

/** Why the summary could not be read; a refusal is no failure and is said as information. */
interface UsageLoadProblem {
  message: string;
  refused: boolean;
}

/** The tabs of the Usage page (LU-3). Limits stays a page of its own. */
const USAGE_TABS = ["overview", "breakdown", "users", "recent"] as const;
export type UsageTab = (typeof USAGE_TABS)[number];

export function UsageView({
  usage,
  error,
  agentLabel = () => undefined,
  breakdown,
  users,
  tab,
  onTabChange
}: {
  /** Absent while the summary loads. */
  usage: UsageSummary | undefined;
  /** Why the summary could not be loaded. */
  error?: UsageLoadProblem;
  /** The display name of an agent by its id, in the person's language. */
  agentLabel?: (agentName: string) => string | undefined;
  /** The Breakdown tab's content; without it the page has no such tab. */
  breakdown?: ReactNode;
  /**
   * The Users tab's content, for a viewer with the right to see usage by person; without it
   * the page has no such tab. It is rendered only while its tab is open.
   */
  users?: ReactNode;
  /** The open tab, where the caller keeps it; else the page keeps it, starting on Overview. */
  tab?: UsageTab;
  onTabChange?(tab: UsageTab): void;
}) {
  const i18n = useTranslation();
  const { t, locale } = i18n;
  const recentEvents = usage?.recentEvents ?? [];
  const showWebSearchCosts = shouldShowWebSearchCosts(usage);
  const callsAndTokens = (window: UsageWindow | undefined) =>
    t("settings.usageCallsAndTokens", {
      calls: (window?.modelCallCount ?? 0).toLocaleString(locale),
      tokens: (window?.totalTokens ?? 0).toLocaleString(locale)
    });
  const header = <PageHeader title={t("settings.usage")} />;
  if (error) {
    return (
      <>
        {header}
        <Banner tone={error.refused ? "info" : "danger"}>{error.message}</Banner>
      </>
    );
  }
  if (!usage) {
    return (
      <>
        {header}
        <SkeletonPage />
      </>
    );
  }
  // Nothing was ever recorded: the month, then one sentence, and no charts with empty axes.
  if (usage.allTime.modelCallCount === 0 && recentEvents.length === 0) {
    return (
      <>
        {header}
        <div className="grid min-w-0 grid-cols-1 content-start gap-4">
          <UsageMonthCard usage={usage} />
          <EmptyState>{t("settings.usageMonthlyEmpty")}</EmptyState>
        </div>
      </>
    );
  }
  return (
    <>
      {header}
      <Tabs
        className="grid min-w-0 gap-4"
        defaultValue="overview"
        {...(tab === undefined ? {} : { value: tab })}
        onValueChange={(value) => {
          const next = USAGE_TABS.find((candidate) => candidate === value);
          if (next) onTabChange?.(next);
        }}
      >
        <TabsList label={t("usageReports.tabs")}>
          <TabsTrigger value="overview">{t("usageReports.tabOverview")}</TabsTrigger>
          {breakdown === undefined ? null : (
            <TabsTrigger value="breakdown">{t("usageReports.tabBreakdown")}</TabsTrigger>
          )}
          {users === undefined ? null : (
            <TabsTrigger value="users">{t("usageReports.tabUsers")}</TabsTrigger>
          )}
          <TabsTrigger value="recent">{t("usageReports.tabRecent")}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="grid min-w-0 grid-cols-1 content-start gap-4">
          <UsageMonthCard usage={usage} />
          {usage.activity ? <UsageActivityCard activity={usage.activity} /> : null}
          <div className="grid gap-3 md:auto-cols-fr md:grid-flow-col">
            <UsageMetric
              icon={<DollarSign size={15} />}
              label={t("settings.usageBillableToday")}
              value={formatBillableCost(usage.today.cost, i18n)}
              detail={callsAndTokens(usage.today)}
            />
            {showWebSearchCosts ? (
              <UsageMetric
                icon={<Search size={15} />}
                label={t("settings.usageWebSearchBillable")}
                value={formatWebSearchBillableCost(usage.currentMonth.cost, i18n)}
                detail={t("settings.usageSearchesMonthCount", {
                  count: usage.currentMonth.webSearchCallCount.toLocaleString(locale)
                })}
              />
            ) : null}
            <UsageMetric
              icon={<DollarSign size={15} />}
              label={t("settings.usageBillableAllTime")}
              value={formatBillableCost(usage.allTime.cost, i18n)}
              detail={callsAndTokens(usage.allTime)}
            />
          </div>

          <DailyUsageCard
            days={usage.dailyUsage}
            defaultMetric={usage.allTime.cost.complete ? "cost" : "tokens"}
          />

          <MonthlyHistoryCard
            months={usage?.monthlyUsage ?? []}
            showWebSearchCosts={showWebSearchCosts}
          />

          {showWebSearchCosts ? (
            <Card data-testid="web-search-usage">
              <CardHeader className="p-4 pb-2">
                <CardTitle className="text-base">{t("settings.usageWebSearchTitle")}</CardTitle>
              </CardHeader>
              <CardContent className="p-4 pt-2">
                <dl className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <UsageStat
                    icon={<Search size={15} />}
                    label={t("settings.usageSearchesToday")}
                    value={usage?.today.webSearchCallCount ?? 0}
                  />
                  <UsageStat
                    icon={<Search size={15} />}
                    label={t("settings.usageSearchesMonth")}
                    value={usage?.currentMonth.webSearchCallCount ?? 0}
                  />
                  <UsageStat
                    icon={<DollarSign size={15} />}
                    label={t("settings.usageSearchCostToday")}
                    value={formatWebSearchBillableCost(usage?.today.cost, i18n)}
                  />
                  <UsageStat
                    icon={<DollarSign size={15} />}
                    label={t("settings.usageSearchCostMonth")}
                    value={formatWebSearchBillableCost(usage?.currentMonth.cost, i18n)}
                  />
                </dl>
              </CardContent>
            </Card>
          ) : null}

          <Card data-testid="configured-safeguards">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-base">{t("settings.usageSafeguards")}</CardTitle>
              <p className="text-caption text-muted-foreground" data-usage-safeguards-meaning="">
                {t("settings.usageSafeguardsMeaning")}
              </p>
            </CardHeader>
            <CardContent className="p-4 pt-2">
              <dl className="grid gap-3 md:grid-cols-3">
                <UsageStat
                  icon={<ShieldCheck size={15} />}
                  label={t("settings.usageSafeguardCallsPerDay")}
                  value={usage?.safeguards.modelCallsPerDay}
                />
                <UsageStat
                  icon={<ShieldCheck size={15} />}
                  label={t("settings.usageSafeguardTokensPerDay")}
                  value={usage?.safeguards.tokensPerDay}
                />
                <UsageStat
                  icon={<ShieldCheck size={15} />}
                  label={t("settings.usageSafeguardTokensPerMonth")}
                  value={usage?.safeguards.tokensPerMonth}
                />
              </dl>
            </CardContent>
          </Card>
        </TabsContent>
        {breakdown === undefined ? null : <TabsContent value="breakdown">{breakdown}</TabsContent>}
        {users === undefined ? null : <TabsContent value="users">{users}</TabsContent>}
        <TabsContent value="recent">
          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-base">{t("settings.usageRecentTitle")}</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-1">
              {recentEvents.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("settings.time")}</TableHead>
                      <TableHead>{t("settings.usageCallerAndModel")}</TableHead>
                      <TableHead>{t("usageReports.workspaceColumn")}</TableHead>
                      <TableHead>{t("settings.usageProviderAndRegion")}</TableHead>
                      <TableHead>{t("settings.usageTokens")}</TableHead>
                      <TableHead>{t("settings.usageBillableAndStatus")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recentEvents.map((event) => {
                      const running = event.status === "pending";
                      return (
                        <TableRow key={event.id}>
                          <TableCell className="whitespace-nowrap">
                            {formatDate(event.createdAt, locale)}
                            <TableCellDetail>{formatTime(event.createdAt, locale)}</TableCellDetail>
                          </TableCell>
                          <TableCell className="break-words">
                            {usageCaller(event, t, agentLabel)}
                            <TableCellDetail>
                              {event.billedAsFast
                                ? t("settings.usageModelFast", { model: event.model })
                                : event.model}
                            </TableCellDetail>
                          </TableCell>
                          <TableCell className="break-words">
                            {event.workspace === undefined
                              ? t("usageReports.noWorkspace")
                              : event.workspace.key === PERSONAL_WORKSPACES_KEY
                                ? t("usageReports.personalWorkspace")
                                : (event.workspace.name ?? t("usageReports.deletedWorkspace"))}
                          </TableCell>
                          <TableCell className="break-words">
                            {event.providerId}
                            <TableCellDetail>{usageRegion(event.region, t)}</TableCellDetail>
                          </TableCell>
                          <TableCell>
                            {running
                              ? t("settings.usageUnknown")
                              : event.totalTokens.toLocaleString(locale)}
                            {running || event.totalTokens === 0 ? null : (
                              <TableCellDetail>
                                {event.cachedInputTokens === undefined
                                  ? t("settings.usageCachedNotReported")
                                  : t("settings.usageCachedCount", {
                                      count: event.cachedInputTokens.toLocaleString(locale)
                                    })}
                              </TableCellDetail>
                            )}
                          </TableCell>
                          <TableCell>
                            {running
                              ? t("settings.usageUnknown")
                              : formatBillableCost(event.cost, i18n)}
                            {showWebSearchCosts && event.webSearchCallCount > 0 ? (
                              <TableCellDetail>
                                {t("settings.usageDaySearches", {
                                  count: event.webSearchCallCount.toLocaleString(locale),
                                  amount: formatWebSearchBillableCost(event.cost, i18n)
                                })}
                              </TableCellDetail>
                            ) : null}
                            <TableCellDetail>{usageStatus(event, t)}</TableCellDetail>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              ) : (
                <p className="pt-1 text-sm text-muted-foreground">
                  {t("settings.usageRecentEmpty")}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}

type DailyUsageMetric = "cost" | "tokens";
type UsageWindow = UsageSummary["today"];
type BudgetPeriod = ModelUsageRefusal["period"];

/** The messages of a spend budget, by the period it covers. */
const BUDGET_TEXT_KEYS: Record<
  BudgetPeriod,
  { label: TranslationKey; blocked: TranslationKey; remaining: TranslationKey }
> = {
  day: {
    label: "settings.usageBudgetDaily",
    blocked: "settings.usageBudgetBlockedToday",
    remaining: "settings.usageBudgetRemainingToday"
  },
  month: {
    label: "settings.usageBudgetMonthly",
    blocked: "settings.usageBudgetBlockedMonth",
    remaining: "settings.usageBudgetRemainingMonth"
  }
};

/**
 * The month in one answer: what it cost, against the monthly budget when the budget counts all
 * of it, with its calls and tokens under it, then how each configured budget stands, up to the
 * block once one is reached. A budget reads only the spend the server counts against it, which
 * leaves out knowledge base ingestion; an older server that does not say it shows it unknown.
 */
function UsageMonthCard({ usage }: { usage: UsageSummary }) {
  const i18n = useTranslation();
  const { t, locale } = i18n;
  const month = usage.currentMonth;
  const { spendBudget } = usage;
  const currency = spendBudget.currency ?? month.cost.currency;
  const totalMicros = month.cost.billableCostMicros;
  const monthlyLimitMicros = spendBudget.monthlyLimitMicros;
  const costUnknown = totalMicros === undefined || currency === undefined;
  const headlineSaysBudget =
    !costUnknown &&
    monthlyLimitMicros !== undefined &&
    spendBudget.monthlySpentMicros === totalMicros;
  const budgets = [
    {
      period: "month" as const,
      spentMicros: spendBudget.monthlySpentMicros,
      limitMicros: monthlyLimitMicros
    },
    {
      period: "day" as const,
      spentMicros: spendBudget.dailySpentMicros,
      limitMicros: spendBudget.dailyLimitMicros
    }
  ].filter((budget): budget is SpendBudgetProgressInput => budget.limitMicros !== undefined);
  const budgetLeavesOutCost = [
    [spendBudget.monthlySpentMicros, totalMicros],
    [spendBudget.dailySpentMicros, usage.today.cost.billableCostMicros]
  ].some(([spent, total]) => spent !== undefined && total !== undefined && spent !== total);
  const cost = costUnknown
    ? t("settings.usageCostNotKnownYet")
    : headlineSaysBudget
      ? t("settings.usageBudgetSpent", {
          spent: formatMicrosCost(totalMicros, currency, i18n),
          limit: formatMicrosCost(monthlyLimitMicros, currency, i18n)
        })
      : formatMicrosCost(totalMicros, currency, i18n);

  const projectedMicros = costUnknown ? undefined : projectMonth(totalMicros, usage.generatedAt);

  return (
    <Card padding="md" data-testid="usage-month-budget">
      <CardHeader>
        <CardTitle>{t("settings.usageThisMonth")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="grid gap-1">
          <p className="text-title" data-testid="usage-month-cost">
            {cost}
          </p>
          <p className="text-caption text-muted-foreground">
            {t("settings.usageCallsAndTokens", {
              calls: month.modelCallCount.toLocaleString(locale),
              tokens: month.totalTokens.toLocaleString(locale)
            })}
          </p>
          {projectedMicros === undefined || currency === undefined ? null : (
            <p className="text-caption text-muted-foreground" data-testid="usage-month-projection">
              {t("usageReports.projection", {
                amount: formatMicrosCost(projectedMicros, currency, i18n)
              })}
            </p>
          )}
          {budgetLeavesOutCost ? (
            <p className="text-caption text-muted-foreground" data-testid="usage-budget-scope">
              {t("settings.usageBudgetExcludesKnowledge")}
            </p>
          ) : null}
        </div>
        {budgets.length ? (
          <div className="grid gap-5 md:grid-cols-2">
            {budgets.map((budget) => (
              <SpendBudgetProgress
                key={budget.period}
                {...budget}
                currency={currency}
                headlineSaysCostUnknown={costUnknown}
                saysSpent={budget.period === "day" || !headlineSaysBudget}
              />
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

interface SpendBudgetProgressInput {
  period: BudgetPeriod;
  spentMicros: number | undefined;
  limitMicros: number;
}

function SpendBudgetProgress({
  period,
  spentMicros,
  limitMicros,
  currency,
  headlineSaysCostUnknown,
  saysSpent
}: SpendBudgetProgressInput & {
  currency?: string;
  headlineSaysCostUnknown: boolean;
  /** False where the card's headline already says this spend against its budget. */
  saysSpent: boolean;
}) {
  const i18n = useTranslation();
  const { t } = i18n;
  const text = BUDGET_TEXT_KEYS[period];
  const label = t(text.label);
  if (spentMicros === undefined || currency === undefined) {
    return (
      <div>
        <p className="text-sm font-medium">{label}</p>
        {/* The headline cannot say the budget beside an unknown cost, so it stands here. */}
        {currency === undefined ? null : (
          <p className="text-xs text-muted-foreground" data-testid="usage-budget-limit">
            {formatMicrosCost(limitMicros, currency, i18n)}
          </p>
        )}
        {/* The card says an unknown cost once: in its headline, or here when only today's is. */}
        {headlineSaysCostUnknown ? null : (
          <p className="text-xs text-muted-foreground">{t("settings.usageBudgetIncomplete")}</p>
        )}
      </div>
    );
  }
  const percentage = limitMicros > 0 ? (spentMicros / limitMicros) * 100 : 100;
  const displayedPercentage = Math.round(percentage);
  const barPercentage = Math.min(Math.max(percentage, 0), 100);
  const remainingMicros = Math.max(limitMicros - spentMicros, 0);
  const reached = spentMicros >= limitMicros;

  return (
    <div className="grid gap-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{label}</p>
          {saysSpent ? (
            <p className="text-xs text-muted-foreground">
              {t("settings.usageBudgetSpent", {
                spent: formatMicrosCost(spentMicros, currency, i18n),
                limit: formatMicrosCost(limitMicros, currency, i18n)
              })}
            </p>
          ) : null}
        </div>
        <Badge tone={reached ? "accent" : "neutral"}>
          {reached
            ? t("settings.usageBudgetLimitReached")
            : t("settings.usageBudgetPercentUsed", { percent: displayedPercentage })}
        </Badge>
      </div>
      <div
        className="h-2.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={t("settings.usageBudgetUsedLabel", { budget: label })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(displayedPercentage, 100)}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            reached ? "bg-destructive" : percentage >= 80 ? "bg-warning" : "bg-primary"
          )}
          style={{ width: `${barPercentage}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {reached
          ? t(text.blocked)
          : t(text.remaining, { amount: formatMicrosCost(remainingMicros, currency, i18n) })}
      </p>
    </div>
  );
}

/** Spend or tokens per UTC day, drawn by the library's chart. */
export function DailyUsageCard({
  days,
  defaultMetric
}: {
  days: ModelUsageDailyBucket[];
  defaultMetric: DailyUsageMetric;
}) {
  const { t, locale } = useTranslation();
  const [metric, setMetric] = useState<DailyUsageMetric>(defaultMetric);
  const dayCount = days.length || 30;
  const currency = days.find((bucket) => bucket.cost.currency !== undefined)?.cost.currency;
  const showsCost = metric === "cost" && currency !== undefined;
  const label = showsCost ? t("usageReports.dailyChart") : t("usageReports.dailyChartTokens");
  // A day whose cost is not whole is a gap, not a zero.
  const rows = days.map((bucket) => ({
    day: formatUtcDay(bucket.date, locale),
    value: showsCost
      ? bucket.cost.complete && bucket.cost.billableCostMicros !== undefined
        ? bucket.cost.billableCostMicros / 1_000_000
        : null
      : bucket.totalTokens
  }));
  const hasUsage = days.some((bucket) => bucket.modelCallCount > 0);

  return (
    <Card data-testid="daily-usage">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 p-4 pb-2">
        <CardTitle className="inline-flex items-center gap-2 text-base">
          <CalendarDays size={15} aria-hidden="true" className="text-muted-foreground" />
          {t("settings.usageDailyTitle", { count: dayCount })}
        </CardTitle>
        <SegmentedControl
          size="sm"
          label={t("settings.usageChartMetric")}
          value={metric}
          onValueChange={(value) => setMetric(value === "tokens" ? "tokens" : "cost")}
        >
          <SegmentedControlItem value="cost">{t("settings.usageBillable")}</SegmentedControlItem>
          <SegmentedControlItem value="tokens">{t("settings.usageTokens")}</SegmentedControlItem>
        </SegmentedControl>
      </CardHeader>
      <CardContent className="p-4 pt-3">
        {hasUsage ? (
          <Chart
            type="bar"
            height={200}
            rows={rows}
            x="day"
            series={[{ field: "value", label }]}
            format={
              showsCost && currency !== undefined
                ? { style: "currency", currency }
                : { style: "number", maximumFractionDigits: 0 }
            }
            locale={locale}
            ariaLabel={label}
            emptyLabel={t("settings.usageDailyEmpty", { count: dayCount })}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("settings.usageDailyEmpty", { count: dayCount })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** What was started this month: counted from the records that exist, no click is tracked. */
export function UsageActivityCard({ activity }: { activity: UsageActivity }) {
  const { t } = useTranslation();
  return (
    <Card data-testid="usage-activity">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="inline-flex items-center gap-2 text-base">
          <Activity size={15} aria-hidden="true" className="text-muted-foreground" />
          {t("usageReports.activityTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-2">
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <UsageStat
            icon={<Users size={15} />}
            label={t("usageReports.activeUsers")}
            value={activity.activeUsers}
          />
          <UsageStat
            icon={<MessagesSquare size={15} />}
            label={t("usageReports.conversations")}
            value={activity.conversations}
          />
          <UsageStat
            icon={<Bot size={15} />}
            label={t("usageReports.agentRuns")}
            value={activity.agentRuns}
          />
          <UsageStat
            icon={<AppWindow size={15} />}
            label={t("usageReports.appActionRuns")}
            value={activity.appActionRuns}
          />
          <UsageStat
            icon={<Workflow size={15} />}
            label={t("usageReports.workflowRuns")}
            value={activity.workflowRuns}
          />
        </dl>
      </CardContent>
    </Card>
  );
}

function MonthlyHistoryCard({
  months,
  showWebSearchCosts
}: {
  months: ModelUsageMonthlyBucket[];
  showWebSearchCosts: boolean;
}) {
  const i18n = useTranslation();
  const { t, locale } = i18n;
  const rows = [...months].reverse();
  return (
    <Card data-testid="monthly-usage">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base">{t("settings.usageMonthlyTitle")}</CardTitle>
        <p className="text-xs text-muted-foreground">{t("settings.usageMonthlyDescription")}</p>
      </CardHeader>
      <CardContent className="p-4 pt-1">
        {rows.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("settings.usageMonth")}</TableHead>
                <TableHead>{t("settings.usageCalls")}</TableHead>
                <TableHead>{t("settings.usageTokens")}</TableHead>
                <TableHead>{t("settings.usageCachedInput")}</TableHead>
                {showWebSearchCosts ? <TableHead>{t("settings.usageSearches")}</TableHead> : null}
                {showWebSearchCosts ? (
                  <TableHead>{t("settings.usageSearchBillable")}</TableHead>
                ) : null}
                <TableHead className="text-right">{t("settings.usageBillable")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((month, index) => (
                <TableRow key={month.month}>
                  <TableCell className="font-medium whitespace-nowrap">
                    {formatUtcMonth(month.month, locale)}
                    {index === 0 ? (
                      <Badge className="ml-2">{t("settings.usageCurrentMonth")}</Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {month.modelCallCount.toLocaleString(locale)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {month.totalTokens.toLocaleString(locale)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {month.cachedInputTokens.toLocaleString(locale)}
                  </TableCell>
                  {showWebSearchCosts ? (
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {month.webSearchCallCount.toLocaleString(locale)}
                    </TableCell>
                  ) : null}
                  {showWebSearchCosts ? (
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatWebSearchBillableCost(month.cost, i18n)}
                    </TableCell>
                  ) : null}
                  <TableCell className="text-right font-medium whitespace-nowrap">
                    {formatBillableCost(month.cost, i18n)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="pt-1 text-sm text-muted-foreground">{t("settings.usageMonthlyEmpty")}</p>
        )}
      </CardContent>
    </Card>
  );
}

function UsageMetric({
  icon,
  label,
  value,
  detail
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  detail?: string;
}) {
  return (
    <Card className="grid min-w-0 content-start gap-1.5 p-4">
      <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <span className="grid size-6 place-items-center rounded-md bg-accent text-primary">
          {icon}
        </span>
        {label}
      </span>
      <strong className="min-w-0 break-words text-2xl font-semibold">{value}</strong>
      {detail ? <small className="text-xs text-muted-foreground">{detail}</small> : null}
    </Card>
  );
}

function UsageStat({
  icon,
  label,
  value
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode | undefined;
}) {
  const { t, locale } = useTranslation();
  return (
    <div className="min-w-0 rounded-md border bg-card p-3">
      <dt className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </dt>
      <dd className="mt-1 break-words font-medium">
        {value === undefined
          ? t("settings.usageNotConfigured")
          : typeof value === "number"
            ? value.toLocaleString(locale)
            : value}
      </dd>
    </div>
  );
}

type LocaleCode = TranslationContextValue["locale"];

const DAY_MS = 86_400_000;

/**
 * The month's spend carried on in a straight line to its last day: spent so far over the days
 * gone, at least one, times the days of the month. Nothing while nothing is spent.
 */
function projectMonth(spentMicros: number, at: string): number | undefined {
  if (spentMicros <= 0) return undefined;
  const now = new Date(at);
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const gone = Math.max((now.getTime() - start) / DAY_MS, 1);
  return Math.round((spentMicros / gone) * ((end - start) / DAY_MS));
}

function formatUtcDay(date: string, locale: LocaleCode): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    timeZone: "UTC"
  }).format(new Date(date));
}

function formatUtcMonth(month: string, locale: LocaleCode): string {
  return new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(`${month}-01`));
}

function shouldShowWebSearchCosts(usage: UsageSummary | undefined): boolean {
  if (!usage) {
    return false;
  }
  return (
    usage.today.cost.webSearchCostVisible ||
    usage.currentMonth.cost.webSearchCostVisible ||
    usage.allTime.cost.webSearchCostVisible ||
    usage.recentEvents.some((event) => event.cost.webSearchCostVisible)
  );
}
