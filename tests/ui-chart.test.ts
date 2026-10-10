import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  Chart,
  CHART_MAX_ROWS,
  CHART_MAX_SERIES,
  ChartFieldError,
  UiRoot,
  uiLabelsDe,
  uiLabelsEn,
  type ChartProps,
  type ChartRow
} from "@vivd-catalyst/ui";
import * as chartEngine from "@vivd-catalyst/ui/chart-engine";
import { scanUiGuard } from "./ui-guard-scan";

const { renderChartSvg } = chartEngine;
type ChartSpec = chartEngine.ChartSpec;

const palette: chartEngine.ChartPalette = {
  series: ["series-1", "series-2", "series-3", "series-4", "series-5"],
  text: "text",
  line: "line",
  surface: "surface",
  tooltipSurface: "tooltip-surface",
  tooltipText: "tooltip-text",
  fontFamily: "sans-serif",
  fontSize: 12
};
const size = { width: 640, height: 280 };
const chartTypes = ["bar", "line", "area", "pie"] as const;
const captionClass = "text-caption text-muted-foreground";

const base: ChartProps = {
  type: "bar",
  rows: [
    { month: "Jan", chat: 420, apps: 60 },
    { month: "Feb", chat: 465, apps: 85 }
  ],
  x: "month",
  series: [
    { field: "chat", label: "Chat" },
    { field: "apps", label: "Apps" }
  ],
  locale: "en-US",
  ariaLabel: "Runs per month",
  emptyLabel: "No runs in this period."
};
const chatOnly = [{ field: "chat", label: "Chat" }];

/** The spec the component reads from `base`. */
const baseSpec: ChartSpec = {
  type: "bar",
  categories: ["Jan", "Feb"],
  series: [
    { label: "Chat", values: [420, 465] },
    { label: "Apps", values: [60, 85] }
  ],
  stacked: false,
  formatValue: (value) => new Intl.NumberFormat("en-US").format(value)
};
const chatSpec = { series: baseSpec.series.slice(0, 1) };

/** What the component renders before the engine has loaded: the box and the data table. */
function render(props: Partial<ChartProps>, labels = uiLabelsEn): string {
  return renderToStaticMarkup(
    createElement(UiRoot, { mode: "light", labels }, createElement(Chart, { ...base, ...props }))
  );
}

/** What the engine draws for a spec. A test writes the spec the way the component reads one. */
function draw(spec: Partial<ChartSpec>): string {
  return renderChartSvg({ ...baseSpec, ...spec }, palette, size);
}

/** The texts a drawing shows: axis labels, legend entries and slice labels. */
function texts(svg: string): string[] {
  return [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/gu)].map((match) => match[1] ?? "");
}

/** The shape of each series' markers, by series: the outline and how it is turned. */
function markers(svg: string): Map<string, string> {
  const paths = svg.matchAll(
    /<path d="([^"]+)" transform="matrix\(((?:[^,]+,){4})[^"]*"[^>]*ecmeta_series_index="(\d+)"[^>]*chart"/gu
  );
  return new Map([...paths].map((match) => [match[3] ?? "", `${match[1]} ${match[2]}`]));
}

function manyRows(count: number): ChartRow[] {
  return Array.from({ length: count }, (_, index) => ({ month: `M${index}`, chat: index }));
}

/** The rows of the data table in the markup, as the cells of each row. */
function tableRows(markup: string): string[][] {
  const body = /<tbody>(.*)<\/tbody>/u.exec(markup)?.[1] ?? "";
  return [...body.matchAll(/<tr>(.*?)<\/tr>/gu)].map((row) =>
    [...(row[1] ?? "").matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>/gu)].map((cell) => cell[1] ?? "")
  );
}

