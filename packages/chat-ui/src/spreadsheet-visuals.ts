import { XMLParser } from "fast-xml-parser";
import type ExcelJS from "exceljs";
import JSZip from "jszip";

export interface SpreadsheetVisualAnchor {
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
  width?: number;
  height?: number;
}

export interface SpreadsheetChartSeries {
  name: string;
  categories: string[];
  values: number[];
  color?: string;
  pointColors?: string[];
}

export type SpreadsheetVisual =
  | {
      id: string;
      kind: "chart";
      sheetName: string;
      name: string;
      anchor: SpreadsheetVisualAnchor;
      chartType: "bar" | "column" | "line" | "pie" | "doughnut";
      title: string;
      series: SpreadsheetChartSeries[];
      categoryAxisTitle?: string;
      valueAxisTitle?: string;
    }
  | {
      id: string;
      kind: "image";
      sheetName: string;
      name: string;
      anchor: SpreadsheetVisualAnchor;
      src: string;
    }
  | {
      id: string;
      kind: "unsupported";
      sheetName: string;
      name: string;
      anchor: SpreadsheetVisualAnchor;
      objectType: string;
    };

type XmlNode = Record<string, unknown>;
type Relationship = { id: string; target: string; external: boolean };

const XML = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true
});
const EMUS_PER_PIXEL = 9525;

export async function extractSpreadsheetVisuals(
  buffer: ArrayBuffer,
  workbook: ExcelJS.Workbook
): Promise<SpreadsheetVisual[]> {
  const zip = await JSZip.loadAsync(buffer);
  const workbookXml = await readXml(zip, "xl/workbook.xml");
  const workbookRelationships = await readRelationships(zip, "xl/workbook.xml");
  const sheets = asArray(at(workbookXml, "workbook", "sheets", "sheet"));
  const visuals: SpreadsheetVisual[] = [];

  for (const sheet of sheets) {
    const sheetName = attribute(sheet, "name");
    const relationship = workbookRelationships.get(attribute(sheet, "id"));
    if (!sheetName || !relationship || relationship.external) {
      continue;
    }
    const sheetPath = resolvePartPath("xl/workbook.xml", relationship.target);
    const worksheetXml = await readXml(zip, sheetPath);
    const drawingIds = asArray(at(worksheetXml, "worksheet", "drawing"))
      .map((drawing) => attribute(drawing, "id"))
      .filter(Boolean);
    if (drawingIds.length === 0) {
      continue;
    }

    const worksheetRelationships = await readRelationships(zip, sheetPath);
    for (const drawingId of drawingIds) {
      const drawingRelationship = worksheetRelationships.get(drawingId);
      if (!drawingRelationship || drawingRelationship.external) {
        visuals.push(unsupported(sheetName, `drawing-${drawingId}`, "Drawing", defaultAnchor()));
        continue;
      }
      const drawingPath = resolvePartPath(sheetPath, drawingRelationship.target);
      visuals.push(
        ...(await drawingVisuals(zip, drawingPath, sheetName, workbook))
      );
    }
  }

  return visuals;
}

async function drawingVisuals(
  zip: JSZip,
  drawingPath: string,
  sheetName: string,
  workbook: ExcelJS.Workbook
): Promise<SpreadsheetVisual[]> {
  try {
    const drawingXml = await readXml(zip, drawingPath);
    const drawingRelationships = await readRelationships(zip, drawingPath);
    const root = node(drawingXml, "wsDr");
    const anchors = [
      ...asArray(root?.twoCellAnchor),
      ...asArray(root?.oneCellAnchor),
      ...asArray(root?.absoluteAnchor)
    ];

    return await Promise.all(
      anchors.map((anchor, index) =>
        drawingVisual(
          zip,
          drawingPath,
          drawingRelationships,
          sheetName,
          workbook,
          anchor,
          index
        )
      )
    );
  } catch {
    return [unsupported(sheetName, `drawing-${drawingPath}`, "Unreadable drawing", defaultAnchor())];
  }
}

