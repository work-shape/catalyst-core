import { CalendarDays, Database, DollarSign, Search, ShieldCheck } from "lucide-react";
import { useState, type ReactNode } from "react";
import type {
  ModelUsageDailyBucket,
  ModelUsageMonthlyBucket,
  UsageSummary
} from "@vivd-catalyst/api-client";
import { ControlPlanePage } from "./control-plane/control-plane-page";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { cn } from "./ui/cn";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

export function UsageView({ usage }: { usage: UsageSummary | undefined }) {
  const recentEvents = usage?.recentEvents ?? [];
  const showWebSearchCosts = shouldShowWebSearchCosts(usage);
  return (
    <ControlPlanePage
      title="Usage"
      description={`${(usage?.currentMonth.modelCallCount ?? 0).toLocaleString()} model calls · ${(usage?.currentMonth.totalTokens ?? 0).toLocaleString()} tokens this month`}
    >
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <UsageMetric
          primary
          icon={<DollarSign size={15} />}
          label="Billed this month"
          value={formatBilledCost(usage?.currentMonth.cost)}
          detail={`${(usage?.currentMonth.modelCallCount ?? 0).toLocaleString()} calls · ${(usage?.currentMonth.totalTokens ?? 0).toLocaleString()} tokens`}
        />
        <UsageMetric
          icon={<DollarSign size={15} />}
          label="Billed today"
          value={formatBilledCost(usage?.today.cost)}
          detail={`${(usage?.today.modelCallCount ?? 0).toLocaleString()} calls · ${(usage?.today.totalTokens ?? 0).toLocaleString()} tokens`}
        />
        {showWebSearchCosts ? (
          <UsageMetric
            icon={<Search size={15} />}
            label="Web search billed"
            value={formatWebSearchBilledCost(usage?.currentMonth.cost)}
            detail={`${(usage?.currentMonth.webSearchCallCount ?? 0).toLocaleString()} searches this month`}
          />
        ) : (
          <UsageMetric
            icon={<Database size={15} />}
            label="Tokens this month"
            value={(usage?.currentMonth.totalTokens ?? 0).toLocaleString()}
          />
        )}
        <UsageMetric
          icon={<DollarSign size={15} />}
          label="Billed all time"
          value={formatBilledCost(usage?.allTime.cost)}
          detail={`${(usage?.allTime.modelCallCount ?? 0).toLocaleString()} calls · ${(usage?.allTime.totalTokens ?? 0).toLocaleString()} tokens`}
        />
      </div>

      <DailyUsageCard
        days={usage?.dailyUsage ?? []}
        defaultMetric={usage?.allTime.cost.pricingConfigured ? "cost" : "tokens"}
        showWebSearchCosts={showWebSearchCosts}
      />

      <MonthlyHistoryCard months={usage?.monthlyUsage ?? []} showWebSearchCosts={showWebSearchCosts} />

      {showWebSearchCosts ? (
        <Card data-testid="web-search-usage">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-base">Web search usage</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-2">
            <dl className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <UsageStat
                icon={<Search size={15} />}
                label="Searches today"
                value={usage?.today.webSearchCallCount ?? 0}
              />
              <UsageStat
                icon={<Search size={15} />}
                label="Searches this month"
                value={usage?.currentMonth.webSearchCallCount ?? 0}
              />
              <UsageStat
                icon={<DollarSign size={15} />}
                label="Search cost today"
                value={formatWebSearchBilledCost(usage?.today.cost)}
              />
              <UsageStat
                icon={<DollarSign size={15} />}
                label="Search cost this month"
                value={formatWebSearchBilledCost(usage?.currentMonth.cost)}
              />
            </dl>
          </CardContent>
        </Card>
      ) : null}

      <Card data-testid="configured-safeguards">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-base">Configured safeguards</CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-2">
          <dl className="grid gap-3 md:grid-cols-3">
            <UsageStat
              icon={<ShieldCheck size={15} />}
              label="Model calls per day"
              value={usage?.safeguards.modelCallsPerDay}
            />
            <UsageStat
              icon={<ShieldCheck size={15} />}
              label="Tokens per day"
              value={usage?.safeguards.tokensPerDay}
            />
            <UsageStat
              icon={<ShieldCheck size={15} />}
              label="Tokens per month"
              value={usage?.safeguards.tokensPerMonth}
            />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-base">Recent model usage</CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-1">
          {recentEvents.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>Billed</TableHead>
                  {showWebSearchCosts ? <TableHead>Web search</TableHead> : null}
                  {showWebSearchCosts ? <TableHead>Search billed</TableHead> : null}
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentEvents.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(event.createdAt)}
                    </TableCell>
                    <TableCell className="font-medium break-words">{event.model}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {event.totalTokens.toLocaleString()}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatBilledCost(event.cost)}
                    </TableCell>
                    {showWebSearchCosts ? (
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {event.webSearchCallCount.toLocaleString()}
                      </TableCell>
                    ) : null}
                    {showWebSearchCosts ? (
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatWebSearchBilledCost(event.cost)}
                      </TableCell>
                    ) : null}
                    <TableCell className="text-muted-foreground">{event.source}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="pt-1 text-sm text-muted-foreground">No model usage recorded yet.</p>
          )}
        </CardContent>
      </Card>
    </ControlPlanePage>
  );
}

type DailyUsageMetric = "cost" | "tokens";

