import {
  BaselineOffset,
  BooleanNumber,
  BorderStyleTypes,
  CellValueType,
  HorizontalAlign,
  LocaleType,
  TextDecoration,
  VerticalAlign,
  WrapStrategy,
  type IBorderData,
  type IBorderStyleData,
  type ICellData,
  type IColorStyle,
  type IObjectMatrixPrimitiveType,
  type IStyleData,
  type IWorkbookData,
  type IWorksheetData
} from "@univerjs/core";
import ExcelJS, {
  type Alignment,
  type Border,
  type BorderStyle,
  type Borders,
  type Cell,
  type Color,
  type Fill,
  type Style,
  type Worksheet
} from "exceljs";
import {
  extractSpreadsheetVisuals,
  type SpreadsheetVisual
} from "./spreadsheet-visuals";

export async function workbookToUniverSnapshot(buffer: ArrayBuffer): Promise<IWorkbookData> {
  return (await workbookToUniverPreview(buffer)).workbookData;
}

export interface SpreadsheetWorkbookPreview {
  workbookData: IWorkbookData;
  visuals: SpreadsheetVisual[];
}

export async function workbookToUniverPreview(
  buffer: ArrayBuffer
): Promise<SpreadsheetWorkbookPreview> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    return {
      workbookData: await legacyWorkbookToUniverSnapshot(buffer),
      visuals: []
    };
  }

  const styleRegistry = new StyleRegistry();
  const sheetOrder = workbook.worksheets.map((worksheet, index) => sheetId(worksheet.name, index));
  const sheets: IWorkbookData["sheets"] = {};
  workbook.worksheets.forEach((worksheet, index) => {
    sheets[sheetOrder[index]!] = worksheetToUniverSnapshot(
      worksheet,
      sheetOrder[index]!,
      workbook.properties.date1904 === true,
      styleRegistry
    );
  });

  const workbookData: IWorkbookData = {
    id: `workbook-${randomId()}`,
    name: workbook.title || "Workbook",
    appVersion: "3.0.0-alpha",
    locale: LocaleType.EN_US,
    styles: styleRegistry.styles,
    sheetOrder,
    sheets
  };
  const visuals = await extractSpreadsheetVisuals(buffer, workbook);
  for (const visual of visuals) {
    const sheet = Object.values(workbookData.sheets).find((item) => item.name === visual.sheetName);
    if (sheet) {
      sheet.rowCount = Math.max(sheet.rowCount ?? 0, visual.anchor.endRow + 2);
      sheet.columnCount = Math.max(sheet.columnCount ?? 0, visual.anchor.endColumn + 2);
    }
  }
  return { workbookData, visuals };
}

class StyleRegistry {
  readonly styles: IWorkbookData["styles"] = {};
  readonly #ids = new Map<string, string>();

  idFor(style: Partial<Style>): string | undefined {
    const converted = toUniverStyle(style);
    if (!converted) {
      return undefined;
    }
    const key = JSON.stringify(converted);
    const existing = this.#ids.get(key);
    if (existing) {
      return existing;
    }
    const id = `style-${this.#ids.size + 1}`;
    this.#ids.set(key, id);
    this.styles[id] = converted;
    return id;
  }
}

function worksheetToUniverSnapshot(
  worksheet: Worksheet,
  id: string,
  date1904: boolean,
  styleRegistry: StyleRegistry
): Partial<IWorksheetData> {
  const view = worksheet.views?.[0];
  const xSplit = view?.state === "frozen" ? view.xSplit ?? 0 : 0;
  const ySplit = view?.state === "frozen" ? view.ySplit ?? 0 : 0;
  const topLeft = decodeCellAddress(view && "topLeftCell" in view ? view.topLeftCell : undefined);
  const showHeaders = view?.showRowColHeaders !== false;

  return {
    id,
    name: worksheet.name,
    tabColor: colorHex(worksheet.properties.tabColor) ?? "",
    hidden: worksheet.state === "visible" ? BooleanNumber.FALSE : BooleanNumber.TRUE,
    freeze: {
      xSplit,
      ySplit,
      startRow: topLeft?.row ?? ySplit,
      startColumn: topLeft?.column ?? xSplit
    },
    rowCount: Math.max(worksheet.rowCount + 24, 100),
    columnCount: Math.max(worksheet.columnCount + 12, 26),
    zoomRatio: (view?.zoomScale ?? 100) / 100,
    scrollTop: 0,
    scrollLeft: 0,
    defaultColumnWidth: columnWidthPixels(worksheet.properties.defaultColWidth ?? 11.8),
    defaultRowHeight: pointsToPixels(worksheet.properties.defaultRowHeight ?? 15),
    mergeData: worksheet.model.merges.flatMap((range) => {
      const decoded = decodeRange(range);
      return decoded ? [decoded] : [];
    }),
    cellData: worksheetCellData(worksheet, date1904, styleRegistry),
    rowData: rowData(worksheet),
    columnData: columnData(worksheet),
    rowHeader: {
      width: 44,
      hidden: showHeaders ? BooleanNumber.FALSE : BooleanNumber.TRUE
    },
    columnHeader: {
      height: 24,
      hidden: showHeaders ? BooleanNumber.FALSE : BooleanNumber.TRUE
    },
    showGridlines: view?.showGridLines === false ? BooleanNumber.FALSE : BooleanNumber.TRUE,
    rightToLeft: view?.rightToLeft ? BooleanNumber.TRUE : BooleanNumber.FALSE
  };
}

