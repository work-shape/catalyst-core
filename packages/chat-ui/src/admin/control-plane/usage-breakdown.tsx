import type {
  UsageBreakdown,
  UsageBreakdownDimension,
  UsageBreakdownRow
} from "@work-shape/catalyst-api-client";
import {
  Banner,
  Breadcrumb,
  Button,
  EmptyState,
  FilterBar,
  Field,
  Select,
  SkeletonList,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@work-shape/catalyst-ui";
import { USAGE_BREAKDOWN_DIMENSIONS } from "@work-shape/catalyst-core";
import { Download } from "lucide-react";
import {
  useTranslation,
  type TranslationContextValue,
  type TranslationKey
} from "../../shared/i18n";
import { workspaceRoutePath } from "../../shared/routes";
import { usageAgentLabel } from "./usage-attribution-labels";
import { formatBillableCost } from "./usage-cost-format";

// The Breakdown of the Usage page (LU-3, limits spec 3.3, view 2): a period, one dimension to
// group by, and a path of rows opened, each narrowing the next table.

/** The dimensions in the order a row opens into the next. */
const DIMENSION_ORDER: readonly UsageBreakdownDimension[] = USAGE_BREAKDOWN_DIMENSIONS;

const DIMENSION_LABELS: Record<UsageBreakdownDimension, TranslationKey> = {
  workspace: "usageReports.dimensionWorkspace",
  agent: "usageReports.dimensionAgent",
  app: "usageReports.dimensionApp",
  workflow: "usageReports.dimensionWorkflow",
  model: "usageReports.dimensionModel",
  origin: "usageReports.dimensionOrigin"
};

const ORIGIN_LABELS: Record<string, TranslationKey> = {
  conversation: "usageReports.originConversation",
  app: "usageReports.originApp",
  workflow: "usageReports.originWorkflow",
  knowledge_base: "usageReports.originKnowledgeBase",
  system: "usageReports.originSystem"
};

const USAGE_PERIODS = [
  "this_month",
  "last_month",
  "last_7",
  "last_30",
  "last_90",
  "this_year"
] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];

const PERIOD_LABELS: Record<UsagePeriod, TranslationKey> = {
  this_month: "usageReports.periodThisMonth",
  last_month: "usageReports.periodLastMonth",
  last_7: "usageReports.periodLast7",
  last_30: "usageReports.periodLast30",
  last_90: "usageReports.periodLast90",
  this_year: "usageReports.periodThisYear"
};

const day = (date: Date) => date.toISOString().slice(0, 10);

/** The UTC days of a period: from its first day up to the day after its last. */
export function usagePeriodDays(
  period: UsagePeriod,
  now = new Date()
): { from: string; to: string } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const tomorrow = day(new Date(Date.UTC(year, month, now.getUTCDate() + 1)));
  const daysBack = (count: number) =>
    day(new Date(Date.UTC(year, month, now.getUTCDate() + 1 - count)));
  switch (period) {
    case "this_month":
      return { from: day(new Date(Date.UTC(year, month, 1))), to: tomorrow };
    case "last_month":
      return {
        from: day(new Date(Date.UTC(year, month - 1, 1))),
        to: day(new Date(Date.UTC(year, month, 1)))
      };
    case "last_7":
      return { from: daysBack(7), to: tomorrow };
    case "last_30":
      return { from: daysBack(30), to: tomorrow };
    case "last_90":
      return { from: daysBack(90), to: tomorrow };
    case "this_year":
      return { from: day(new Date(Date.UTC(year, 0, 1))), to: tomorrow };
  }
}

/** One row opened: the dimension, its value and how it was shown. */
export interface UsageBreakdownStep {
  dimension: UsageBreakdownDimension;
  key: string;
  label: string;
}

export interface UsageBreakdownState {
  period: UsagePeriod;
  groupBy: UsageBreakdownDimension;
  path: readonly UsageBreakdownStep[];
}

/** The filter a path of opened rows narrows the Breakdown to. */
export function usageBreakdownFilter(
  path: readonly UsageBreakdownStep[]
): Partial<Record<UsageBreakdownDimension, string>> {
  return Object.fromEntries(path.map((step) => [step.dimension, step.key]));
}