function DailyUsageCard({
  days,
  defaultMetric,
  showWebSearchCosts
}: {
  days: ModelUsageDailyBucket[];
  defaultMetric: DailyUsageMetric;
  showWebSearchCosts: boolean;
}) {
  const [metric, setMetric] = useState<DailyUsageMetric>(defaultMetric);
  const values = days.map((day) =>
    metric === "cost" ? day.cost.billedCostMicros : day.totalTokens
  );
  const maxValue = Math.max(...values, 1);
  const hasUsage = values.some((value) => value > 0);

  return (
    <Card data-testid="daily-usage">
      <CardHeader className="flex flex-row items-center justify-between p-4 pb-2">
        <CardTitle className="inline-flex items-center gap-2 text-base">
          <CalendarDays size={15} aria-hidden="true" className="text-muted-foreground" />
          Last {days.length || 30} days
        </CardTitle>
        <div className="flex items-center gap-0.5 rounded-md border p-0.5" role="group" aria-label="Chart metric">
          <MetricToggleButton active={metric === "cost"} onClick={() => setMetric("cost")}>
            Billed
          </MetricToggleButton>
          <MetricToggleButton active={metric === "tokens"} onClick={() => setMetric("tokens")}>
            Tokens
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
              <span>{days[0] ? formatUtcDay(days[0].date) : ""}</span>
              <span>Today</span>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No usage in the last {days.length || 30} days.</p>
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
  const heightPercent = value > 0 ? Math.max((value / maxValue) * 100, 3) : 0;
  return (
    <div className="group relative flex h-full flex-1 items-end">
      <div
        className={cn(
          "w-full rounded-sm transition-colors",
          value > 0 ? "bg-primary/70 group-hover:bg-primary" : "h-[2px] bg-muted group-hover:bg-muted-foreground/40"
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
          <span className="font-medium">{formatUtcDay(day.date)}</span>
          <span>{formatBilledCost(day.cost)} billed</span>
          <span className="text-muted-foreground">
            {day.modelCallCount.toLocaleString()} calls · {day.totalTokens.toLocaleString()} tokens
          </span>
          {showWebSearchCosts && day.webSearchCallCount > 0 ? (
            <span className="text-muted-foreground">
              {day.webSearchCallCount.toLocaleString()} searches · {formatWebSearchBilledCost(day.cost)}
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
  const rows = [...months].reverse();
  return (
    <Card data-testid="monthly-usage">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base">Monthly history</CardTitle>
        <p className="text-xs text-muted-foreground">
          Billed usage per calendar month, most recent first.
        </p>
      </CardHeader>
      <CardContent className="p-4 pt-1">
        {rows.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead>Calls</TableHead>
                <TableHead>Tokens</TableHead>
                {showWebSearchCosts ? <TableHead>Searches</TableHead> : null}
                {showWebSearchCosts ? <TableHead>Search billed</TableHead> : null}
                <TableHead className="text-right">Billed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((month, index) => (
                <TableRow key={month.month}>
                  <TableCell className="font-medium whitespace-nowrap">
                    {formatUtcMonth(month.month)}
                    {index === 0 ? (
                      <Badge variant="secondary" className="ml-2">
                        Current
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {month.modelCallCount.toLocaleString()}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {month.totalTokens.toLocaleString()}
                  </TableCell>
                  {showWebSearchCosts ? (
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {month.webSearchCallCount.toLocaleString()}
                    </TableCell>
                  ) : null}
                  {showWebSearchCosts ? (
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatWebSearchBilledCost(month.cost)}
                    </TableCell>
                  ) : null}
                  <TableCell className="text-right font-medium whitespace-nowrap">
                    {formatBilledCost(month.cost)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="pt-1 text-sm text-muted-foreground">No usage recorded yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

function UsageMetric({
  icon,
  label,
  value,
  detail,
  primary = false
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  detail?: string;
  primary?: boolean;
}) {
  return (
    <Card className={cn("grid content-start gap-1.5 p-4", primary && "bg-accent/40 lg:col-span-2")}>
      <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <span className="grid size-6 place-items-center rounded-md bg-accent text-primary">{icon}</span>
        {label}
      </span>
      <strong className={cn("break-words text-2xl font-semibold", primary && "text-3xl")}>{value}</strong>
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
  return (
    <div className="rounded-md border bg-card p-3">
      <dt className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </dt>
      <dd className="mt-1 font-medium">
        {value === undefined ? "Not configured" : typeof value === "number" ? value.toLocaleString() : value}
      </dd>
    </div>
  );
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

function formatUtcDay(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC"
  }).format(new Date(date));
}

function formatUtcMonth(month: string): string {
  return new Intl.DateTimeFormat(undefined, {
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

function formatBilledCost(
  cost: Pick<UsageSummary["today"]["cost"], "currency" | "billedCostMicros"> | undefined
): string {
  return formatMicrosCost(cost?.billedCostMicros, cost?.currency);
}

function formatWebSearchBilledCost(
  cost:
    | Pick<UsageSummary["today"]["cost"], "currency" | "webSearchBilledCostMicros">
    | undefined
): string {
  return formatMicrosCost(cost?.webSearchBilledCostMicros, cost?.currency);
}

function formatMicrosCost(micros: number | undefined, currency: string | undefined): string {
  const amount = (micros ?? 0) / 1_000_000;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency ?? "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: amount > 0 && amount < 1 ? 4 : 2
  }).format(amount);
}
