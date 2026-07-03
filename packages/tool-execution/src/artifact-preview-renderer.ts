import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import * as XLSX from "xlsx";
import type {
  ArtifactPreviewFailureCode,
  ArtifactPreviewImageFormat,
  ArtifactPreviewSourceKind
} from "@vivd-catalyst/core";
import { previewFailure } from "./artifact-preview-failures";

const MAX_SPREADSHEET_PREVIEW_CELLS = 5000;

export interface ArtifactPreviewRenderInput {
  sourceKind: ArtifactPreviewSourceKind;
  filename?: string;
  mimeType: string;
  bytes: Uint8Array;
  pages?: number[];
  slides?: number[];
  sheets?: string[];
  ranges?: string[];
  maxPages: number;
  previewDpi: number;
  outputFormat: ArtifactPreviewImageFormat;
  conversionTimeoutMs: number;
  rasterizationTimeoutMs: number;
  signal?: AbortSignal;
}

export interface ArtifactPreviewRenderedPage {
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  pageNumber?: number;
  slideNumber?: number;
  sheet?: string;
  range?: string;
  width?: number;
  height?: number;
}

export interface ArtifactPreviewRenderResult {
  format: ArtifactPreviewImageFormat;
  pages: ArtifactPreviewRenderedPage[];
}

export interface ArtifactPreviewRenderer {
  render(input: ArtifactPreviewRenderInput): Promise<ArtifactPreviewRenderResult>;
}

export interface LibreOfficeArtifactPreviewRendererOptions {
  sofficeCommand?: string;
  pdfInfoCommand?: string;
  pdfToPpmCommand?: string;
  tempRootDirectory?: string;
}

export class LibreOfficeArtifactPreviewRenderer implements ArtifactPreviewRenderer {
  private readonly sofficeCommand: string;
  private readonly pdfInfoCommand: string;
  private readonly pdfToPpmCommand: string;
  private readonly tempRootDirectory: string;

  constructor(options: LibreOfficeArtifactPreviewRendererOptions = {}) {
    this.sofficeCommand = options.sofficeCommand ?? "soffice";
    this.pdfInfoCommand = options.pdfInfoCommand ?? "pdfinfo";
    this.pdfToPpmCommand = options.pdfToPpmCommand ?? "pdftoppm";
    this.tempRootDirectory = options.tempRootDirectory ?? tmpdir();
  }