function tableHead(markup: string): string[] {
  const head = /<thead>(.*)<\/thead>/u.exec(markup)?.[1] ?? "";
  return [...head.matchAll(/<th[^>]*>(.*?)<\/th>/gu)].map((cell) => cell[1] ?? "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Chart", () => {
  it("names the chart and gives the data as a table beside the hidden drawing", () => {
    const markup = render({});

    expect(markup).toMatch(/^<div class=""><figure aria-label="Runs per month" data-chart="bar"/u);
    expect(markup).not.toContain("data-truncated");
    // Until the engine has loaded the box shows the skeleton, at the chart's height.
    expect(markup).toMatch(/<div aria-hidden="true"[^>]*style="height:280px"><span aria-hidden/u);
    expect(markup).toContain(
      '<div class="sr-only"><table><thead><tr><td></td><th scope="col">Chat</th><th scope="col">Apps</th></tr></thead>'
    );
    expect(markup).toContain('<tr><th scope="row">Feb</th><td>465</td><td>85</td></tr>');
  });

  it("shows the empty label in the chart's box when there are no rows", () => {
    const markup = render({ rows: [], height: 200 });

    expect(markup).toMatch(/style="height:200px"><div[^>]*>No runs in this period\.<\/div>/u);
    expect(markup).not.toContain("<table");
    expect(markup).not.toContain("aria-hidden");
  });

  it("reads one row and a thousand rows", () => {
    expect(tableRows(render({ rows: [{ month: "Jan", chat: 420, apps: 60 }] }))).toEqual([
      ["Jan", "420", "60"]
    ]);

    const thousand = tableRows(render({ rows: manyRows(1000), series: chatOnly }));
    expect(thousand).toHaveLength(1000);
    expect(thousand.at(-1)).toEqual(["M999", "999"]);
  });

  it("keeps negative values, and gives a pie without a value above zero the empty label", () => {
    const rows = [
      { month: "Jan", chat: -40, apps: 10 },
      { month: "Feb", chat: 25, apps: -5 }
    ];

    expect(tableRows(render({ rows }))).toEqual([
      ["Jan", "-40", "10"],
      ["Feb", "25", "-5"]
    ]);
    expect(render({ rows, type: "pie" })).toContain("<table");
    expect(
      render({ rows: [{ month: "Jan", chat: -40 }], series: chatOnly, type: "pie" })
    ).toContain(">No runs in this period.</div></div></figure>");
  });

  it("reads a missing, empty or non-numeric value as a gap and a numeric text as its number", () => {
    const rows: ChartRow[] = [
      { month: "Jan", chat: "12.5", apps: 1 },
      { month: "Feb", apps: 2 },
      { month: "Mar", chat: "n/a", apps: 3 },
      { month: null, chat: "", apps: Number.NaN },
      { chat: 7, apps: Number.POSITIVE_INFINITY }
    ];

    expect(tableRows(render({ rows }))).toEqual([
      ["Jan", "12.5", "1"],
      ["Feb", "", "2"],
      ["Mar", "", "3"],
      ["", "", ""],
      ["", "7", ""]
    ]);
  });

  it("refuses a series whose field holds a number in no row, in development only", () => {
    const wrong = { series: [...base.series, { field: "month", label: "Month" }] };
    const absent = { series: [{ field: "chats", label: "Chat" }] };

    expect(() => render(wrong)).toThrow(ChartFieldError);
    expect(() => render(absent)).toThrow('the series field "chats" holds a number in no row');

    vi.stubEnv("NODE_ENV", "production");
    expect(tableHead(render(wrong))).toEqual(["Chat", "Apps"]);
    expect(render(absent)).toContain(">No runs in this period.</div></div></figure>");
  });

  it("draws a series that is empty in every row as a series without data", () => {
    const rows = [
      { month: "Jan", chat: 1, apps: null },
      { month: "Feb", chat: 2, apps: null }
    ];

    expect(tableHead(render({ rows }))).toEqual(["Chat", "Apps"]);
    expect(tableRows(render({ rows }))).toEqual([
      ["Jan", "1", ""],
      ["Feb", "2", ""]
    ]);
  });

  it("keeps a very long label whole in the table", () => {
    const long = "A very long category name ".repeat(40).trim();
    const markup = render({
      rows: [{ month: long, chat: 1, apps: 2 }],
      series: [{ field: "chat", label: long }]
    });

    expect(tableHead(markup)).toEqual([long]);
    expect(tableRows(markup)).toEqual([[long, "1"]]);
  });

  it("draws the first rows and series up to the caps and says what it cut", () => {
    const series = Array.from({ length: CHART_MAX_SERIES + 1 }, (_, index) => ({
      field: "chat",
      label: `Series ${index}`
    }));

    const cutRows = render({ rows: manyRows(CHART_MAX_ROWS + 1), series: chatOnly });
    expect(cutRows).toContain('data-truncated="rows"');
    expect(cutRows).toContain(`<figcaption class="${captionClass}">${uiLabelsEn.chartTruncated}`);
    expect(render({ rows: manyRows(CHART_MAX_ROWS + 1), series: chatOnly }, uiLabelsDe)).toContain(
      `${uiLabelsDe.chartTruncated}</figcaption>`
    );
    expect(tableRows(cutRows)).toHaveLength(CHART_MAX_ROWS);
    expect(tableRows(cutRows).at(-1)?.[0]).toBe(`M${CHART_MAX_ROWS - 1}`);

    const cutSeries = render({ rows: manyRows(2), series });
    expect(cutSeries).toContain('data-truncated="series"');
    expect(tableHead(cutSeries)).toHaveLength(CHART_MAX_SERIES);
    expect(tableHead(cutSeries).at(-1)).toBe(`Series ${CHART_MAX_SERIES - 1}`);

    expect(render({ rows: manyRows(CHART_MAX_ROWS + 1), series })).toContain(
      'data-truncated="rows series"'
    );
    const atTheCaps = { rows: manyRows(CHART_MAX_ROWS), series: series.slice(0, CHART_MAX_SERIES) };
    expect(render(atTheCaps)).not.toContain("data-truncated");
    expect(render(atTheCaps)).not.toContain("<figcaption");
  });

  it("gives a pie its first series only, which is no cut", () => {
    const markup = render({ type: "pie" });

    expect(tableHead(markup)).toEqual(["Chat"]);
    expect(markup).not.toContain("data-truncated");
  });

  it("formats numbers for the locale", () => {
    const rows = [{ month: "Jan", chat: 1234.5, apps: 0.256 }];
    const euro = { style: "currency", currency: "EUR", maximumFractionDigits: 0 } as const;
    const cells = (props: Partial<ChartProps>) => tableRows(render({ rows, ...props }))[0];

    expect(cells({})).toEqual(["Jan", "1,234.5", "0.256"]);
    expect(cells({ locale: "de-DE" })).toEqual(["Jan", "1.234,5", "0,256"]);
    expect(cells({ locale: "de-DE", format: euro })?.[1]).toBe(
      new Intl.NumberFormat("de-DE", euro).format(1234.5)
    );
    expect(cells({ format: { style: "percent" } })?.[2]).toBe("26%");
    expect(cells({ format: { style: "number", maximumFractionDigits: 0 } })?.[1]).toBe("1,235");
  });

  it("falls back to plain numbers for a locale or currency the runtime does not know", () => {
    const rows = [{ month: "Jan", chat: 1234.5, apps: 2 }];

    expect(tableRows(render({ rows, format: { style: "currency" } }))).toEqual([
      ["Jan", "1,234.5", "2"]
    ]);
    expect(tableRows(render({ rows, locale: "not a locale" }))[0]?.[2]).toBe("2");
  });
});

describe("chart engine", () => {
  const letters = ["a", "b", "c", "d", "e", "f"];
  const six = {
    series: letters.map((letter, index) => ({ label: `S-${letter}`, values: [index, index + 1] }))
  };
  const five = { series: six.series.slice(0, 5) };

  it("colours series from the palette in order, and axis and grid from text and line", () => {
    const drawn = draw({});

    expect(drawn).toContain('fill="series-1"');
    expect(drawn).toContain('fill="series-2"');
    expect(drawn).not.toContain("series-3");
    expect(drawn).toMatch(/<text[^>]*fill="text">500<\/text>/u);
    expect(drawn).toContain('stroke="line"');
  });

  it("never animates", () => {
    for (const type of chartTypes) {
      expect(draw({ type })).not.toMatch(/<animate|@keyframes|animation:/u);
    }
  });

  it("tells series apart without colour: a pattern on bars, a marker shape on lines", () => {
    // The first series is plain and each further one has a pattern of its own.
    expect(draw({}).match(/<pattern/gu)).toHaveLength(1);
    expect(draw(five).match(/<pattern/gu)).toHaveLength(4);
    expect(draw(chatSpec)).not.toContain("<pattern");

    const shapes = [...markers(draw({ ...five, type: "line" })).values()];
    expect(new Set(shapes).size).toBe(5);
  });

  it("repeats the colours from the sixth series on, dashed for lines and lighter for bars", () => {
    const dashed = /<path[^>]*stroke="(series-\d)"[^>]*stroke-dasharray/u;

    expect(dashed.exec(draw({ ...six, type: "line" }))?.[1]).toBe("series-1");
    expect(draw({ ...five, type: "line" })).not.toContain("stroke-dasharray");
    expect(draw(six)).toContain('fill="series-1" fill-opacity="0.55"');
    expect(draw(five)).not.toContain('fill-opacity="0.55"');
  });

  it("stacks bars and areas, and nothing else", () => {
    // Stacked, the axis reaches the sum of both series (465 + 85) and not only the larger one.
    expect(texts(draw({}))).not.toContain("600");
    expect(texts(draw({ stacked: true }))).toContain("600");
    expect(texts(draw({ type: "area", stacked: true }))).toContain("600");
    expect(texts(draw({ type: "line", stacked: true }))).not.toContain("600");
    expect(texts(draw({ type: "area" }))).not.toContain("600");
  });

  it("shows the legend for several series and hides it for one", () => {
    expect(texts(draw({}))).toEqual(expect.arrayContaining(["Chat", "Apps"]));
    expect(texts(draw(chatSpec))).not.toContain("Chat");
  });

  it("labels the slices of a pie, which has no legend and no axis", () => {
    expect(texts(draw({ type: "pie" }))).toEqual(["Jan: 420", "Feb: 465"]);
  });

  it("formats axis and slice values with the spec's formatter", () => {
    const formatValue = (value: number) => `${value} runs`;

    expect(texts(draw({ formatValue }))).toContain("500 runs");
    expect(texts(draw({ type: "pie", formatValue }))).toContain("Jan: 420 runs");
  });

  it("draws nothing for no rows and one point for one row, in every type", () => {
    for (const type of chartTypes) {
      expect(texts(draw({ type, categories: [], series: [] }))).toEqual([]);
      expect(draw({ type, categories: [], series: [{ label: "Chat", values: [] }] })).toContain(
        "<svg"
      );
      const one = draw({ type, categories: ["Jan"], series: [{ label: "Chat", values: [420] }] });
      expect(texts(one).join(" ")).toContain("Jan");
    }
    // One point has no line, so its marker shows.
    const point = draw({
      type: "line",
      categories: ["Jan"],
      series: [{ label: "Chat", values: [420] }]
    });
    expect(markers(point).size).toBe(1);
  });

  it("draws a thousand rows in every type", () => {
    const categories = Array.from({ length: 1000 }, (_, index) => `M${index}`);
    const values = categories.map((_, index) => index + 1);

    for (const type of chartTypes) {
      const drawn = draw({ type, categories, series: [{ label: "Chat", values }] });
      expect(texts(drawn).length).toBeGreaterThan(0);
      // The axis shows some of the thousand labels, never all of them on top of each other.
      expect(texts(drawn).length).toBeLessThan(200);
    }
  });

  it("keeps negative values on the axis and leaves them out of a pie", () => {
    const negative = {
      categories: ["Jan", "Feb", "Mar"],
      series: [{ label: "Chat", values: [-40, 25, null] }]
    };

    expect(texts(draw(negative))).toContain("-40");
    expect(texts(draw({ ...negative, type: "pie" }))).toEqual(["Feb: 25"]);
    for (const type of chartTypes) {
      expect(draw({ ...negative, type, stacked: true })).toContain("<svg");
    }
  });

  it("breaks a line at a gap", () => {
    const gap = {
      type: "line",
      categories: ["Jan", "Feb", "Mar", "Apr", "May"],
      series: [{ label: "Chat", values: [1, 2, null, 4, 5] }]
    } as const;
    const line = /<path d="([^"]+)"[^>]*stroke="series-1"/u.exec(draw(gap));

    expect(line?.[1]?.match(/M/gu)).toHaveLength(2);
    for (const type of chartTypes) {
      const empty = {
        ...gap,
        type,
        series: [{ label: "Chat", values: gap.categories.map(() => null) }]
      };
      expect(draw(empty)).toContain("<svg");
    }
  });

  it("cuts very long labels on the axis, in the legend and on a slice", () => {
    const long = "A very long category name ".repeat(40).trim();
    const spec = {
      categories: [long, `${long} again`],
      series: [
        { label: long, values: [1, 2] },
        { label: "Apps", values: [2, 1] }
      ]
    };

    for (const type of chartTypes) {
      const shown = texts(draw({ ...spec, type }));
      expect(shown.filter((text) => text.startsWith("A very")).length).toBeGreaterThan(0);
      expect(shown.filter((text) => text.length > 40)).toEqual([]);
    }
  });
});