function worksheetCellData(
  worksheet: Worksheet,
  date1904: boolean,
  styleRegistry: StyleRegistry
): IObjectMatrixPrimitiveType<ICellData> {
  const cells: IObjectMatrixPrimitiveType<ICellData> = {};
  worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      if (cell.isMerged && cell.master.address !== cell.address) {
        return;
      }
      const converted = toUniverCell(cell, date1904, styleRegistry);
      if (!converted) {
        return;
      }
      const rowIndex = rowNumber - 1;
      cells[rowIndex] ??= {};
      cells[rowIndex]![columnNumber - 1] = converted;
    });
  });
  return cells;
}

function toUniverCell(
  cell: Cell,
  date1904: boolean,
  styleRegistry: StyleRegistry
): ICellData | undefined {
  const converted: ICellData = {};
  const formula = cell.formula;
  if (formula) {
    converted.f = formula.startsWith("=") ? formula : `=${formula}`;
  }
  const value = formula ? cell.result : cell.value;
  Object.assign(converted, toUniverCellValue(value, date1904));

  const styleId = styleRegistry.idFor(cell.style);
  if (styleId) {
    converted.s = styleId;
  }
  return converted.v !== undefined || converted.f || converted.s ? converted : undefined;
}

function toUniverCellValue(value: unknown, date1904: boolean): Partial<ICellData> {
  if (typeof value === "number") {
    return { v: value, t: CellValueType.NUMBER };
  }
  if (typeof value === "boolean") {
    return { v: value, t: CellValueType.BOOLEAN };
  }
  if (typeof value === "string") {
    return { v: value, t: CellValueType.STRING };
  }
  if (value instanceof Date) {
    return { v: excelDateSerial(value, date1904), t: CellValueType.NUMBER };
  }
  if (!value || typeof value !== "object") {
    return {};
  }
  if ("richText" in value && Array.isArray(value.richText)) {
    return {
      v: value.richText
        .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
        .join(""),
      t: CellValueType.STRING
    };
  }
  if ("text" in value && typeof value.text === "string") {
    return { v: value.text, t: CellValueType.STRING };
  }
  if ("error" in value && typeof value.error === "string") {
    return { v: value.error, t: CellValueType.STRING };
  }
  return {};
}

function toUniverStyle(style: Partial<Style>): IStyleData | undefined {
  const converted: IStyleData = {};
  const font = style.font;
  if (font) {
    converted.ff = font.name;
    converted.fs = font.size;
    converted.bl = font.bold ? BooleanNumber.TRUE : undefined;
    converted.it = font.italic ? BooleanNumber.TRUE : undefined;
    converted.cl = toColorStyle(font.color);
    converted.ul = font.underline && font.underline !== "none"
      ? {
          s: BooleanNumber.TRUE,
          t: String(font.underline).includes("double") ? TextDecoration.DOUBLE : TextDecoration.SINGLE
        }
      : undefined;
    converted.st = font.strike ? { s: BooleanNumber.TRUE } : undefined;
    converted.va = font.vertAlign === "superscript"
      ? BaselineOffset.SUPERSCRIPT
      : font.vertAlign === "subscript"
        ? BaselineOffset.SUBSCRIPT
        : undefined;
  }

  converted.bg = fillColor(style.fill);
  converted.bd = borderData(style.border);
  converted.n = style.numFmt && style.numFmt !== "General" ? { pattern: style.numFmt } : undefined;
  Object.assign(converted, alignmentData(style.alignment));

  return Object.values(converted).some((value) => value !== undefined) ? converted : undefined;
}

function fillColor(fill: Fill | undefined): IColorStyle | undefined {
  return fill?.type === "pattern" && fill.pattern === "solid" ? toColorStyle(fill.fgColor) : undefined;
}