  async render(input: ArtifactPreviewRenderInput): Promise<ArtifactPreviewRenderResult> {
    if (input.outputFormat !== "png") {
      throw previewFailure("unsupported_type", false);
    }
    await mkdir(this.tempRootDirectory, { recursive: true });
    const tempDirectory = await mkdtemp(join(this.tempRootDirectory, "catalyst-artifact-preview-"));
    try {
      if (input.sourceKind === "spreadsheet") {
        return await this.renderSpreadsheet(input, tempDirectory);
      }
      const sourcePath = join(tempDirectory, `source${sourceExtension(input)}`);
      const outputDirectory = join(tempDirectory, "out");
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(sourcePath, input.bytes);
      const pdfPath =
        input.sourceKind === "pdf"
          ? sourcePath
          : await this.convertToPdf({
              sourcePath,
              outputDirectory,
              timeoutMs: input.conversionTimeoutMs,
              signal: input.signal
            });
      const pageCount = await this.readPageCount({
        pdfPath,
        timeoutMs: input.rasterizationTimeoutMs,
        signal: input.signal
      });
      if (pageCount <= 0) {
        throw previewFailure("page_limit_exceeded", false);
      }
      const pageNumbers = rasterPageNumbers(input, pageCount);
      const pages: ArtifactPreviewRenderedPage[] = [];
      for (const [index, pageNumber] of pageNumbers.entries()) {
        const bytes = await this.rasterizePdfPage({
          input,
          outputDirectory,
          pageIndex: index,
          pageNumber,
          pdfPath
        });
        pages.push({
          bytes,
          mimeType: "image/png",
          ...(input.sourceKind === "document" || input.sourceKind === "pdf"
            ? { pageNumber }
            : {}),
          ...(input.sourceKind === "presentation" ? { slideNumber: pageNumber } : {}),
          ...readPngDimensions(bytes)
        });
      }
      return { format: "png", pages };
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  private async renderSpreadsheet(
    input: ArtifactPreviewRenderInput,
    tempDirectory: string
  ): Promise<ArtifactPreviewRenderResult> {
    const workbook = readSpreadsheetWorkbook(input.bytes);
    const selections = spreadsheetRenderSelections(workbook, input);
    if (selections.length === 0 || selections.length > input.maxPages) {
      throw previewFailure("page_limit_exceeded", false);
    }

    const pages: ArtifactPreviewRenderedPage[] = [];
    for (const [index, selection] of selections.entries()) {
      const sourcePath = join(tempDirectory, `spreadsheet-preview-${index + 1}.xlsx`);
      const outputDirectory = join(tempDirectory, `spreadsheet-out-${index + 1}`);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(sourcePath, createSpreadsheetPreviewWorkbookBytes(workbook, selection));
      const pdfPath = await this.convertToPdf({
        sourcePath,
        outputDirectory,
        timeoutMs: input.conversionTimeoutMs,
        signal: input.signal
      });
      const pageCount = await this.readPageCount({
        pdfPath,
        timeoutMs: input.rasterizationTimeoutMs,
        signal: input.signal
      });
      if (pageCount <= 0) {
        throw previewFailure("page_limit_exceeded", false);
      }
      const bytes = await this.rasterizePdfPage({
        input,
        outputDirectory,
        pageIndex: index,
        pageNumber: 1,
        pdfPath
      });
      pages.push({
        bytes,
        mimeType: "image/png",
        sheet: selection.sheetName,
        ...(selection.metadataRange ? { range: selection.metadataRange } : {}),
        ...readPngDimensions(bytes)
      });
    }

    return { format: "png", pages };
  }

  private async rasterizePdfPage(input: {
    input: ArtifactPreviewRenderInput;
    outputDirectory: string;
    pageIndex: number;
    pageNumber: number;
    pdfPath: string;
  }): Promise<Uint8Array> {
    const prefix = join(input.outputDirectory, `page-${input.pageIndex + 1}`);
    await runProcess({
      command: this.pdfToPpmCommand,
      args: [
        "-png",
        "-singlefile",
        "-r",
        String(input.input.previewDpi),
        "-f",
        String(input.pageNumber),
        "-l",
        String(input.pageNumber),
        input.pdfPath,
        prefix
      ],
      timeoutMs: input.input.rasterizationTimeoutMs,
      timeoutCode: "rasterization_failed",
      failureCode: "rasterization_failed",
      signal: input.input.signal
    });
    return readFile(`${prefix}.png`);
  }

  private async convertToPdf(input: {
    sourcePath: string;
    outputDirectory: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<string> {
    await runProcess({
      command: this.sofficeCommand,
      args: [
        "--headless",
        "--nologo",
        "--nofirststartwizard",
        "--nodefault",
        "--nolockcheck",
        "--convert-to",
        "pdf",
        "--outdir",
        input.outputDirectory,
        input.sourcePath
      ],
      timeoutMs: input.timeoutMs,
      timeoutCode: "conversion_timeout",
      failureCode: "conversion_failed",
      signal: input.signal
    });
    const expected = join(
      input.outputDirectory,
      `${basename(input.sourcePath, extname(input.sourcePath))}.pdf`
    );
    const entries: string[] = await readdir(input.outputDirectory).catch((): string[] => []);
    if (entries.includes(basename(expected))) {
      return expected;
    }
    const fallback = entries.find((entry) => entry.toLowerCase().endsWith(".pdf"));
    if (!fallback) {
      throw previewFailure("conversion_failed", true);
    }
    return join(input.outputDirectory, fallback);
  }

  private async readPageCount(input: {
    pdfPath: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<number> {
    const result = await runProcess({
      command: this.pdfInfoCommand,
      args: [input.pdfPath],
      timeoutMs: input.timeoutMs,
      timeoutCode: "rasterization_failed",
      failureCode: "rasterization_failed",
      signal: input.signal
    });
    const match = /^Pages:\s+(\d+)\s*$/imu.exec(result.stdout);
    if (!match?.[1]) {
      throw previewFailure("rasterization_failed", true);
    }
    return Number(match[1]);
  }
}

function sourceExtension(input: ArtifactPreviewRenderInput): string {
  const extension = extname(input.filename ?? "").toLowerCase();
  if ([".doc", ".docx", ".ppt", ".pptx", ".pdf", ".xls", ".xlsx", ".ods"].includes(extension)) {
    return extension;
  }
  if (input.sourceKind === "pdf" || input.mimeType.includes("pdf")) {
    return ".pdf";
  }
  if (input.mimeType.includes("presentation") || input.mimeType.includes("powerpoint")) {
    return ".pptx";
  }
  if (
    input.sourceKind === "spreadsheet" ||
    input.mimeType.includes("spreadsheet") ||
    input.mimeType.includes("excel")
  ) {
    return ".xlsx";
  }
  return ".docx";
}

function rasterPageNumbers(input: ArtifactPreviewRenderInput, pageCount: number): number[] {
  const requested = numericRasterSelection(input);
  if (requested.length > 0) {
    const selected = requested.filter((pageNumber) => pageNumber <= pageCount);
    if (selected.length === 0 || selected.length > input.maxPages) {
      throw previewFailure("page_limit_exceeded", false);
    }
    return selected;
  }
  if (pageCount > input.maxPages) {
    throw previewFailure("page_limit_exceeded", false);
  }
  return Array.from({ length: pageCount }, (_, index) => index + 1);
}

function numericRasterSelection(input: ArtifactPreviewRenderInput): number[] {
  if (input.sourceKind === "presentation") {
    return input.slides ?? [];
  }
  if (input.sourceKind === "document" || input.sourceKind === "pdf") {
    return input.pages ?? [];
  }
  return [];
}

interface SpreadsheetRenderSelection {
  sheetName: string;
  metadataRange?: string;
  range: XLSX.Range;
}

function readSpreadsheetWorkbook(bytes: Uint8Array): XLSX.WorkBook {
  try {
    return XLSX.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
      cellStyles: true,
      type: "buffer"
    });
  } catch {
    throw previewFailure("conversion_failed", false);
  }
}

function spreadsheetRenderSelections(
  workbook: XLSX.WorkBook,
  input: ArtifactPreviewRenderInput
): SpreadsheetRenderSelection[] {
  if (input.ranges?.length) {
    const selections = input.ranges.flatMap((rangeText, index) => {
      if (input.sheets && input.sheets.length > 1 && input.ranges?.length === 1) {
        return input.sheets.map((sheetName) =>
          spreadsheetSelectionFromRange(workbook, rangeText, sheetName)
        );
      }
      return [
        spreadsheetSelectionFromRange(
          workbook,
          rangeText,
          input.sheets?.[index] ?? input.sheets?.[0]
        )
      ];
    });
    return selections.slice(0, input.maxPages);
  }

  if (input.sheets?.length) {
    return input.sheets
      .slice(0, input.maxPages)
      .map((sheetName) => spreadsheetSelectionFromSheet(workbook, sheetName));
  }

  return workbook.SheetNames.slice(0, input.maxPages).map((sheetName) =>
    spreadsheetSelectionFromSheet(workbook, sheetName)
  );
}

function spreadsheetSelectionFromRange(
  workbook: XLSX.WorkBook,
  rangeText: string,
  fallbackSheetName: string | undefined
): SpreadsheetRenderSelection {
  const parsed = splitQualifiedSpreadsheetRange(rangeText);
  const sheetName = resolveSpreadsheetSheetName(workbook, parsed.sheetName ?? fallbackSheetName);
  const range = decodeSpreadsheetRange(parsed.rangeText);
  assertSpreadsheetRangeBounds(range);
  return {
    sheetName,
    metadataRange: formatSpreadsheetRange(sheetName, range),
    range
  };
}

function spreadsheetSelectionFromSheet(
  workbook: XLSX.WorkBook,
  requestedSheetName: string
): SpreadsheetRenderSelection {
  const sheetName = resolveSpreadsheetSheetName(workbook, requestedSheetName);
  const worksheet = workbook.Sheets[sheetName];
  const ref = typeof worksheet?.["!ref"] === "string" ? worksheet["!ref"] : "A1:A1";
  const range = decodeSpreadsheetRange(ref);
  assertSpreadsheetRangeBounds(range);
  return { sheetName, range };
}

function resolveSpreadsheetSheetName(
  workbook: XLSX.WorkBook,
  requestedSheetName: string | undefined
): string {
  const name = requestedSheetName?.trim() || workbook.SheetNames[0];
  const match = workbook.SheetNames.find(
    (sheetName) => sheetName.toLowerCase() === name?.toLowerCase()
  );
  if (!match) {
    throw previewFailure("conversion_failed", false);
  }
  return match;
}

function splitQualifiedSpreadsheetRange(input: string): { sheetName?: string; rangeText: string } {
  const trimmed = input.trim();
  let inQuotedSheet = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === "'") {
      if (inQuotedSheet && trimmed[index + 1] === "'") {
        index += 1;
        continue;
      }
      inQuotedSheet = !inQuotedSheet;
      continue;
    }
    if (char === "!" && !inQuotedSheet) {
      return {
        sheetName: unquoteSpreadsheetSheetName(trimmed.slice(0, index)),
        rangeText: trimmed.slice(index + 1)
      };
    }
  }
  return { rangeText: trimmed };
}

function unquoteSpreadsheetSheetName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function decodeSpreadsheetRange(rangeText: string): XLSX.Range {
  try {
    return XLSX.utils.decode_range(rangeText.trim());
  } catch {
    throw previewFailure("conversion_failed", false);
  }
}

function assertSpreadsheetRangeBounds(range: XLSX.Range): void {
  const rowCount = range.e.r - range.s.r + 1;
  const columnCount = range.e.c - range.s.c + 1;
  if (
    rowCount <= 0 ||
    columnCount <= 0 ||
    rowCount * columnCount > MAX_SPREADSHEET_PREVIEW_CELLS
  ) {
    throw previewFailure("page_limit_exceeded", false);
  }
}

function formatSpreadsheetRange(sheetName: string, range: XLSX.Range): string {
  return `${quoteSpreadsheetSheetName(sheetName)}!${XLSX.utils.encode_range(range)}`;
}

function quoteSpreadsheetSheetName(sheetName: string): string {
  return /^[A-Za-z0-9_]+$/u.test(sheetName) ? sheetName : `'${sheetName.replaceAll("'", "''")}'`;
}

function createSpreadsheetPreviewWorkbookBytes(
  workbook: XLSX.WorkBook,
  selection: SpreadsheetRenderSelection
): Uint8Array {
  const sourceSheet = workbook.Sheets[selection.sheetName];
  if (!sourceSheet) {
    throw previewFailure("conversion_failed", false);
  }
  const outputSheet = copySpreadsheetRangeForPreview(sourceSheet, selection.range);
  const outputWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(outputWorkbook, outputSheet, previewSheetName(selection.sheetName));
  const bytes = XLSX.write(outputWorkbook, {
    bookType: "xlsx",
    cellStyles: true,
    type: "buffer"
  }) as Uint8Array | string;
  return typeof bytes === "string" ? Buffer.from(bytes, "binary") : bytes;
}

function copySpreadsheetRangeForPreview(
  sourceSheet: XLSX.WorkSheet,
  range: XLSX.Range
): XLSX.WorkSheet {
  const outputSheet: XLSX.WorkSheet = {
    "!ref": XLSX.utils.encode_range({
      s: { c: 0, r: 0 },
      e: {
        c: range.e.c - range.s.c,
        r: range.e.r - range.s.r
      }
    })
  };

  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const sourceAddress = XLSX.utils.encode_cell({ c: column, r: row });
      const sourceCell = sourceSheet[sourceAddress] as XLSX.CellObject | undefined;
      if (!sourceCell) {
        continue;
      }
      const targetAddress = XLSX.utils.encode_cell({
        c: column - range.s.c,
        r: row - range.s.r
      });
      outputSheet[targetAddress] = spreadsheetPreviewCell(sourceCell);
    }
  }