async function drawingVisual(
  zip: JSZip,
  drawingPath: string,
  relationships: Map<string, Relationship>,
  sheetName: string,
  workbook: ExcelJS.Workbook,
  anchorNode: XmlNode,
  index: number
): Promise<SpreadsheetVisual> {
  const anchor = parseAnchor(anchorNode);
  const frame = object(anchorNode.graphicFrame);
  const picture = object(anchorNode.pic);
  const drawing = frame
    ?? picture
    ?? object(anchorNode.sp)
    ?? object(anchorNode.grpSp)
    ?? object(anchorNode.cxnSp);
  const name = drawingName(drawing ?? anchorNode) || `Visual ${index + 1}`;
  const id = `${sheetName}-${name}-${index}`.replaceAll(/[^a-z0-9-]+/giu, "-");

  if (frame) {
    const chartId = attribute(node(frame, "graphic", "graphicData", "chart"), "id");
    if (chartId) {
      const relationship = relationships.get(chartId);
      if (!relationship || relationship.external) {
        return unsupported(sheetName, id, "Linked chart", anchor, name);
      }
      const chartPath = resolvePartPath(drawingPath, relationship.target);
      const chartXml = await readXml(zip, chartPath);
      return parseChart(chartXml, workbook, sheetName, id, name, anchor);
    }
    return unsupported(sheetName, id, "Drawing", anchor, name);
  }

  if (picture) {
    const imageId = attribute(node(picture, "blipFill", "blip"), "embed");
    const relationship = relationships.get(imageId);
    if (!relationship || relationship.external) {
      return unsupported(sheetName, id, "Linked image", anchor, name);
    }
    const imagePath = resolvePartPath(drawingPath, relationship.target);
    const image = zip.file(imagePath);
    if (!image) {
      return unsupported(sheetName, id, "Missing image", anchor, name);
    }
    const extension = imagePath.split(".").pop()?.toLowerCase() ?? "";
    const mime = IMAGE_MIME_TYPES[extension];
    if (!mime) {
      return unsupported(sheetName, id, `${extension.toUpperCase()} image`, anchor, name);
    }
    return {
      id,
      kind: "image",
      sheetName,
      name,
      anchor,
      src: `data:${mime};base64,${await image.async("base64")}`
    };
  }

  const objectType = anchorNode.sp
    ? "Shape"
    : anchorNode.grpSp
      ? "Grouped drawing"
      : anchorNode.cxnSp
        ? "Connector"
        : anchorNode.contentPart
          ? "Embedded object"
          : "Drawing";
  return unsupported(sheetName, id, objectType, anchor, name);
}

function parseChart(
  chartXml: XmlNode,
  workbook: ExcelJS.Workbook,
  sheetName: string,
  id: string,
  name: string,
  anchor: SpreadsheetVisualAnchor
): SpreadsheetVisual {
  const chart = object(node(chartXml, "chartSpace", "chart"));
  const plotArea = object(chart?.plotArea);
  const chartEntries = Object.entries(plotArea ?? {}).filter(([key]) => key.endsWith("Chart"));
  const title = xmlText(chart?.title) || name;

  if (chartEntries.length !== 1) {
    return unsupported(sheetName, id, "Combined chart", anchor, title);
  }

  const [rawType, rawChart] = chartEntries[0]!;
  const chartNode = object(rawChart);
  const chartType = supportedChartType(rawType, chartNode);
  if (!chartType) {
    return unsupported(sheetName, id, humanizeChartType(rawType), anchor, title);
  }

  const series = asArray(chartNode?.ser).map((item, index) =>
    chartSeries(item, workbook, index)
  );
  if (series.length === 0 || series.every((item) => item.values.length === 0)) {
    return unsupported(sheetName, id, `${humanizeChartType(rawType)} without preview data`, anchor, title);
  }

  return {
    id,
    kind: "chart",
    sheetName,
    name,
    anchor,
    chartType,
    title,
    series,
    categoryAxisTitle: xmlText(asArray(plotArea?.catAx)[0]?.title) || undefined,
    valueAxisTitle: xmlText(asArray(plotArea?.valAx)[0]?.title) || undefined
  };
}

function chartSeries(
  series: XmlNode,
  workbook: ExcelJS.Workbook,
  index: number
): SpreadsheetChartSeries {
  const categoryReference = referenceFormula(series.cat);
  const valueReference = referenceFormula(series.val);
  const categories = (
    categoryReference ? referenceValues(workbook, categoryReference) : []
  );
  const values = (
    valueReference ? referenceValues(workbook, valueReference) : []
  );
  const resolvedCategories = (categories.length > 0 ? categories : cachedValues(series.cat))
    .map(categoryLabel);
  const resolvedValues = (values.length > 0 ? values : cachedValues(series.val))
    .map(numericValue)
    .filter((value): value is number => value !== undefined);
  const points = asArray(series.dPt);

  return {
    name: chartText(series.tx) || `Series ${index + 1}`,
    categories: resolvedCategories,
    values: resolvedValues,
    color: colorValue(node(series, "spPr", "solidFill", "srgbClr"))
      ?? colorValue(node(series, "spPr", "ln", "solidFill", "srgbClr")),
    pointColors: points
      .sort((left, right) => numberValue(left.idx) - numberValue(right.idx))
      .map((point) => colorValue(node(point, "spPr", "solidFill", "srgbClr")) ?? "")
  };
}

