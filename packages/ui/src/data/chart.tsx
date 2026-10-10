import { memo, Suspense, use, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Skeleton } from "../feedback/skeleton";
import type { ThemeTokenName } from "../theme";
import { useUiLabels } from "../ui-root";
import { readChart, type ChartData } from "./chart-data";
import type { ChartHandle, ChartPalette, ChartSpec } from "./chart-engine";

export interface ChartProps extends ChartData {
  /** The height of the chart's box in pixels. The box takes the width it is given. */
  height?: number;
  /** Names the chart for assistive technology, which reads the data as a table. */
  ariaLabel: string;
  /** Shown in the chart's box when there is nothing to draw. */
  emptyLabel: string;
}

const CHART_DEFAULT_HEIGHT = 280;

type ChartEngine = typeof import("./chart-engine");
let chartEngine: Promise<ChartEngine | undefined> | undefined;

/**
 * The engine is one chunk, requested when the first chart mounts. A failed request resolves to
 * `undefined` and is forgotten, so the chart that asked says so in its box and the next chart
 * to mount asks again.
 */
function loadChartEngine(): Promise<ChartEngine | undefined> {
  chartEngine ??= import("./chart-engine").catch(() => {
    chartEngine = undefined;
    return undefined;
  });
  return chartEngine;
}

const SERIES_TOKENS: readonly ThemeTokenName[] = [
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5"
];

/** Resolves the tokens where the chart sits, so a nested root draws with its own theme. */
function readPalette(container: HTMLElement): ChartPalette {
  const probe = container.ownerDocument.createElement("span");
  container.append(probe);
  const color = (token: ThemeTokenName): string => {
    probe.style.color = `var(${token})`;
    return getComputedStyle(probe).color;
  };
  const text = getComputedStyle(container);
  const palette: ChartPalette = {
    series: SERIES_TOKENS.map(color),
    text: color("--muted-foreground"),
    line: color("--border"),
    surface: color("--background"),
    tooltipSurface: color("--popover"),
    tooltipText: color("--popover-foreground"),
    fontFamily: text.fontFamily,
    fontSize: Number.parseFloat(text.fontSize)
  };
  probe.remove();
  return palette;
}

function useStable<Value>(value: Value): Value {
  const [stable, setStable] = useState(value);
  if (stable !== value && JSON.stringify(stable) !== JSON.stringify(value)) {
    setStable(value);
    return value;
  }
  return stable;
}

interface Drawing {
  spec: ChartSpec;
  palette: ChartPalette | undefined;
  handle: ChartHandle | undefined;
}

interface ChartCanvasProps {
  spec: ChartSpec;
  loading: Promise<ChartEngine | undefined>;
  /** Shown when the engine could not be loaded. */
  fallback: ReactNode;
}

function ChartCanvas({ spec, loading, fallback }: ChartCanvasProps) {
  const engine = use(loading);
  const containerRef = useRef<HTMLDivElement>(null);
  const drawingRef = useRef<Drawing>({ spec, palette: undefined, handle: undefined });

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !engine) {
      return undefined;
    }
    const drawing = drawingRef.current;
    const draw = () => {
      // The engine cannot measure a box without a size, such as one inside a closed tab.
      if (container.clientWidth === 0 || container.clientHeight === 0) {
        return;
      }
      if (drawing.handle) {
        drawing.handle.resize();
        return;
      }
      drawing.palette = readPalette(container);
      drawing.handle = engine.drawChart(container, drawing.spec, drawing.palette);
    };
    const resizeObserver = new ResizeObserver(draw);
    resizeObserver.observe(container);

    // The tokens live on a root above the chart: a theme or mode change shows as a changed
    // `style` or `class` on an ancestor.
    const themeObserver = new MutationObserver(() => {
      if (!drawing.handle) {
        return;
      }
      const palette = readPalette(container);
      if (JSON.stringify(palette) !== JSON.stringify(drawing.palette)) {
        drawing.palette = palette;
        drawing.handle.update(drawing.spec, palette);
      }
    });
    for (let ancestor = container.parentElement; ancestor; ancestor = ancestor.parentElement) {
      themeObserver.observe(ancestor, { attributes: true, attributeFilter: ["class", "style"] });
    }

    draw();
    return () => {
      resizeObserver.disconnect();
      themeObserver.disconnect();
      drawing.handle?.dispose();
      drawing.handle = undefined;
    };
  }, [engine]);

  useEffect(() => {
    const drawing = drawingRef.current;
    if (drawing.spec === spec) {
      return;
    }
    drawing.spec = spec;
    if (drawing.handle && drawing.palette) {
      drawing.handle.update(spec, drawing.palette);
    }
  }, [spec]);

  return engine ? <div ref={containerRef} className="size-full" /> : fallback;
}

/** What the chart's box shows in place of a drawing: one sentence. */
function ChartNotice({ children }: { children: ReactNode }) {
  return (
    <div className="flex size-full items-center justify-center rounded-md border border-dashed px-4 text-center text-body text-muted-foreground">
      {children}
    </div>
  );
}

/** The chart's data for a reader who does not see the drawing. */
const ChartTable = memo(function ChartTable({ spec }: { spec: ChartSpec }) {
  return (
    <div className="sr-only">
      <table>
        <thead>
          <tr>
            <td />
            {spec.series.map((series, index) => (
              <th key={index} scope="col">
                {series.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.categories.map((category, row) => (
            <tr key={row}>
              <th scope="row">{category}</th>
              {spec.series.map((series, index) => {
                const value = series.values[row] ?? null;
                return <td key={index}>{value === null ? null : spec.formatValue(value)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

/**
 * A bar, line, area or pie chart of the caller's rows. Its colours are the chart tokens of the
 * theme it sits in and follow a theme or mode change. Nothing animates. The drawing is hidden
 * from assistive technology, which gets `ariaLabel` and the same data as a table. The engine is
 * loaded when the first chart mounts; until then the box shows a skeleton. A chart that had to
 * cut rows or series says so under its box.
 */
export function Chart({
  type,
  rows,
  x,
  series,
  stacked,
  format,
  locale,
  height = CHART_DEFAULT_HEIGHT,
  ariaLabel,
  emptyLabel
}: ChartProps) {
  const labels = useUiLabels("Chart");
  // A caller writes these inline, so they are compared by content and not by identity.
  const stableSeries = useStable(series);
  const stableFormat = useStable(format);
  const { spec, truncated, drawable } = useMemo(
    () => readChart({ type, rows, x, series: stableSeries, stacked, format: stableFormat, locale }),
    [type, rows, x, stableSeries, stacked, stableFormat, locale]
  );
  // One request per mounted chart: a chart whose request failed does not ask again by itself.
  const [loading] = useState(loadChartEngine);
  return (
    <figure
      aria-label={ariaLabel}
      data-chart={type}
      data-truncated={truncated}
      className="m-0 grid w-full min-w-0 gap-2"
    >
      {drawable ? (
        <>
          <div aria-hidden="true" className="w-full text-caption" style={{ height }}>
            <Suspense fallback={<Skeleton shape="block" className="h-full" />}>
              <ChartCanvas
                spec={spec}
                loading={loading}
                fallback={<ChartNotice>{labels.chartLoadFailed}</ChartNotice>}
              />
            </Suspense>
          </div>
          <ChartTable spec={spec} />
        </>
      ) : (
        <div style={{ height }}>
          <ChartNotice>{emptyLabel}</ChartNotice>
        </div>
      )}
      {truncated === undefined ? null : (
        <figcaption className="text-caption text-muted-foreground">
          {labels.chartTruncated}
        </figcaption>
      )}
    </figure>
  );
}