describe("chart labels from untrusted data", () => {
  const script = "<script>alert(1)</script>";
  const image = '<img src=x onerror="alert(1)">';

  it("escapes markup in labels and series names, in the table and in every drawing", () => {
    const markup = render({
      rows: [
        { month: script, chat: 1, apps: 2 },
        { month: image, chat: 2, apps: 1 }
      ],
      series: [
        { field: "chat", label: script },
        { field: "apps", label: image }
      ],
      ariaLabel: image,
      emptyLabel: script
    });
    expect(markup).not.toMatch(/<script|<img/u);
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(render({ rows: [], emptyLabel: script })).not.toContain("<script");

    for (const type of chartTypes) {
      const drawn = draw({
        type,
        categories: [script, image],
        series: [
          { label: script, values: [1, 2] },
          { label: image, values: [2, 1] }
        ]
      });
      expect(drawn).not.toMatch(/<script|<img|<foreignObject/u);
      expect(drawn).toContain("&lt;");
    }
  });
});

describe("chart boundary", () => {
  const source = (file: string) =>
    readFileSync(
      fileURLToPath(new URL(`../packages/ui/src/data/${file}`, import.meta.url)),
      "utf8"
    );
  const imports = (text: string) =>
    [...text.matchAll(/from "([^"]+)"/gu)].map((match) => match[1] ?? "");

  it("takes product-owned props", () => {
    expectTypeOf<ChartProps>().toEqualTypeOf<{
      type: "bar" | "line" | "area" | "pie";
      rows: readonly Record<string, string | number | null>[];
      x: string;
      series: readonly { field: string; label: string }[];
      stacked?: boolean;
      format?: {
        style: "number" | "percent" | "currency";
        currency?: string;
        maximumFractionDigits?: number;
      };
      locale: string;
      height?: number;
      ariaLabel: string;
      emptyLabel: string;
    }>();
  });

  it("keeps ECharts in the engine file, which the component loads on demand", () => {
    const component = source("chart.tsx");
    const engine = source("chart-engine.ts");

    // Only types come from the engine statically. Its code arrives through `import()`.
    expect(component.match(/^import .* from "\.\/chart-engine";$/gmu)).toEqual([
      'import type { ChartHandle, ChartPalette, ChartSpec } from "./chart-engine";'
    ]);
    // Beside the engine's types, the one module of the package that reads the environment.
    expect(imports(source("chart-data.ts"))).toEqual(["../env", "./chart-engine"]);
    expect(source("chart-data.ts")).toContain("import type { ChartSpec, ChartType } from");
    expect(component).toContain('import("./chart-engine")');
    expect(imports(engine).filter((name) => !name.startsWith("echarts/"))).toEqual([]);
    // The engine hands out drawing functions over product-owned types and no option object.
    expect(Object.keys(chartEngine).sort()).toEqual(["drawChart", "renderChartSvg"]);
    // The package does not export the engine: a test reaches it through a source alias only.
    const manifest = readFileSync(
      fileURLToPath(new URL("../packages/ui/package.json", import.meta.url)),
      "utf8"
    );
    expect(manifest).not.toContain("chart-engine");
    expectTypeOf(renderChartSvg).returns.toEqualTypeOf<string>();
  });

  it("is held by the library guard: only the engine file imports ECharts", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));

    expect(scanUiGuard(root).filter((finding) => finding.category === "library-imports")).toEqual(
      []
    );
  });
});