function supportedChartType(
  rawType: string,
  chart: XmlNode | undefined
): Extract<SpreadsheetVisual, { kind: "chart" }>["chartType"] | undefined {
  if (rawType === "barChart") {
    return attribute(chart?.barDir, "val") === "bar" ? "bar" : "column";
  }
  if (rawType === "lineChart") {
    return "line";
  }
  if (rawType === "pieChart") {
    return "pie";
  }
  if (rawType === "doughnutChart") {
    return "doughnut";
  }
  return undefined;
}

function referenceFormula(value: unknown): string | undefined {
  const container = object(value);
  for (const key of ["strRef", "numRef", "multiLvlStrRef"]) {
    const formula = object(container?.[key])?.f;
    if (typeof formula === "string") {
      return formula;
    }
  }
  return undefined;
}

function referenceValues(workbook: ExcelJS.Workbook, formula: string): unknown[] {
  const match = formula.replace(/^=/u, "").match(
    /^(?:'((?:[^']|'')+)'|([^!]+))!(\$?[A-Z]+\$?\d+)(?::(\$?[A-Z]+\$?\d+))?$/iu
  );
  if (!match) {
    return [];
  }
  const sheetName = (match[1] ?? match[2] ?? "").replaceAll("''", "'");
  const worksheet = workbook.getWorksheet(sheetName);
  const start = cellAddress(match[3]);
  const end = cellAddress(match[4] ?? match[3]);
  if (!worksheet || !start || !end) {
    return [];
  }

  const values: unknown[] = [];
  for (let row = start.row; row <= end.row; row += 1) {
    for (let column = start.column; column <= end.column; column += 1) {
      const cell = worksheet.getCell(row, column);
      values.push(cell.formula ? cell.result : cell.value);
    }
  }
  return values;
}

function cachedValues(value: unknown): unknown[] {
  const container = object(value);
  for (const key of ["strRef", "numRef", "strLit", "numLit", "multiLvlStrRef"]) {
    const source = object(container?.[key]);
    const cache = object(source?.strCache ?? source?.numCache ?? source?.multiLvlStrCache ?? source);
    const points = asArray(cache?.pt);
    if (points.length > 0) {
      return points
        .sort((left, right) => numberValue(attribute(left, "idx")) - numberValue(attribute(right, "idx")))
        .map((point) => point.v);
    }
  }
  return [];
}

function parseAnchor(anchor: XmlNode): SpreadsheetVisualAnchor {
  const from = object(anchor.from);
  const to = object(anchor.to);
  const startRow = numberValue(from?.row);
  const startColumn = numberValue(from?.col);
  if (to) {
    const rowOffset = numberValue(to.rowOff);
    const columnOffset = numberValue(to.colOff);
    return {
      startRow,
      startColumn,
      endRow: Math.max(startRow, numberValue(to.row) - (rowOffset === 0 ? 1 : 0)),
      endColumn: Math.max(startColumn, numberValue(to.col) - (columnOffset === 0 ? 1 : 0))
    };
  }
  const extent = object(anchor.ext);
  return {
    startRow,
    startColumn,
    endRow: startRow,
    endColumn: startColumn,
    width: emusToPixels(attribute(extent, "cx")),
    height: emusToPixels(attribute(extent, "cy"))
  };
}

function drawingName(value: XmlNode): string | undefined {
  return attribute(
    node(value, "nvGraphicFramePr", "cNvPr")
      ?? node(value, "nvPicPr", "cNvPr")
      ?? node(value, "nvSpPr", "cNvPr"),
    "name"
  );
}

function unsupported(
  sheetName: string,
  id: string,
  objectType: string,
  anchor: SpreadsheetVisualAnchor,
  name = objectType
): SpreadsheetVisual {
  return { id, kind: "unsupported", sheetName, name, anchor, objectType };
}

function defaultAnchor(): SpreadsheetVisualAnchor {
  return { startRow: 0, startColumn: 0, endRow: 3, endColumn: 3 };
}