/** The dimension a row of `groupBy` opens into: the next one not yet narrowed. */
function nextDimension(
  dimensions: readonly UsageBreakdownDimension[],
  state: UsageBreakdownState
): UsageBreakdownDimension | undefined {
  const narrowed = new Set([state.groupBy, ...state.path.map((step) => step.dimension)]);
  const from = DIMENSION_ORDER.indexOf(state.groupBy);
  const rest = [...DIMENSION_ORDER.slice(from + 1), ...DIMENSION_ORDER.slice(0, from)];
  return rest.find((dimension) => dimensions.includes(dimension) && !narrowed.has(dimension));
}

/** A row's value as people know it: a workspace by name, an agent by its display name. */
function usageBreakdownLabel(
  dimension: UsageBreakdownDimension,
  row: Pick<UsageBreakdownRow, "key" | "name">,
  breakdown: Pick<UsageBreakdown, "personalWorkspacesKey">,
  t: TranslationContextValue["t"],
  agentLabel: (agentName: string) => string | undefined
): string {
  if (row.key === "") return t("usageReports.notAttributed");
  switch (dimension) {
    case "workspace":
      if (row.key === breakdown.personalWorkspacesKey) return t("usageReports.personalWorkspaces");
      return row.name ?? t("usageReports.deletedWorkspace");
    case "agent":
      return usageAgentLabel(row.key, t, agentLabel);
    case "origin": {
      const label = ORIGIN_LABELS[row.key];
      return label ? t(label) : row.key;
    }
    default:
      return row.key;
  }
}

/** The comments counted on all rows. */
function feedbackTotal(rows: readonly UsageBreakdownRow[]): number {
  return rows.reduce((sum, row) => sum + (row.feedbackCount ?? 0), 0);
}

/** A row's part of the total cost, where both are priced in full. */
function shareRatio(
  row: Pick<UsageBreakdownRow, "cost">,
  total: Pick<UsageBreakdownRow, "cost">
): number | undefined {
  const part = row.cost.billableCostMicros;
  const whole = total.cost.billableCostMicros;
  if (!row.cost.complete || !total.cost.complete || part === undefined || !whole) return undefined;
  return part / whole;
}

function shareOf(
  row: Pick<UsageBreakdownRow, "cost">,
  total: Pick<UsageBreakdownRow, "cost">,
  locale: string
): string | undefined {
  const ratio = shareRatio(row, total);
  return ratio === undefined
    ? undefined
    : new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(ratio);
}

