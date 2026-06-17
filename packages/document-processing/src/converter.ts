import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  DocumentAttachmentWarning,
  DocumentFileFormat,
  DocumentPreprocessingConfig
} from "@vivd-catalyst/core";
import {
  createDefaultDocumentExecutionEnvironment,
  type DocumentExecutionEnvironment
} from "./execution-environment";
import { hasDocxZipPackageSignature } from "./document-format";

export interface ConvertDocumentInput {
  bytes: Uint8Array;
  filename: string;
  mimeType?: string;
  format: DocumentFileFormat;
}

export interface PreparedPdfPage {
  pageNumber: number;
  text: string;
  characterCount: number;
  wordCount: number;
  warnings: DocumentAttachmentWarning[];
}

export interface PreparedPdfPagesArtifact {
  format: "pdf";
  pageCount: number;
  pages: PreparedPdfPage[];
}

export interface CanonicalPdfOutput {
  bytes: Uint8Array;
  mimeType: "application/pdf";
}

export interface ConvertDocumentOutput {
  engine: "platform_pdf" | "libreoffice_pdf" | "markitdown" | "direct_text";
  text: string;
  textMimeType: "text/plain" | "text/markdown";
  pageCount?: number;
  pages?: PreparedPdfPagesArtifact;
  canonicalPdf?: CanonicalPdfOutput;
  warnings: DocumentAttachmentWarning[];
}

export interface DocumentPreprocessor {
  convert(input: ConvertDocumentInput): Promise<ConvertDocumentOutput>;
}

export class PlatformDocumentPreprocessor implements DocumentPreprocessor {
  private readonly config: DocumentPreprocessingConfig;
  private readonly environment: DocumentExecutionEnvironment;

  constructor(
    config: DocumentPreprocessingConfig,
    environment: DocumentExecutionEnvironment = createDefaultDocumentExecutionEnvironment()
  ) {
    this.config = config;
    this.environment = environment;
  }

  async convert(input: ConvertDocumentInput): Promise<ConvertDocumentOutput> {
    if (input.format === "txt" || input.format === "md") {
      return {
        engine: "direct_text",
        text: decodeUtf8(input.bytes),
        textMimeType: input.format === "md" ? "text/markdown" : "text/plain",
        warnings: []
      };
    }

    if (input.format === "pdf") {
      return this.convertPdf(input);
    }

    if (input.format === "docx" && !hasDocxZipPackageSignature(input.bytes)) {
      throw new Error("The file is marked as DOCX but is not a valid Word document package.");
    }

    if (input.format === "docx") {
      return this.convertDocxThroughCanonicalPdf(input);
    }

    return this.convertWithMarkItDown(input);
  }

  private async convertDocxThroughCanonicalPdf(
    input: ConvertDocumentInput
  ): Promise<ConvertDocumentOutput> {
    const canonicalPdf = await this.convertOfficeDocumentToPdf(input);
    const converted = await this.convertPdf({
      bytes: canonicalPdf.bytes,
      filename: `${input.filename}.canonical.pdf`,
      mimeType: canonicalPdf.mimeType,
      format: "pdf"
    });
    return {
      ...converted,
      engine: "libreoffice_pdf",
      canonicalPdf
    };
  }

