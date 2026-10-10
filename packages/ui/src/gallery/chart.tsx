import { Chart, type ChartProps } from "../data/chart";
import { CHART_MAX_ROWS, type ChartRow, type ChartSeries } from "../data/chart-data";
import { Samples, type GalleryEntry } from "./entry";
import type { GalleryText } from "./text";

const SAMPLE_HEIGHT = 240;
const SAMPLE_YEAR = 2026;

/** Runs per source for the first six months. One value is missing, which a line shows as a gap. */
const RUNS: readonly Omit<ChartRow, "month">[] = [
  { chat: 420, workflows: 180, apps: 60, api: 95, schedules: 40, imports: 22 },
  { chat: 465, workflows: 210, apps: 85, api: 110, schedules: 44, imports: 30 },
  { chat: 510, workflows: null, apps: 120, api: 104, schedules: 52, imports: 18 },
  { chat: 480, workflows: 260, apps: 150, api: 131, schedules: 61, imports: 35 },
  { chat: 560, workflows: 245, apps: 190, api: 142, schedules: 58, imports: 41 },
  { chat: 610, workflows: 300, apps: 240, api: 150, schedules: 70, imports: 38 }
];

function runRows(locale: string): ChartRow[] {
  const month = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" });
  return RUNS.map((row, index) => ({
    ...row,
    month: month.format(new Date(Date.UTC(SAMPLE_YEAR, index, 1)))
  }));
}

function runSeries(text: GalleryText): ChartSeries[] {
  return [
    { field: "chat", label: text.chartSeriesChat },
    { field: "workflows", label: text.chartSeriesWorkflows },
    { field: "apps", label: text.chartSeriesApps },
    { field: "api", label: text.chartSeriesApi },
    { field: "schedules", label: text.chartSeriesSchedules },
    { field: "imports", label: text.chartSeriesImports }
  ];
}

/** The last month's runs, one row per source, which is what a pie takes. */
function shareRows(text: GalleryText): ChartRow[] {
  const last = RUNS.at(-1) ?? {};
  return runSeries(text).map(({ field, label }) => ({ source: label, runs: last[field] ?? null }));
}

const FIRST_SERIES = 3;

/** More rows than a chart draws: a slow wave, numbered from one. */
const MANY_ROWS: readonly ChartRow[] = Array.from({ length: CHART_MAX_ROWS + 200 }, (_, index) => ({
  month: index + 1,
  chat: Math.round(400 + 150 * Math.sin(index / 60) + index / 10)
}));

function ChartSamples({ text }: { text: GalleryText }) {
  const rows = runRows(text.chartLocale);
  const series = runSeries(text);
  const runs = (
    label: string,
    props: Pick<ChartProps, "type"> & Partial<Pick<ChartProps, "stacked" | "series" | "rows">>
  ) => (
    <Samples label={label}>
      <Chart
        rows={rows}
        x="month"
        series={series.slice(0, FIRST_SERIES)}
        locale={text.chartLocale}
        height={SAMPLE_HEIGHT}
        ariaLabel={`${text.chartRuns}. ${label}`}
        emptyLabel={text.chartEmptyLabel}
        {...props}
      />
    </Samples>
  );
  return (
    <div className="grid min-w-0 items-start gap-6 @3xl:grid-cols-2">
      {runs(text.chartBar, { type: "bar" })}
      {runs(text.chartBarStacked, { type: "bar", stacked: true })}
      {runs(text.chartLine, { type: "line" })}
      {runs(text.chartAreaStacked, {
        type: "area",
        stacked: true,
        series: series.filter(({ field }) => field !== "workflows").slice(0, FIRST_SERIES)
      })}
      <Samples label={text.chartPie}>
        <Chart
          type="pie"
          rows={shareRows(text)}
          x="source"
          series={[{ field: "runs", label: text.chartShare }]}
          locale={text.chartLocale}
          height={SAMPLE_HEIGHT}
          ariaLabel={text.chartShare}
          emptyLabel={text.chartEmptyLabel}
        />
      </Samples>
      {runs(text.chartEmpty, { type: "bar", rows: [] })}
      {runs(text.chartSixSeriesLine, { type: "line", series })}
      {runs(text.chartSixSeriesBar, { type: "bar", series })}
      {runs(text.chartTruncated, { type: "line", rows: MANY_ROWS, series: series.slice(0, 1) })}
    </div>
  );
}

export const chartGalleryEntry: GalleryEntry = {
  name: "Chart",
  components: ["Chart"],
  render: (text) => <ChartSamples text={text} />
};