function borderData(borders: Partial<Borders> | undefined): IBorderData | undefined {
  if (!borders) {
    return undefined;
  }
  const converted: IBorderData = {
    t: borderStyle(borders.top),
    r: borderStyle(borders.right),
    b: borderStyle(borders.bottom),
    l: borderStyle(borders.left)
  };
  return Object.values(converted).some(Boolean) ? converted : undefined;
}

function borderStyle(border: Partial<Border> | undefined): IBorderStyleData | undefined {
  if (!border?.style) {
    return undefined;
  }
  return {
    s: BORDER_STYLES[border.style],
    cl: toColorStyle(border.color) ?? { rgb: "#000000" }
  };
}

const BORDER_STYLES: Record<BorderStyle, BorderStyleTypes> = {
  thin: BorderStyleTypes.THIN,
  hair: BorderStyleTypes.HAIR,
  dotted: BorderStyleTypes.DOTTED,
  dashed: BorderStyleTypes.DASHED,
  dashDot: BorderStyleTypes.DASH_DOT,
  dashDotDot: BorderStyleTypes.DASH_DOT_DOT,
  double: BorderStyleTypes.DOUBLE,
  medium: BorderStyleTypes.MEDIUM,
  mediumDashed: BorderStyleTypes.MEDIUM_DASHED,
  mediumDashDot: BorderStyleTypes.MEDIUM_DASH_DOT,
  mediumDashDotDot: BorderStyleTypes.MEDIUM_DASH_DOT_DOT,
  slantDashDot: BorderStyleTypes.SLANT_DASH_DOT,
  thick: BorderStyleTypes.THICK
};

function alignmentData(alignment: Partial<Alignment> | undefined): Partial<IStyleData> {
  if (!alignment) {
    return {};
  }
  return {
    ht: alignment.horizontal ? HORIZONTAL_ALIGNMENTS[alignment.horizontal] : undefined,
    vt: alignment.vertical ? VERTICAL_ALIGNMENTS[alignment.vertical] : undefined,
    tb: alignment.wrapText ? WrapStrategy.WRAP : undefined,
    tr: alignment.textRotation === "vertical"
      ? { a: 0, v: BooleanNumber.TRUE }
      : typeof alignment.textRotation === "number"
        ? { a: alignment.textRotation, v: BooleanNumber.FALSE }
        : undefined
  };
}

const HORIZONTAL_ALIGNMENTS: Record<NonNullable<Alignment["horizontal"]>, HorizontalAlign> = {
  left: HorizontalAlign.LEFT,
  center: HorizontalAlign.CENTER,
  centerContinuous: HorizontalAlign.CENTER,
  right: HorizontalAlign.RIGHT,
  fill: HorizontalAlign.UNSPECIFIED,
  justify: HorizontalAlign.JUSTIFIED,
  distributed: HorizontalAlign.DISTRIBUTED
};

const VERTICAL_ALIGNMENTS: Record<NonNullable<Alignment["vertical"]>, VerticalAlign> = {
  top: VerticalAlign.TOP,
  middle: VerticalAlign.MIDDLE,
  bottom: VerticalAlign.BOTTOM,
  distributed: VerticalAlign.UNSPECIFIED,
  justify: VerticalAlign.UNSPECIFIED
};

function toColorStyle(color: Partial<Color> | undefined): IColorStyle | undefined {
  const rgb = colorHex(color);
  return rgb ? { rgb } : undefined;
}

function colorHex(color: Partial<Color> | undefined): string | undefined {
  const argb = color?.argb?.replace("#", "");
  if (!argb) {
    return undefined;
  }
  if (argb.length === 8 && argb.slice(0, 2) === "00") {
    return undefined;
  }
  const rgb = argb.length === 8 ? argb.slice(2) : argb;
  return rgb.length === 6 ? `#${rgb.toUpperCase()}` : undefined;
}

function rowData(worksheet: Worksheet): IWorksheetData["rowData"] {
  const rows: IWorksheetData["rowData"] = {};
  for (let index = 1; index <= worksheet.rowCount; index += 1) {
    const row = worksheet.findRow(index);
    if (row?.height || row?.hidden) {
      rows[index - 1] = {
        h: row.height ? pointsToPixels(row.height) : undefined,
        hd: row.hidden ? BooleanNumber.TRUE : BooleanNumber.FALSE
      };
    }
  }
  return rows;
}