async function readXml(zip: JSZip, path: string): Promise<XmlNode> {
  const file = zip.file(path);
  if (!file) {
    throw new Error(`Missing XLSX part: ${path}`);
  }
  return object(XML.parse(await file.async("string"))) ?? {};
}

async function readRelationships(zip: JSZip, partPath: string): Promise<Map<string, Relationship>> {
  const path = relationshipsPath(partPath);
  const file = zip.file(path);
  if (!file) {
    return new Map();
  }
  const xml = object(XML.parse(await file.async("string")));
  return new Map(
    asArray(at(xml, "Relationships", "Relationship"))
      .map((relationship): [string, Relationship] | undefined => {
        const id = attribute(relationship, "Id");
        const target = attribute(relationship, "Target");
        return id && target
          ? [id, { id, target, external: attribute(relationship, "TargetMode") === "External" }]
          : undefined;
      })
      .filter((item): item is [string, Relationship] => item !== undefined)
  );
}

function relationshipsPath(partPath: string): string {
  const segments = partPath.split("/");
  const filename = segments.pop()!;
  return [...segments, "_rels", `${filename}.rels`].join("/");
}

function resolvePartPath(partPath: string, target: string): string {
  if (target.startsWith("/")) {
    return target.slice(1);
  }
  const segments = partPath.split("/");
  segments.pop();
  for (const segment of target.split("/")) {
    if (segment === "..") {
      segments.pop();
    } else if (segment !== "." && segment !== "") {
      segments.push(segment);
    }
  }
  return segments.join("/");
}

function node(value: unknown, ...path: string[]): XmlNode | undefined {
  return object(at(value, ...path));
}

function at(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    current = object(current)?.[key];
  }
  return current;
}

function object(value: unknown): XmlNode | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as XmlNode
    : undefined;
}

function asArray(value: unknown): XmlNode[] {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .map(object)
    .filter((item): item is XmlNode => item !== undefined);
}

function attribute(value: unknown, name: string): string {
  const raw = object(value)?.[`@_${name}`];
  return raw === undefined || raw === null ? "" : String(raw);
}

function numberValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function numericValue(value: unknown): number | undefined {
  const unwrapped = formulaResult(value);
  const number = typeof unwrapped === "number" ? unwrapped : Number(unwrapped);
  return Number.isFinite(number) ? number : undefined;
}

function categoryLabel(value: unknown): string {
  const unwrapped = formulaResult(value);
  if (unwrapped instanceof Date) {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC"
    }).format(unwrapped);
  }
  return unwrapped === undefined || unwrapped === null ? "" : String(unwrapped);
}

function formulaResult(value: unknown): unknown {
  return object(value)?.result ?? value;
}

function cellAddress(address: string | undefined): { row: number; column: number } | undefined {
  const match = address?.replaceAll("$", "").match(/^([A-Z]+)([1-9][0-9]*)$/iu);
  if (!match) {
    return undefined;
  }
  let column = 0;
  for (const character of match[1]!.toUpperCase()) {
    column = column * 26 + character.charCodeAt(0) - 64;
  }
  return { row: Number(match[2]), column };
}

function colorValue(value: unknown): string | undefined {
  const color = attribute(value, "val");
  return /^[0-9a-f]{6}$/iu.test(color) ? `#${color.toUpperCase()}` : undefined;
}

function xmlText(value: unknown): string {
  const texts: string[] = [];
  collectXmlText(value, texts);
  return texts.join("").trim();
}

function chartText(value: unknown): string {
  const literal = object(value)?.v;
  return literal === undefined ? xmlText(value) : String(literal).trim();
}

function collectXmlText(value: unknown, texts: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectXmlText(item, texts));
    return;
  }
  const container = object(value);
  if (!container) {
    return;
  }
  for (const [key, child] of Object.entries(container)) {
    if (key === "t" && (typeof child === "string" || typeof child === "number")) {
      texts.push(String(child));
    } else {
      collectXmlText(child, texts);
    }
  }
}

function humanizeChartType(value: string): string {
  return `${value
    .replace(/Chart$/u, "")
    .replaceAll(/([a-z])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .replace(/^./u, (character) => character.toUpperCase())} chart`;
}

function emusToPixels(value: unknown): number | undefined {
  const pixels = numberValue(value) / EMUS_PER_PIXEL;
  return pixels > 0 ? Math.round(pixels) : undefined;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  bmp: "image/bmp",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp"
};
