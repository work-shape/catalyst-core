import { CalendarDays, Database, DollarSign, Search, ShieldCheck } from "lucide-react";
import { useState, type ReactNode } from "react";
import type {
  ModelUsageDailyBucket,
  ModelUsageMonthlyBucket,
  UsageSummary
} from "@vivd-catalyst/api-client";
import {
  Badge,
  Banner,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  cn,
  EmptyState,
  PageHeader,
  SkeletonPage,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@vivd-catalyst/ui";
import { formatDateTime } from "./locale-format";
import { useTranslation, type TranslationContextValue, type TranslationKey } from "../i18n";

export function UsageView({
  usage,
  error
}: {
  /** Absent while the summary loads. */
  usage: UsageSummary | undefined;
  /** Why the summary could not be loaded. */
  error?: string;
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
  const header = (
    <PageHeader
      title={t("settings.usage")}
      description={
        usage
          ? t("settings.usageSummary", {
              calls: usage.currentMonth.modelCallCount.toLocaleString(locale),
              tokens: usage.currentMonth.totalTokens.toLocaleString(locale)
            })
          : undefined
      }
    />
  );
  if (error) {
    return (
      <>
        {header}
        <Banner tone="danger">{error}</Banner>
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
  // Nothing was ever recorded: one sentence, and no charts with empty axes.
  if (usage.allTime.modelCallCount === 0 && recentEvents.length === 0) {
    return (
      <>
        {header}
        <EmptyState>{t("settings.usageMonthlyEmpty")}</EmptyState>
      </>
    );
  }
  return (
    <>
      {header}
      <div className="grid min-w-0 content-start gap-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <UsageMetric
            icon={<DollarSign size={15} />}
            label={t("settings.usageBillableMonth")}
            value={formatBillableCost(usage?.currentMonth.cost, i18n)}
            detail={callsAndTokens(usage?.currentMonth)}
          />
          <UsageMetric
            icon={<DollarSign size={15} />}
            label={t("settings.usageBillableToday")}
            value={formatBillableCost(usage?.today.cost, i18n)}
            detail={callsAndTokens(usage?.today)}
          />
          {showWebSearchCosts ? (
            <UsageMetric
              icon={<Search size={15} />}
              label={t("settings.usageWebSearchBillable")}
              value={formatWebSearchBillableCost(usage?.currentMonth.cost, i18n)}
              detail={t("settings.usageSearchesMonthCount", {
                count: (usage?.currentMonth.webSearchCallCount ?? 0).toLocaleString(locale)
              })}
            />
          ) : (
            <UsageMetric
              icon={<Database size={15} />}
              label={t("settings.usageTokensMonth")}
              value={(usage?.currentMonth.totalTokens ?? 0).toLocaleString(locale)}
            />
          )}
          <UsageMetric
            icon={<DollarSign size={15} />}
            label={t("settings.usageBillableAllTime")}
            value={formatBillableCost(usage?.allTime.cost, i18n)}
            detail={callsAndTokens(usage?.allTime)}
          />
        </div>

        <SpendBudgetCard usage={usage} />

        <DailyUsageCard
          days={usage?.dailyUsage ?? []}
          defaultMetric={usage?.allTime.cost.complete ? "cost" : "tokens"}
          showWebSearchCosts={showWebSearchCosts}
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
                    <TableHead>{t("settings.usageModel")}</TableHead>
                    <TableHead>{t("settings.usageTokens")}</TableHead>
                    <TableHead>{t("settings.usageCachedInput")}</TableHead>
                    <TableHead>{t("settings.usageBillable")}</TableHead>
                    {showWebSearchCosts ? (
                      <TableHead>{t("settings.usageWebSearch")}</TableHead>
                    ) : null}
                    {showWebSearchCosts ? (
                      <TableHead>{t("settings.usageSearchBillable")}</TableHead>
                    ) : null}
                    <TableHead>{t("settings.usageSource")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentEvents.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDateTime(event.createdAt, locale)}
                      </TableCell>
                      <TableCell className="font-medium break-words">
                        {event.billedAsFast
                          ? t("settings.usageModelFast", { model: event.model })
                          : event.model}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {event.totalTokens.toLocaleString(locale)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {event.cachedInputTokens?.toLocaleString(locale) ??
                          t("settings.usageUnknown")}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatBillableCost(event.cost, i18n)}
                      </TableCell>
                      {showWebSearchCosts ? (
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {event.webSearchCallCount.toLocaleString(locale)}
                        </TableCell>
                      ) : null}
                      {showWebSearchCosts ? (
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {formatWebSearchBillableCost(event.cost, i18n)}
                        </TableCell>
                      ) : null}
                      <TableCell className="text-muted-foreground">{event.source}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="pt-1 text-sm text-muted-foreground">{t("settings.usageRecentEmpty")}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

type DailyUsageMetric = "cost" | "tokens";
type UsageWindow = UsageSummary["today"];
type BudgetPeriod = "day" | "month";

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

function SpendBudgetCard({ usage }: { usage: UsageSummary | undefined }) {
  const { t } = useTranslation();
  const currency = usage?.spendBudget.currency ?? usage?.today.cost.currency;
  const budgets = [
    {
      period: "day" as const,
      spentMicros: usage?.today.cost.billableCostMicros,
      limitMicros: usage?.spendBudget.dailyLimitMicros
    },
    {
      period: "month" as const,
      spentMicros: usage?.currentMonth.cost.billableCostMicros,
      limitMicros: usage?.spendBudget.monthlyLimitMicros
    }
  ].filter((budget): budget is SpendBudgetProgressInput => budget.limitMicros !== undefined);

  return (
    <Card data-testid="spend-budget-progress">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base">{t("settings.usageBudgets")}</CardTitle>
        <p className="text-xs text-muted-foreground">{t("settings.usageBudgetsDescription")}</p>
      </CardHeader>
      <CardContent className="p-4 pt-2">
        {budgets.length ? (
          <div className="grid gap-5 md:grid-cols-2">
            {budgets.map((budget) => (
              <SpendBudgetProgress key={budget.period} {...budget} currency={currency} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("settings.usageBudgetsEmpty")}</p>
        )}
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
  currency
}: SpendBudgetProgressInput & { currency?: string }) {
  const i18n = useTranslation();
  const { t } = i18n;
  const text = BUDGET_TEXT_KEYS[period];
  const label = t(text.label);
  if (spentMicros === undefined || currency === undefined) {
    return (
      <div className="grid gap-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium">{label}</p>
            <p className="text-xs text-muted-foreground">{t("settings.usageBudgetIncomplete")}</p>
          </div>
          <Badge>{t("settings.usageIncomplete")}</Badge>
        </div>
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
          <p className="text-xs text-muted-foreground">
            {t("settings.usageBudgetSpent", {
              spent: formatMicrosCost(spentMicros, currency, i18n),
              limit: formatMicrosCost(limitMicros, currency, i18n)
            })}
          </p>
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
            reached ? "bg-destructive" : percentage >= 80 ? "bg-amber-500" : "bg-primary"
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

function DailyUsageCard({
  days,
  defaultMetric,
  showWebSearchCosts
}: {
  days: ModelUsageDailyBucket[];
  defaultMetric: DailyUsageMetric;
  showWebSearchCosts: boolean;
}) {
  const { t, locale } = useTranslation();
  const [metric, setMetric] = useState<DailyUsageMetric>(defaultMetric);
  const dayCount = days.length || 30;
  const values = days.map((day) =>
    metric === "cost" ? (day.cost.billableCostMicros ?? 0) : day.totalTokens
  );
  const maxValue = Math.max(...values, 1);
  const hasUsage = values.some((value) => value > 0);

  return (
    <Card data-testid="daily-usage">
      <CardHeader className="flex flex-row items-center justify-between p-4 pb-2">
        <CardTitle className="inline-flex items-center gap-2 text-base">
          <CalendarDays size={15} aria-hidden="true" className="text-muted-foreground" />
          {t("settings.usageDailyTitle", { count: dayCount })}
        </CardTitle>
        <div
          className="flex items-center gap-0.5 rounded-md border p-0.5"
          role="group"
          aria-label={t("settings.usageChartMetric")}
        >
          <MetricToggleButton active={metric === "cost"} onClick={() => setMetric("cost")}>
            {t("settings.usageBillable")}
          </MetricToggleButton>
          <MetricToggleButton active={metric === "tokens"} onClick={() => setMetric("tokens")}>
            {t("settings.usageTokens")}
          </MetricToggleButton>
        </div>
      </CardHeader>
      <CardContent className="p-4 pt-3">
        {days.length && hasUsage ? (
          <>
            <div className="flex h-36 items-end gap-[3px]" aria-hidden="true">
              {days.map((day, index) => (
                <DailyUsageBar
                  key={day.date}
                  day={day}
                  value={values[index] ?? 0}
                  maxValue={maxValue}
                  showWebSearchCosts={showWebSearchCosts}
                  tooltipAlign={tooltipAlignForIndex(index, days.length)}
                />
              ))}
            </div>
            <div className="mt-2 flex justify-between text-xs text-muted-foreground">
              <span>{days[0] ? formatUtcDay(days[0].date, locale) : ""}</span>
              <span>{t("settings.usageToday")}</span>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("settings.usageDailyEmpty", { count: dayCount })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

type TooltipAlign = "left" | "center" | "right";

function tooltipAlignForIndex(index: number, count: number): TooltipAlign {
  if (count < 2) {
    return "center";
  }
  const position = index / (count - 1);
  if (position < 0.2) {
    return "left";
  }
  if (position > 0.8) {
    return "right";
  }
  return "center";
}

function DailyUsageBar({
  day,
  value,
  maxValue,
  showWebSearchCosts,
  tooltipAlign
}: {
  day: ModelUsageDailyBucket;
  value: number;
  maxValue: number;
  showWebSearchCosts: boolean;
  tooltipAlign: TooltipAlign;
}) {
  const i18n = useTranslation();
  const { t, locale } = i18n;
  const heightPercent = value > 0 ? Math.max((value / maxValue) * 100, 3) : 0;
  return (
    <div className="group relative flex h-full flex-1 items-end">
      <div
        className={cn(
          "w-full rounded-sm transition-colors",
          value > 0
            ? "bg-primary/70 group-hover:bg-primary"
            : "h-[2px] bg-muted group-hover:bg-muted-foreground/40"
        )}
        style={value > 0 ? { height: `${heightPercent}%` } : undefined}
      />
      <div
        className={cn(
          "pointer-events-none absolute bottom-full z-10 mb-1.5 hidden group-hover:block",
          tooltipAlign === "left" && "left-0",
          tooltipAlign === "center" && "left-1/2 -translate-x-1/2",
          tooltipAlign === "right" && "right-0"
        )}
      >
        <div className="grid gap-0.5 rounded-md border bg-popover px-2.5 py-1.5 text-xs whitespace-nowrap text-popover-foreground shadow-md">
          <span className="font-medium">{formatUtcDay(day.date, locale)}</span>
          <span>
            {t("settings.usageDayBillable", { amount: formatBillableCost(day.cost, i18n) })}
          </span>
          <span className="text-muted-foreground">
            {t("settings.usageCallsAndTokens", {
              calls: day.modelCallCount.toLocaleString(locale),
              tokens: day.totalTokens.toLocaleString(locale)
            })}
          </span>
          {showWebSearchCosts && day.webSearchCallCount > 0 ? (
            <span className="text-muted-foreground">
              {t("settings.usageDaySearches", {
                count: day.webSearchCallCount.toLocaleString(locale),
                amount: formatWebSearchBillableCost(day.cost, i18n)
              })}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MetricToggleButton({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "rounded px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
        active && "bg-accent text-foreground"
      )}
      onClick={onClick}
    >
      {children}
    </button>
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
    <Card className="grid content-start gap-1.5 p-4">
      <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <span className="grid size-6 place-items-center rounded-md bg-accent text-primary">
          {icon}
        </span>
        {label}
      </span>
      <strong className="break-words text-2xl font-semibold">{value}</strong>
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
    <div className="rounded-md border bg-card p-3">
      <dt className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </dt>
      <dd className="mt-1 font-medium">
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

function formatBillableCost(
  cost:
    Pick<UsageSummary["today"]["cost"], "currency" | "billableCostMicros" | "complete"> | undefined,
  i18n: TranslationContextValue
): string {
  if (cost && !cost.complete) {
    return i18n.t("settings.usageIncomplete");
  }
  return formatMicrosCost(cost?.billableCostMicros, cost?.currency, i18n);
}

function formatWebSearchBillableCost(
  cost:
    | Pick<UsageSummary["today"]["cost"], "currency" | "webSearchBillableCostMicros" | "complete">
    | undefined,
  i18n: TranslationContextValue
): string {
  if (cost && !cost.complete) {
    return i18n.t("settings.usageIncomplete");
  }
  return formatMicrosCost(cost?.webSearchBillableCostMicros, cost?.currency, i18n);
}

function formatMicrosCost(
  micros: number | undefined,
  currency: string | undefined,
  { t, locale }: TranslationContextValue
): string {
  if (micros === undefined || currency === undefined) {
    return t("settings.usageNotPriced");
  }
  const amount = micros / 1_000_000;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: amount > 0 && amount < 1 ? 4 : 2
  }).format(amount);
}