  const sourceColumns = sourceSheet["!cols"];
  if (sourceColumns) {
    outputSheet["!cols"] = sourceColumns
      .slice(range.s.c, range.e.c + 1)
      .map((column) => ({ ...column }));
  }
  const sourceRows = sourceSheet["!rows"];
  if (sourceRows) {
    outputSheet["!rows"] = sourceRows
      .slice(range.s.r, range.e.r + 1)
      .map((row) => ({ ...row }));
  }
  const merges = sourceSheet["!merges"] ?? [];
  const copiedMerges = merges.flatMap((merge) => {
    if (
      merge.s.r < range.s.r ||
      merge.e.r > range.e.r ||
      merge.s.c < range.s.c ||
      merge.e.c > range.e.c
    ) {
      return [];
    }
    return [
      {
        s: { c: merge.s.c - range.s.c, r: merge.s.r - range.s.r },
        e: { c: merge.e.c - range.s.c, r: merge.e.r - range.s.r }
      }
    ];
  });
  if (copiedMerges.length > 0) {
    outputSheet["!merges"] = copiedMerges;
  }
  return outputSheet;
}

function spreadsheetPreviewCell(sourceCell: XLSX.CellObject): XLSX.CellObject {
  const cell: XLSX.CellObject = { ...sourceCell };
  if (cell.f) {
    delete cell.f;
    delete cell.F;
    if (cell.v === undefined && sourceCell.w !== undefined) {
      cell.t = "s";
      cell.v = sourceCell.w;
    }
  }
  return cell;
}

function previewSheetName(sheetName: string): string {
  const cleaned = sheetName.replaceAll(/[:\\/?*\[\]]/gu, " ").trim();
  return (cleaned || "Preview").slice(0, 31);
}

async function runProcess(input: {
  command: string;
  args: string[];
  timeoutMs: number;
  timeoutCode: ArtifactPreviewFailureCode;
  failureCode: ArtifactPreviewFailureCode;
  signal?: AbortSignal;
}): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let stdout = "";
    const child = spawn(input.command, input.args, {
      stdio: ["ignore", "pipe", "pipe"],
      signal: input.signal
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-65536);
    });
    child.stderr.on("data", () => undefined);
    child.on("error", () => {
      clearTimeout(timer);
      reject(previewFailure(input.failureCode, true));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(previewFailure(input.timeoutCode, true));
        return;
      }
      if (code !== 0) {
        reject(previewFailure(input.failureCode, true));
        return;
      }
      resolve({ stdout });
    });
  });
}

function readPngDimensions(bytes: Uint8Array): { width?: number; height?: number } {
  if (
    bytes.byteLength < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    return {};
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getUint32(16),
    height: view.getUint32(20)
  };
}