/** One cell of a CSV line: quoted, and never read as a formula by a spreadsheet. */
function csvCell(value: string | number | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "number") return String(value);
  const text = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return /[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * The Breakdown table as one CSV file (limits spec 4: one CSV download, no report builder):
 * the rows as shown, then the total. Amounts are plain numbers in the currency's unit, so a
 * spreadsheet sums them; an amount not yet priced in full is left empty.
 */
export function usageBreakdownCsv(
  breakdown: UsageBreakdown,
  label: (row: UsageBreakdownRow) => string,
  t: TranslationContextValue["t"]
): string {
  const counts = breakdown.feedback !== undefined;
  const amount = (cost: UsageBreakdownRow["cost"]) =>
    cost.complete && cost.billableCostMicros !== undefined
      ? cost.billableCostMicros / 1_000_000
      : undefined;
  const line = (cells: (string | number | undefined)[]) => cells.map(csvCell).join(",");
  const currency = breakdown.total.cost.currency;
  return [
    line([
      t(DIMENSION_LABELS[breakdown.groupBy]),
      currency === undefined ? t("usageReports.cost") : `${t("usageReports.cost")} (${currency})`,
      t("usageReports.share"),
      t("usageReports.calls"),
      t("usageReports.tokens"),
      ...(counts ? [t("usageReports.feedback")] : [])
    ]),
    ...breakdown.rows.map((row) => {
      const ratio = shareRatio(row, breakdown.total);
      return line([
        label(row),
        amount(row.cost),
        ratio === undefined ? undefined : Math.round(ratio * 10_000) / 10_000,
        row.modelCallCount,
        row.totalTokens,
        ...(counts ? [row.feedbackCount] : [])
      ]);
    }),
    line([
      t("usageReports.total"),
      amount(breakdown.total.cost),
      undefined,
      breakdown.total.modelCallCount,
      breakdown.total.totalTokens,
      ...(counts ? [feedbackTotal(breakdown.rows)] : [])
    ])
  ].join("\r\n");
}

function downloadCsv(name: string, csv: string): void {
  // A byte order mark, so a spreadsheet reads the names' umlauts as UTF-8.
  const href = URL.createObjectURL(new Blob([`﻿${csv}\r\n`], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  link.click();
  URL.revokeObjectURL(href);
}

export function UsageBreakdownPanel({
  state,
  onStateChange,
  breakdown,
  loading,
  error,
  dimensions = DIMENSION_ORDER,
  agentLabel = () => undefined
}: {
  state: UsageBreakdownState;
  onStateChange(state: UsageBreakdownState): void;
  /** Absent while the first answer loads. */
  breakdown: UsageBreakdown | undefined;
  /** A newer answer is on its way; the rows shown are the previous one's. */
  loading?: boolean;
  error?: string;
  /** The dimensions offered: a workspace's own Breakdown has no workspace to group by. */
  dimensions?: readonly UsageBreakdownDimension[];
  agentLabel?: (agentName: string) => string | undefined;
}) {
  const i18n = useTranslation();
  const { t, locale } = i18n;
  const next = nextDimension(dimensions, state);
  const groupable = dimensions.filter(
    (dimension) => !state.path.some((step) => step.dimension === dimension)
  );
  // The rows of another grouping, kept while the new one loads, would be named by the wrong
  // dimension: only the rows of this grouping are shown.
  const shown = breakdown?.groupBy === state.groupBy ? breakdown : undefined;
  const rows = shown?.rows ?? [];
  const label = (row: UsageBreakdownRow) =>
    shown ? usageBreakdownLabel(state.groupBy, row, shown, t, agentLabel) : row.key;
  const incomplete = shown !== undefined && !shown.total.cost.complete && rows.length > 0;
  const feedback = shown?.feedback;
  const unusedAgents = shown?.unusedAgents ?? [];

  return (
    <div className="grid min-w-0 gap-4" data-testid="usage-breakdown">
      <FilterBar
        {...(shown && rows.length > 0
          ? {
              actions: (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    downloadCsv(
                      `usage-${shown.groupBy}-${shown.from}-${shown.to}.csv`,
                      usageBreakdownCsv(shown, label, t)
                    )
                  }
                >
                  <Download size={14} aria-hidden="true" />
                  {t("usageReports.downloadCsv")}
                </Button>
              )
            }
          : {})}
        filters={
          <>
            <Field label={t("usageReports.period")} className="w-44">
              <Select
                value={state.period}
                onChange={(event) => {
                  const period = USAGE_PERIODS.find((value) => value === event.target.value);
                  if (period) onStateChange({ ...state, period });
                }}
              >
                {USAGE_PERIODS.map((period) => (
                  <option key={period} value={period}>
                    {t(PERIOD_LABELS[period])}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("usageReports.groupBy")} className="w-44">
              <Select
                value={state.groupBy}
                onChange={(event) => {
                  const groupBy = groupable.find((value) => value === event.target.value);
                  if (groupBy) onStateChange({ ...state, groupBy });
                }}
              >
                {groupable.map((dimension) => (
                  <option key={dimension} value={dimension}>
                    {t(DIMENSION_LABELS[dimension])}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        }
      />
      {state.path.length > 0 ? (
        <Breadcrumb
          label={t("usageReports.path")}
          items={[
            {
              id: "all",
              label: t("usageReports.all"),
              onSelect: () => onStateChange({ ...state, path: [] })
            },
            ...state.path.map((step, index) => ({
              id: `${step.dimension}:${step.key}`,
              label: `${t(DIMENSION_LABELS[step.dimension])}: ${step.label}`,
              onSelect: () =>
                onStateChange({
                  ...state,
                  groupBy: state.path[index + 1]?.dimension ?? state.groupBy,
                  path: state.path.slice(0, index + 1)
                })
            }))
          ]}
        />
      ) : null}
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {incomplete ? <Banner tone="info">{t("usageReports.breakdownIncomplete")}</Banner> : null}
      {!shown ? (
        error ? null : (
          <SkeletonList />
        )
      ) : rows.length === 0 ? (
        <EmptyState>{t("usageReports.breakdownEmpty")}</EmptyState>
      ) : (
        <Table aria-busy={loading ? true : undefined}>
          <TableHeader>
            <TableRow>
              <TableHead>{t(DIMENSION_LABELS[state.groupBy])}</TableHead>
              <TableHead align="end">{t("usageReports.cost")}</TableHead>
              <TableHead align="end" priority={1}>
                {t("usageReports.share")}
              </TableHead>
              {feedback ? (
                <TableHead align="end" priority={2}>
                  {t("usageReports.feedback")}
                </TableHead>
              ) : null}
              <TableHead align="end" priority={3}>
                {t("usageReports.calls")}
              </TableHead>
              <TableHead align="end" priority={4}>
                {t("usageReports.tokens")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const name = label(row);
              return (
                <TableRow key={row.key} data-usage-row={row.key}>
                  <TableCell className="break-words" rowDetail>
                    {next === undefined ? (
                      name
                    ) : (
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto px-0 text-start whitespace-normal"
                        aria-label={t("usageReports.openRow", {
                          name,
                          dimension: t(DIMENSION_LABELS[next])
                        })}
                        onClick={() =>
                          onStateChange({
                            ...state,
                            groupBy: next,
                            path: [
                              ...state.path,
                              { dimension: state.groupBy, key: row.key, label: name }
                            ]
                          })
                        }
                      >
                        {name}
                      </Button>
                    )}
                  </TableCell>
                  <TableCell align="end" className="whitespace-nowrap">
                    {formatBillableCost(row.cost, i18n)}
                  </TableCell>
                  <TableCell align="end" className="whitespace-nowrap text-muted-foreground">
                    {shareOf(row, shown.total, locale) ?? "–"}
                  </TableCell>
                  {feedback ? (
                    <TableCell
                      align="end"
                      className="whitespace-nowrap text-muted-foreground"
                      data-usage-feedback=""
                    >
                      {row.feedbackCount === undefined ? (
                        "–"
                      ) : feedback.reviewable && row.feedbackCount > 0 ? (
                        <Button asChild variant="link" size="sm" className="h-auto px-0">
                          <a
                            href={workspaceRoutePath({ kind: "inbox-agent", agentName: row.key })}
                            aria-label={t("usageReports.feedbackOpen", {
                              count: row.feedbackCount.toLocaleString(locale),
                              name
                            })}
                          >
                            {row.feedbackCount.toLocaleString(locale)}
                          </a>
                        </Button>
                      ) : (
                        row.feedbackCount.toLocaleString(locale)
                      )}
                    </TableCell>
                  ) : null}
                  <TableCell align="end" className="whitespace-nowrap text-muted-foreground">
                    {row.modelCallCount.toLocaleString(locale)}
                  </TableCell>
                  <TableCell align="end" className="whitespace-nowrap text-muted-foreground">
                    {row.totalTokens.toLocaleString(locale)}
                  </TableCell>
                </TableRow>
              );
            })}
            <TableRow data-usage-row="total" className="font-medium">
              <TableCell rowDetail>{t("usageReports.total")}</TableCell>
              <TableCell align="end" className="whitespace-nowrap">
                {formatBillableCost(shown.total.cost, i18n)}
              </TableCell>
              <TableCell align="end" />
              {feedback ? (
                <TableCell align="end" className="whitespace-nowrap">
                  {feedbackTotal(rows).toLocaleString(locale)}
                </TableCell>
              ) : null}
              <TableCell align="end" className="whitespace-nowrap">
                {shown.total.modelCallCount.toLocaleString(locale)}
              </TableCell>
              <TableCell align="end" className="whitespace-nowrap">
                {shown.total.totalTokens.toLocaleString(locale)}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      )}
      {unusedAgents.length > 0 ? (
        <p className="text-caption text-muted-foreground" data-testid="usage-unused-agents">
          {t("usageReports.unusedAgents", {
            names: new Intl.ListFormat(locale, { type: "conjunction" }).format(
              unusedAgents.map((agentName) => usageAgentLabel(agentName, t, agentLabel))
            )
          })}
        </p>
      ) : null}
    </div>
  );
}
