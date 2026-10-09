import { BarChart, LineChart, PieChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent
} from "echarts/components";
import * as echarts from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import { useEffect, useRef } from "react";
import { useTranslation, type TranslationContextValue, type TranslationKey } from "./i18n";
import type {
  SpreadsheetChartSeries,
  SpreadsheetObjectType,
  SpreadsheetVisual
} from "./spreadsheet-visuals";

echarts.use([
  BarChart,
  GridComponent,
  LegendComponent,
  LineChart,
  PieChart,
  SVGRenderer,
  TitleComponent,
  TooltipComponent
]);

export const SPREADSHEET_VISUAL_COMPONENT = "catalyst-spreadsheet-visual";

export function SpreadsheetVisualLayer({ data }: { data?: SpreadsheetVisual }) {
  if (!data) {
    return null;
  }
  if (data.kind === "image") {
    return (
      <div className="h-full w-full overflow-hidden bg-white">
        <img
          alt={data.name}
          className="h-full w-full object-contain"
          draggable={false}
          src={data.src}
        />
      </div>
    );
  }
  if (data.kind === "unsupported") {
    return <UnsupportedSpreadsheetVisual visual={data} />;
  }
  return <SpreadsheetChart visual={data} />;
}

const objectTypeKeys = {
  drawing: "spreadsheetObjectDrawing",
  unreadableDrawing: "spreadsheetObjectUnreadableDrawing",
  linkedChart: "spreadsheetObjectLinkedChart",
  linkedImage: "spreadsheetObjectLinkedImage",
  missingImage: "spreadsheetObjectMissingImage",
  shape: "spreadsheetObjectShape",
  groupedDrawing: "spreadsheetObjectGroupedDrawing",
  connector: "spreadsheetObjectConnector",
  embeddedObject: "spreadsheetObjectEmbeddedObject",
  combinedChart: "spreadsheetObjectCombinedChart"
} satisfies Record<string, TranslationKey>;

function spreadsheetObjectTypeLabel(
  t: TranslationContextValue["t"],
  objectType: SpreadsheetObjectType
): string {
  switch (objectType.kind) {
    case "image":
      return t("spreadsheetObjectImage", { format: objectType.format });
    case "chart":
      return t("spreadsheetObjectChart", { chartType: objectType.chartType });
    case "chartWithoutData":
      return t("spreadsheetObjectChartWithoutData", { chartType: objectType.chartType });
    default:
      return t(objectTypeKeys[objectType.kind]);
  }
}

function UnsupportedSpreadsheetVisual({
  visual
}: {
  visual: Extract<SpreadsheetVisual, { kind: "unsupported" }>;
}) {
  const { t } = useTranslation();
  const objectType = spreadsheetObjectTypeLabel(t, visual.objectType);
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 border border-dashed border-slate-300 bg-slate-50 p-4 text-center text-slate-600">
      <strong className="text-sm text-slate-800">{visual.name ?? objectType}</strong>
      <span className="text-xs">{t("spreadsheetVisualUnavailable", { objectType })}</span>
      <span className="text-[11px]">{t("spreadsheetVisualDownloadHint")}</span>
    </div>
  );
}

function SpreadsheetChart({ visual }: { visual: Extract<SpreadsheetVisual, { kind: "chart" }> }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current) {
      return undefined;
    }
    const container = containerRef.current;
    let chart: echarts.ECharts | undefined;
    const render = () => {
      if (container.clientWidth === 0 || container.clientHeight === 0) {
        return;
      }
      if (!chart) {
        chart = echarts.init(container, undefined, { renderer: "svg" });
        chart.setOption(spreadsheetChartOption(visual));
      } else {
        chart.resize();
      }
    };
    const resizeObserver = new ResizeObserver(render);
    resizeObserver.observe(container);
    render();
    return () => {
      resizeObserver.disconnect();
      chart?.dispose();
    };
  }, [visual]);

  return (
    <div
      aria-label={visual.title}
      className="h-full w-full overflow-hidden border border-slate-200 bg-white"
      ref={containerRef}
      role="img"
    />
  );
}

export function spreadsheetChartOption(
  visual: Extract<SpreadsheetVisual, { kind: "chart" }>
): echarts.EChartsCoreOption {
  const colors = visual.series
    .map((series) => series.color)
    .filter((color): color is string => Boolean(color));
  const base = {
    animation: false,
    backgroundColor: "#FFFFFF",
    color: colors.length > 0 ? colors : undefined,
    textStyle: { fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" },
    title: {
      left: "center",
      text: visual.title,
      textStyle: { color: "#17202A", fontSize: 14, fontWeight: 600 }
    },
    tooltip: { confine: true }
  };

  if (visual.chartType === "pie" || visual.chartType === "doughnut") {
    const series = visual.series[0];
    if (!series) return base;
    return {
      ...base,
      legend: { bottom: 4, type: "scroll" },
      tooltip: { confine: true, trigger: "item" },
      series: [
        {
          type: "pie",
          radius: visual.chartType === "doughnut" ? ["42%", "68%"] : "68%",
          center: ["50%", "48%"],
          data: series.values.map((value, index) => ({
            name: series.categories[index] || `Item ${index + 1}`,
            value,
            itemStyle: series.pointColors?.[index]
              ? { color: series.pointColors[index] }
              : undefined
          })),
          label: { formatter: "{b}: {d}%" }
        }
      ]
    };
  }

  const categories = longestCategories(visual.series);
  const horizontal = visual.chartType === "bar";
  const seriesType = visual.chartType === "line" ? "line" : "bar";
  const categoryAxis = {
    data: categories,
    name: visual.categoryAxisTitle,
    nameLocation: "middle",
    nameGap: 28,
    type: "category"
  };
  const valueAxis = {
    name: visual.valueAxisTitle,
    nameLocation: "middle",
    nameGap: 45,
    type: "value"
  };
  return {
    ...base,
    grid: { bottom: 50, containLabel: true, left: 28, right: 20, top: 52 },
    legend: visual.series.length > 1 ? { bottom: 4 } : undefined,
    tooltip: { confine: true, trigger: "axis" },
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? categoryAxis : valueAxis,
    series: visual.series.map((series) => ({
      data: series.values,
      itemStyle: series.color ? { color: series.color } : undefined,
      lineStyle: series.color ? { color: series.color } : undefined,
      name: series.name,
      showSymbol: visual.chartType === "line",
      symbolSize: 5,
      type: seriesType
    }))
  };
}

function longestCategories(series: SpreadsheetChartSeries[]): string[] {
  return series.reduce<string[]>(
    (longest, current) =>
      current.categories.length > longest.length ? current.categories : longest,
    []
  );
}
