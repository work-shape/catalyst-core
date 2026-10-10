import {
  BarChart,
  LineChart,
  PieChart,
  type BarSeriesOption,
  type LineSeriesOption,
  type PieSeriesOption
} from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
  type GridComponentOption,
  type LegendComponentOption,
  type TooltipComponentOption
} from "echarts/components";
import { init, use, type ComposeOption } from "echarts/core";
import { SVGRenderer } from "echarts/renderers";

/**
 * The chart engine: the one file of the library that imports ECharts. `Chart` loads it with a
 * dynamic `import()`, so it stays out of the entry chunk, and the package does not export it.
 * The chart types and how a series looks are decided here and nowhere else. No ECharts type
 * leaves this file.
 *
 * It imports the modular ESM build (`echarts/core` with the bar, line and pie charts) and the
 * SVG renderer. That build has no `eval` and no `new Function`, and the tooltip is drawn inside
 * the SVG, so a chart injects no markup and no inline style.
 */
use([BarChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, SVGRenderer]);

export type ChartType = "bar" | "line" | "area" | "pie";

/** One drawn series: a value per category, where `null` leaves a gap. */
export interface ChartSeriesData {
  label: string;
  values: readonly (number | null)[];
}

/** What a chart draws, already read from the caller's rows. */
export interface ChartSpec {
  type: ChartType;
  categories: readonly string[];
  /** A pie draws the first series only. */
  series: readonly ChartSeriesData[];
  stacked: boolean;
  formatValue(value: number): string;
}

/** The resolved theme values a chart is drawn with. The component reads them from the tokens. */
export interface ChartPalette {
  /** The series colours in token order. A series past the last one starts over. */
  series: readonly string[];
  /** Axis labels, legend and slice labels. */
  text: string;
  /** Axis and grid lines and the tooltip border. */
  line: string;
  /** The surface the chart sits on. */
  surface: string;
  tooltipSurface: string;
  tooltipText: string;
  fontFamily: string;
  fontSize: number;
}

export interface ChartSize {
  width: number;
  height: number;
}

export interface ChartHandle {
  update(spec: ChartSpec, palette: ChartPalette): void;
  resize(): void;
  dispose(): void;
}

type ChartOption = ComposeOption<
  | BarSeriesOption
  | LineSeriesOption
  | PieSeriesOption
  | GridComponentOption
  | LegendComponentOption
  | TooltipComponentOption
>;
type FillPattern = NonNullable<BarSeriesOption["itemStyle"]>["decal"];

/** How a series is told apart without its colour: a marker on a line, a pattern on a bar. */
interface SeriesMark {
  /** An ECharts symbol name, or a path the engine centres on the data point. */
  symbol: string;
  pattern(color: string): FillPattern;
}

const STRIPE_WIDTH = 1;
const STRIPE_GAP = 5;
const stripes =
  (rotation: number) =>
  (color: string): FillPattern => ({
    color,
    symbol: "rect",
    dashArrayX: [1, 0],
    dashArrayY: [STRIPE_WIDTH, STRIPE_GAP],
    rotation
  });

/** A triangle that points down. A turned symbol would sit beside its data point. */
const TRIANGLE_DOWN = "path://M0 0L2 0L1 2Z";

const SERIES_MARKS: readonly SeriesMark[] = [
  { symbol: "circle", pattern: () => undefined },
  { symbol: "rect", pattern: stripes(Math.PI / 4) },
  { symbol: "triangle", pattern: stripes(-Math.PI / 4) },
  { symbol: "diamond", pattern: stripes(Math.PI / 2) },
  // Level stripes come last: on a stacked bar they are the closest to a segment's edge.
  { symbol: TRIANGLE_DOWN, pattern: stripes(0) }
];