  private async convertOfficeDocumentToPdf(input: ConvertDocumentInput): Promise<CanonicalPdfOutput> {
    const directory = await mkdtemp(path.join(tmpdir(), "vivd-office-"));
    const userProfile = path.join(directory, "profile");
    const convertDirectory = path.join(directory, "convert");
    const inputPath = path.join(convertDirectory, sanitizeTempFilename(input.filename));
    await mkdir(userProfile, { recursive: true });
    await mkdir(convertDirectory, { recursive: true });
    await writeFile(inputPath, input.bytes);
    try {
      const pdfPath = await runOfficePdfConversion({
        command: this.environment.commands.officeConverter,
        inputPath,
        outputDirectory: convertDirectory,
        userProfile,
        timeoutMs: this.config.timeoutMs
      });
      return {
        bytes: await readFile(pdfPath),
        mimeType: "application/pdf"
      };
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }

  private async convertPdf(input: ConvertDocumentInput): Promise<ConvertDocumentOutput> {
    const directory = await mkdtemp(path.join(tmpdir(), "vivd-pdf-"));
    const inputPath = path.join(directory, sanitizeTempFilename(input.filename));
    const textPath = path.join(directory, "prepared.txt");
    const pagesPath = path.join(directory, "pages.json");
    const scriptPath = path.join(directory, "extract_pdf_pages.py");
    await writeFile(inputPath, input.bytes);
    await writeFile(scriptPath, PDF_EXTRACT_SCRIPT);
    try {
      const pdfInfoPageCount = await readPdfInfoPageCount({
        command: this.environment.commands.pdfInfo,
        inputPath,
        timeoutMs: this.config.timeoutMs
      });
      await runCommand({
        command: this.environment.commands.python,
        args: [scriptPath, inputPath, textPath, pagesPath],
        timeoutMs: this.config.timeoutMs
      });
      const text = await readFile(textPath, "utf8");
      const pages = parsePreparedPdfPages(await readFile(pagesPath, "utf8"));
      const warnings: DocumentAttachmentWarning[] = [];
      if (pdfInfoPageCount !== undefined && pdfInfoPageCount !== pages.pageCount) {
        warnings.push({
          code: "page_text_unavailable",
          message: `PDF metadata reported ${pdfInfoPageCount} pages, but text extraction returned ${pages.pageCount} pages.`
        });
      }
      return {
        engine: "platform_pdf",
        text,
        textMimeType: "text/plain",
        pageCount: pages.pageCount,
        pages,
        warnings
      };
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }

  private async convertWithMarkItDown(input: ConvertDocumentInput): Promise<ConvertDocumentOutput> {
    const directory = await mkdtemp(path.join(tmpdir(), "vivd-doc-"));
    const inputPath = path.join(directory, sanitizeTempFilename(input.filename));
    await writeFile(inputPath, input.bytes);
    try {
      const args = createConverterArgs(this.environment.generalConverterArgs, inputPath);
      const text = await runCommand({
        command: this.environment.commands.generalConverter,
        args,
        timeoutMs: this.config.timeoutMs
      });
      return {
        engine: "markitdown",
        text,
        textMimeType: "text/markdown",
        warnings: []
      };
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function createConverterArgs(configuredArgs: readonly string[], inputPath: string): string[] {
  if (configuredArgs.length === 0) {
    return [inputPath];
  }
  const hasInputPlaceholder = configuredArgs.some((arg) => arg.includes("{input}"));
  const args = configuredArgs.map((arg) => arg.replaceAll("{input}", inputPath));
  return hasInputPlaceholder ? args : [...args, inputPath];
}

function sanitizeTempFilename(filename: string): string {
  const basename = path.basename(filename).replaceAll(/[^a-zA-Z0-9._-]/gu, "_");
  return basename.length > 0 ? basename : "document";
}

function isMissingCommandError(error: unknown, command: string): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }

  const codedError = error as Error & { code?: unknown; path?: unknown };
  return (
    codedError.code === "ENOENT" &&
    (typeof codedError.path !== "string" || codedError.path === command || path.basename(codedError.path) === command)
  );
}

async function readPdfInfoPageCount(input: {
  command: string;
  inputPath: string;
  timeoutMs: number;
}): Promise<number | undefined> {
  try {
    const output = await runCommand({
      command: input.command,
      args: [input.inputPath],
      timeoutMs: input.timeoutMs
    });
    const line = output
      .split(/\r?\n/u)
      .find((candidate) => candidate.toLowerCase().startsWith("pages:"));
    const value = line?.split(":")[1]?.trim();
    const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parsePreparedPdfPages(json: string): PreparedPdfPagesArtifact {
  const parsed = JSON.parse(json) as PreparedPdfPagesArtifact;
  if (parsed.format !== "pdf" || !Array.isArray(parsed.pages)) {
    throw new Error("PDF extractor returned invalid page JSON");
  }
  return parsed;
}

function runCommand(input: {
  command: string;
  args: string[];
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Document conversion timed out after ${input.timeoutMs}ms`));
    }, input.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (isMissingCommandError(error, input.command)) {
        reject(
          new Error(
            `Document converter command '${input.command}' was not found on PATH. Install the converter or configure documents.preprocessing.`
          )
        );
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        const errorText = Buffer.concat(stderr).toString("utf8").trim();
        reject(new Error(errorText || `Document converter exited with code ${code ?? "unknown"}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

async function runOfficePdfConversion(input: {
  command: string;
  inputPath: string;
  outputDirectory: string;
  userProfile: string;
  timeoutMs: number;
}): Promise<string> {
  const direct = await runOfficeConversionAttempt({
    ...input,
    outputFormat: "pdf"
  });
  const directPdf = await findPdfOutput(input.outputDirectory);
  if (directPdf) {
    return directPdf;
  }

  const odt = await runOfficeConversionAttempt({
    ...input,
    outputFormat: "odt"
  });
  const odtPath = await findConvertedOutput(input.outputDirectory, ".odt");
  if (!odtPath) {
    throw new Error(`LibreOffice did not produce a PDF or ODT output.\n${direct}\n${odt}`.trim());
  }

  const fromOdt = await runOfficeConversionAttempt({
    ...input,
    inputPath: odtPath,
    outputFormat: "pdf"
  });
  const pdf = await findPdfOutput(input.outputDirectory);
  if (pdf) {
    return pdf;
  }
  throw new Error(`LibreOffice did not produce a PDF output.\n${direct}\n${odt}\n${fromOdt}`.trim());
}

async function runOfficeConversionAttempt(input: {
  command: string;
  inputPath: string;
  outputDirectory: string;
  userProfile: string;
  timeoutMs: number;
  outputFormat: "pdf" | "odt";
}): Promise<string> {
  const args = [
    `-env:UserInstallation=file://${input.userProfile}`,
    "--invisible",
    "--headless",
    "--norestore",
    "--convert-to",
    input.outputFormat,
    "--outdir",
    input.outputDirectory,
    input.inputPath
  ];
  try {
    return await runCommand({
      command: input.command,
      args,
      timeoutMs: input.timeoutMs,
      env: createOfficeConverterEnv(input.userProfile)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "LibreOffice conversion failed";
    throw new Error(`LibreOffice ${input.outputFormat.toUpperCase()} conversion failed: ${message}`);
  }
}

function createOfficeConverterEnv(userProfile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: userProfile,
    XDG_CONFIG_HOME: path.join(userProfile, "xdg_config"),
    XDG_CACHE_HOME: path.join(userProfile, "xdg_cache")
  };
  if (process.platform === "darwin") {
    env.TMPDIR = "/private/tmp";
    env.TEMP = "/private/tmp";
    env.TMP = "/private/tmp";
  }
  return env;
}

async function findPdfOutput(directory: string): Promise<string | undefined> {
  return findConvertedOutput(directory, ".pdf");
}

async function findConvertedOutput(
  directory: string,
  extension: ".pdf" | ".odt"
): Promise<string | undefined> {
  const entries = await readdir(directory);
  const candidates = entries
    .filter((entry) => entry.toLowerCase().endsWith(extension))
    .sort();
  for (const candidate of candidates) {
    const fullPath = path.join(directory, candidate);
    const info = await stat(fullPath);
    if (info.isFile() && info.size > 0) {
      return fullPath;
    }
  }
  return undefined;
}

const PDF_EXTRACT_SCRIPT = String.raw`
import json
import re
import sys

input_path, text_path, pages_path = sys.argv[1:4]

def word_count(text):
    return len(re.findall(r"\S+", text))

def page_record(page_number, text, warnings=None):
    value = text or ""
    return {
        "pageNumber": page_number,
        "text": value,
        "characterCount": len(value),
        "wordCount": word_count(value),
        "warnings": warnings or [],
    }

pages = []
try:
    import pdfplumber
    with pdfplumber.open(input_path) as pdf:
        for index, page in enumerate(pdf.pages, start=1):
            try:
                text = page.extract_text() or ""
                pages.append(page_record(index, text))
            except Exception as error:
                pages.append(page_record(index, "", [{
                    "code": "page_text_unavailable",
                    "message": f"Text extraction failed for page {index}: {error}",
                }]))
except Exception:
    from pypdf import PdfReader
    reader = PdfReader(input_path)
    for index, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text() or ""
            pages.append(page_record(index, text))
        except Exception as error:
            pages.append(page_record(index, "", [{
                "code": "page_text_unavailable",
                "message": f"Text extraction failed for page {index}: {error}",
            }]))

full_text = "\n\n".join(f"[Page {page['pageNumber']}]\n{page['text']}" for page in pages)
artifact = {
    "format": "pdf",
    "pageCount": len(pages),
    "pages": pages,
}

with open(text_path, "w", encoding="utf-8") as handle:
    handle.write(full_text)
with open(pages_path, "w", encoding="utf-8") as handle:
    json.dump(artifact, handle, ensure_ascii=False)
print(json.dumps({"pageCount": len(pages)}))
`;
