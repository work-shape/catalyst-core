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
import {
  useTranslation,
  type TranslationContextValue,
  type TranslationKey
} from "../../shared/i18n";
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

function shareOf(
  row: Pick<UsageBreakdownRow, "cost">,
  total: Pick<UsageBreakdownRow, "cost">,
  locale: string
): string | undefined {
  const part = row.cost.billableCostMicros;
  const whole = total.cost.billableCostMicros;
  if (!row.cost.complete || !total.cost.complete || part === undefined || !whole) return undefined;
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(
    part / whole
  );
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

  return (
    <div className="grid min-w-0 gap-4" data-testid="usage-breakdown">
      <FilterBar
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
              <TableHead align="end" priority={2}>
                {t("usageReports.calls")}
              </TableHead>
              <TableHead align="end" priority={3}>
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
    </div>
  );
}
