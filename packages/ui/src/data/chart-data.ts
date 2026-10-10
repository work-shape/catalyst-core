import type { ChartSpec, ChartType } from "./chart-engine";

/** One row of data. A value that is no number, such as a numeric text, is read as one where it can be. */
export type ChartRow = Record<string, string | number | null>;

export interface ChartSeries {
  /** The field of a row that holds this series' value. */
  field: string;
  /** The name the legend, the tooltip and the data table show. */
  label: string;
}

export interface ChartFormat {
  style: "number" | "percent" | "currency";
  /** The ISO 4217 code. Needed for `currency`. */
  currency?: string;
  maximumFractionDigits?: number;
}

/** The data a chart draws: the part of its props the engine's drawing depends on. */
export interface ChartData {
  type: ChartType;
  rows: readonly ChartRow[];
  /** The field of a row that names its category. */
  x: string;
  /** A pie draws the first series only. */
  series: readonly ChartSeries[];
  /** Stacks the series of a bar or area chart. */
  stacked?: boolean;
  format?: ChartFormat;
  locale: string;
}

/** A chart draws the first rows and series up to these caps and marks itself `data-truncated`. */
export const CHART_MAX_ROWS = 5000;
export const CHART_MAX_SERIES = 24;

/** A series names a field that holds a number in no row, which is a mistake in the caller. */
export class ChartFieldError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`Chart: the series field "${field}" holds a number in no row.`);
    this.name = "ChartFieldError";
    this.field = field;
  }
}

/** What was cut to stay inside the caps. */
type ChartTruncation = "rows" | "series" | "rows series";

interface ChartReading {
  spec: ChartSpec;
  truncated: ChartTruncation | undefined;
  /** False when there is nothing to draw, so the box shows the empty label. */
  drawable: boolean;
}

/**
 * Reads the caller's rows into what the engine draws. A missing, empty or non-numeric value is
 * a gap. A series whose field holds a number in no row, although rows carry something else
 * there or do not carry the field at all, throws in development and is left out in production.
 */
export function readChart({
  type,
  rows,
  x,
  series,
  stacked = false,
  format,
  locale
}: ChartData): ChartReading {
  const keptRows = rows.slice(0, CHART_MAX_ROWS);
  const keptSeries = series.slice(0, type === "pie" ? 1 : CHART_MAX_SERIES);
  const truncatedRows = rows.length > CHART_MAX_ROWS;
  const truncatedSeries = type !== "pie" && series.length > CHART_MAX_SERIES;

  const drawn = keptSeries.flatMap(({ field, label }) => {
    const values = keptRows.map((row) => numberOf(row[field]));
    if (keptRows.length > 0 && isWrongField(keptRows, field, values)) {
      if (isDevelopment()) {
        throw new ChartFieldError(field);
      }
      return [];
    }
    return [{ label, values }];
  });
  const spec: ChartSpec = {
    type,
    categories: keptRows.map((row) => categoryOf(row[x])),
    series: drawn,
    stacked: stacked && (type === "bar" || type === "area"),
    formatValue: numberFormatter(locale, format)
  };
  return {
    spec,
    truncated: truncation(truncatedRows, truncatedSeries),
    drawable: keptRows.length > 0 && drawn.length > 0 && (type !== "pie" || hasSlice(drawn[0]))
  };
}

function truncation(rows: boolean, series: boolean): ChartTruncation | undefined {
  if (rows && series) {
    return "rows series";
  }
  if (rows) {
    return "rows";
  }
  return series ? "series" : undefined;
}

/** Rows arrive from queries and pasted data, so a value may be anything at run time. */
function numberOf(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function categoryOf(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/** A field that is empty in every row is a series without data yet, not a wrong field. */
function isWrongField(
  rows: readonly ChartRow[],
  field: string,
  values: readonly (number | null)[]
): boolean {
  if (values.some((value) => value !== null)) {
    return false;
  }
  return rows.every((row) => !(field in row)) || rows.some((row) => (row[field] ?? null) !== null);
}

/** A pie has a slice only for a value above zero. */
function hasSlice(series: ChartSpec["series"][number] | undefined): boolean {
  return series !== undefined && series.values.some((value) => value !== null && value > 0);
}

/** A locale or currency the runtime does not know falls back to plain numbers and never throws. */
function numberFormatter(
  locale: string,
  format: ChartFormat | undefined
): (value: number) => string {
  const attempts = [
    () =>
      new Intl.NumberFormat(locale, {
        style: format === undefined || format.style === "number" ? "decimal" : format.style,
        currency: format?.currency,
        maximumFractionDigits: format?.maximumFractionDigits
      }),
    () => new Intl.NumberFormat(locale),
    () => new Intl.NumberFormat()
  ];
  for (const attempt of attempts) {
    try {
      const formatter = attempt();
      return (value) => formatter.format(value);
    } catch {
      // The next attempt asks for less.
    }
  }
  return String;
}

// The library has no Node types. A bundler replaces the expression; without one there is no
// `process`, and the chart behaves as in production.
declare const process: { env: { NODE_ENV?: string } };

function isDevelopment(): boolean {
  try {
    return process.env.NODE_ENV !== "production";
  } catch {
    return false;
  }
}