function columnData(worksheet: Worksheet): IWorksheetData["columnData"] {
  const columns: IWorksheetData["columnData"] = {};
  for (let index = 1; index <= worksheet.columnCount; index += 1) {
    const column = worksheet.getColumn(index);
    if (column.isCustomWidth || column.hidden) {
      columns[index - 1] = {
        w: column.width ? columnWidthPixels(column.width) : undefined,
        hd: column.hidden ? BooleanNumber.TRUE : BooleanNumber.FALSE
      };
    }
  }
  return columns;
}

function decodeRange(range: string): {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
} | undefined {
  const [startText, endText = startText] = range.split(":");
  const start = decodeCellAddress(startText);
  const end = decodeCellAddress(endText);
  return start && end
    ? {
        startRow: start.row,
        endRow: end.row,
        startColumn: start.column,
        endColumn: end.column
      }
    : undefined;
}

function decodeCellAddress(address: string | undefined): { row: number; column: number } | undefined {
  const match = address?.replaceAll("$", "").match(/^([A-Z]+)([1-9][0-9]*)$/iu);
  if (!match) {
    return undefined;
  }
  let column = 0;
  for (const character of match[1]!.toUpperCase()) {
    column = column * 26 + character.charCodeAt(0) - 64;
  }
  return { row: Number(match[2]) - 1, column: column - 1 };
}

function excelDateSerial(value: Date, date1904: boolean): number {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return (value.getTime() - epoch) / 86_400_000;
}

function pointsToPixels(points: number): number {
  return Math.round((points * 96) / 72);
}

function columnWidthPixels(width: number): number {
  return Math.max(1, Math.round(width * 7 + 5));
}

function sheetId(sheetName: string, index: number): string {
  const cleaned = sheetName.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-").replaceAll(/^-|-$/gu, "");
  return `sheet-${cleaned || index + 1}`;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function legacyWorkbookToUniverSnapshot(buffer: ArrayBuffer): Promise<IWorkbookData> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(buffer, {
    cellFormula: true,
    cellText: true,
    type: "array"
  });
  const sheetNames = workbook.SheetNames.length > 0 ? workbook.SheetNames : ["Sheet1"];
  const sheetOrder = sheetNames.map((name, index) => sheetId(name, index));
  const sheets: IWorkbookData["sheets"] = {};

  sheetNames.forEach((name, index) => {
    const worksheet = workbook.Sheets[name] ?? {};
    const range = legacyRange(worksheet["!ref"], XLSX);
    const cells: IObjectMatrixPrimitiveType<ICellData> = {};
    if (range) {
      for (let row = range.s.r; row <= range.e.r; row += 1) {
        for (let column = range.s.c; column <= range.e.c; column += 1) {
          const source = worksheet[XLSX.utils.encode_cell({ r: row, c: column })];
          if (!source) {
            continue;
          }
          const cell: ICellData = {};
          if (source.f) {
            cell.f = source.f.startsWith("=") ? source.f : `=${source.f}`;
          }
          Object.assign(cell, toUniverCellValue(source.v ?? source.w, false));
          if (cell.v === undefined && !cell.f) {
            continue;
          }
          cells[row] ??= {};
          cells[row]![column] = cell;
        }
      }
    }

    sheets[sheetOrder[index]!] = {
      id: sheetOrder[index]!,
      name,
      tabColor: "",
      hidden: BooleanNumber.FALSE,
      freeze: { xSplit: 0, ySplit: 0, startRow: 0, startColumn: 0 },
      rowCount: Math.max((range?.e.r ?? 0) + 24, 100),
      columnCount: Math.max((range?.e.c ?? 0) + 12, 26),
      zoomRatio: 1,
      scrollTop: 0,
      scrollLeft: 0,
      defaultColumnWidth: 88,
      defaultRowHeight: 24,
      mergeData: (worksheet["!merges"] ?? []).map((merge) => ({
        startRow: merge.s.r,
        endRow: merge.e.r,
        startColumn: merge.s.c,
        endColumn: merge.e.c
      })),
      cellData: cells,
      rowData: {},
      columnData: {},
      rowHeader: { width: 44 },
      columnHeader: { height: 24 },
      showGridlines: BooleanNumber.TRUE,
      rightToLeft: BooleanNumber.FALSE
    };
  });

  return {
    id: `workbook-${randomId()}`,
    name: workbook.Props?.Title || "Workbook",
    appVersion: "3.0.0-alpha",
    locale: LocaleType.EN_US,
    styles: {},
    sheetOrder,
    sheets
  };
}

function legacyRange(
  reference: string | undefined,
  XLSX: typeof import("xlsx")
): import("xlsx").Range | undefined {
  if (!reference) {
    return undefined;
  }
  try {
    return XLSX.utils.decode_range(reference);
  } catch {
    return undefined;
  }
}