const LINE_WIDTH = 2;
const MARKER_SIZE = 7;
const AREA_FILL_OPACITY = 0.2;
/** The fill of a bar or slice whose colour is used a second time. */
const REPEATED_FILL_OPACITY = 0.55;
const BAR_MAX_WIDTH = 40;
const PIE_RADIUS = "62%";
const AXIS_LABEL_MAX_WIDTH = 96;
const AXIS_LABELS_LAID_OUT = 60;
const SLICE_LABEL_MAX_WIDTH = 140;
const LEGEND_LABEL_MAX_WIDTH = 160;
const LEGEND_HEIGHT = 32;
const CHART_PADDING = 8;
const STACK_NAME = "stack";

interface SeriesLook {
  color: string;
  /** True when the colour is already used by an earlier series. */
  repeated: boolean;
  mark: SeriesMark;
}

function seriesLook(index: number, palette: ChartPalette): SeriesLook {
  const colors = palette.series;
  return {
    color: colors[index % colors.length] ?? palette.text,
    repeated: index >= colors.length,
    mark: SERIES_MARKS[index % SERIES_MARKS.length] ?? {
      symbol: "circle",
      pattern: () => undefined
    }
  };
}

function barSeries(
  series: ChartSeriesData,
  index: number,
  spec: ChartSpec,
  palette: ChartPalette
): BarSeriesOption {
  const look = seriesLook(index, palette);
  return {
    type: "bar",
    name: series.label,
    data: [...series.values],
    stack: spec.stacked ? STACK_NAME : undefined,
    barMaxWidth: BAR_MAX_WIDTH,
    itemStyle: {
      color: look.color,
      opacity: look.repeated ? REPEATED_FILL_OPACITY : 1,
      // One series needs no pattern: there is nothing to tell it apart from.
      decal: spec.series.length > 1 ? look.mark.pattern(palette.surface) : undefined
    }
  };
}

function lineSeries(
  series: ChartSeriesData,
  index: number,
  spec: ChartSpec,
  palette: ChartPalette
): LineSeriesOption {
  const look = seriesLook(index, palette);
  const filled = spec.type === "area";
  return {
    type: "line",
    name: series.label,
    data: [...series.values],
    stack: filled && spec.stacked ? STACK_NAME : undefined,
    connectNulls: false,
    symbol: look.mark.symbol,
    symbolSize: MARKER_SIZE,
    // A single point has no line to show it, so its marker always shows.
    showSymbol: true,
    showAllSymbol: spec.categories.length === 1 ? true : "auto",
    itemStyle: { color: look.color },
    lineStyle: { color: look.color, width: LINE_WIDTH, type: look.repeated ? "dashed" : "solid" },
    areaStyle: filled ? { color: look.color, opacity: AREA_FILL_OPACITY } : undefined
  };
}

function cartesianOption(spec: ChartSpec, palette: ChartPalette): ChartOption {
  const isBar = spec.type === "bar";
  const withLegend = spec.series.length > 1;
  const label = { color: palette.text, fontSize: palette.fontSize };
  return {
    grid: {
      left: CHART_PADDING,
      right: CHART_PADDING,
      top: withLegend ? LEGEND_HEIGHT + CHART_PADDING : CHART_PADDING,
      bottom: CHART_PADDING,
      outerBoundsMode: "same",
      outerBoundsContain: "axisLabel"
    },
    legend: {
      show: withLegend,
      type: "scroll",
      top: 0,
      left: CHART_PADDING,
      right: CHART_PADDING,
      height: LEGEND_HEIGHT,
      textStyle: { ...label, width: LEGEND_LABEL_MAX_WIDTH, overflow: "truncate" },
      pageTextStyle: label,
      pageIconColor: palette.text,
      pageIconInactiveColor: palette.line
    },
    xAxis: {
      type: "category",
      data: [...spec.categories],
      // A line starts at the axis; one point alone sits in the middle like a bar does.
      boundaryGap: isBar || spec.categories.length === 1,
      axisLine: { lineStyle: { color: palette.line } },
      axisTick: { show: false },
      axisLabel: {
        ...label,
        // Every label is laid out at its cut width and hidden where it would overlap. Past
        // the limit the engine picks every n-th label itself, which costs less.
        interval: spec.categories.length <= AXIS_LABELS_LAID_OUT ? 0 : "auto",
        hideOverlap: true,
        width: AXIS_LABEL_MAX_WIDTH,
        overflow: "truncate"
      }
    },
    yAxis: {
      type: "value",
      axisLabel: { ...label, formatter: (value: number) => spec.formatValue(value) },
      splitLine: { lineStyle: { color: palette.line } }
    },
    tooltip: {
      ...tooltip(spec, palette),
      trigger: "axis",
      axisPointer: {
        type: isBar ? "shadow" : "line",
        lineStyle: { color: palette.text },
        shadowStyle: { color: palette.text, opacity: 0.08 }
      }
    },
    series: spec.series.map((series, index) =>
      isBar ? barSeries(series, index, spec, palette) : lineSeries(series, index, spec, palette)
    )
  };
}

function pieOption(spec: ChartSpec, palette: ChartPalette): ChartOption {
  const values = spec.series[0]?.values ?? [];
  // A slice has no size below zero and none without a value, so those rows are left out.
  const slices = spec.categories.flatMap((name, index) => {
    const value = values[index] ?? null;
    return value !== null && value > 0 ? [{ name, value }] : [];
  });
  return {
    tooltip: { ...tooltip(spec, palette), trigger: "item" },
    series: [
      {
        type: "pie",
        radius: PIE_RADIUS,
        data: slices.map((slice, index) => {
          const look = seriesLook(index, palette);
          return {
            ...slice,
            itemStyle: { color: look.color, opacity: look.repeated ? REPEATED_FILL_OPACITY : 1 }
          };
        }),
        itemStyle: { borderColor: palette.surface, borderWidth: 1 },
        // The slices carry their names, so a pie reads without its colours and has no legend.
        label: {
          color: palette.text,
          // A lighter slice keeps a full-strength label.
          opacity: 1,
          fontSize: palette.fontSize,
          width: SLICE_LABEL_MAX_WIDTH,
          overflow: "truncate",
          formatter: ({ name, value }) =>
            typeof value === "number" ? `${name}: ${spec.formatValue(value)}` : name
        },
        labelLine: { lineStyle: { color: palette.line } },
        labelLayout: { hideOverlap: true },
        emphasis: { scale: false }
      }
    ]
  };
}

function tooltip(spec: ChartSpec, palette: ChartPalette): TooltipComponentOption {
  return {
    // Drawn as SVG text inside the chart: no markup and no inline style reaches the page.
    renderMode: "richText",
    confine: true,
    backgroundColor: palette.tooltipSurface,
    borderColor: palette.line,
    borderWidth: 1,
    textStyle: { color: palette.tooltipText, fontSize: palette.fontSize },
    valueFormatter: (value) => (typeof value === "number" ? spec.formatValue(value) : "")
  };
}

/** The whole ECharts option for a chart. Nothing animates. */
function buildChartOption(spec: ChartSpec, palette: ChartPalette): ChartOption {
  return {
    animation: false,
    backgroundColor: "transparent",
    textStyle: { fontFamily: palette.fontFamily, fontSize: palette.fontSize },
    ...(spec.type === "pie" ? pieOption(spec, palette) : cartesianOption(spec, palette))
  };
}

/** Draws the chart into `container`, which must have a size. */
export function drawChart(
  container: HTMLElement,
  spec: ChartSpec,
  palette: ChartPalette
): ChartHandle {
  const chart = init(container, undefined, { renderer: "svg" });
  chart.setOption(buildChartOption(spec, palette));
  return {
    update: (nextSpec, nextPalette) =>
      chart.setOption(buildChartOption(nextSpec, nextPalette), { notMerge: true }),
    resize: () => chart.resize(),
    dispose: () => chart.dispose()
  };
}

/** The chart as an SVG document, drawn without a browser. */
export function renderChartSvg(spec: ChartSpec, palette: ChartPalette, size: ChartSize): string {
  const chart = init(undefined, undefined, { renderer: "svg", ssr: true, ...size });
  try {
    chart.setOption(buildChartOption(spec, palette));
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}
