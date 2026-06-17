import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AppError,
  type ClientInstanceId,
  type ConversationId,
  type DocumentAttachmentStore,
  type ManagedFileId,
  type ManagedArtifactRecord,
  asManagedFileId
} from "@vivd-catalyst/core";
import { createChecksum, createPageImageObjectKey } from "./object-keys";
import type { ObjectStore } from "./object-store";
import {
  createDefaultDocumentExecutionEnvironment,
  type DocumentExecutionEnvironment
} from "./execution-environment";

export interface ViewDocumentPageInput {
  conversationId: ConversationId;
  fileId: string;
  pageNumber: number;
  dpi?: number;
}

export interface ViewDocumentPageResult {
  fileId: string;
  pageNumber: number;
  pageCount: number;
  dpi: number;
  image: {
    artifactId: ManagedArtifactRecord["id"];
    mimeType: "image/png";
    byteSize: number;
    checksum: string;
  };
}

export interface DocumentPageViewer {
  viewPage(input: ViewDocumentPageInput): Promise<ViewDocumentPageResult>;
}

export interface DocumentPageRenderServiceOptions {
  clientInstanceId: ClientInstanceId;
  store: DocumentAttachmentStore;
  objectStore: ObjectStore;
  environment?: DocumentExecutionEnvironment;
  timeoutMs: number;
}

export class DocumentPageRenderService implements DocumentPageViewer {
  private readonly clientInstanceId: ClientInstanceId;
  private readonly store: DocumentAttachmentStore;
  private readonly objectStore: ObjectStore;
  private readonly environment: DocumentExecutionEnvironment;
  private readonly timeoutMs: number;

  constructor(options: DocumentPageRenderServiceOptions) {
    this.clientInstanceId = options.clientInstanceId;
    this.store = options.store;
    this.objectStore = options.objectStore;
    this.environment = options.environment ?? createDefaultDocumentExecutionEnvironment();
    this.timeoutMs = options.timeoutMs;
  }

  async viewPage(input: ViewDocumentPageInput): Promise<ViewDocumentPageResult> {
    const pageNumber = Math.trunc(input.pageNumber);
    const dpi = normalizeDpi(input.dpi);
    const attachment = await this.store.findReadableDocumentAttachment({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId,
      fileId: asManagedFileId(input.fileId)
    });
    if (!attachment) {
      throw new AppError("NOT_FOUND", "Prepared document is not available in this conversation");
    }
    if (!attachment.pageCount) {
      throw new AppError("VALIDATION_FAILED", "Document page count is not available");
    }
    if (pageNumber < 1 || pageNumber > attachment.pageCount) {
      throw new AppError("VALIDATION_FAILED", "Requested page number is outside the document");
    }

    const existing = await this.findExistingPageImage({
      conversationId: input.conversationId,
      fileId: attachment.fileId,
      pageNumber,
      dpi,
      checksum: attachment.checksum
    });
    if (existing) {
      return {
        fileId: attachment.fileId,
        pageNumber,
        pageCount: attachment.pageCount,
        dpi,
        image: {
          artifactId: existing.id,
          mimeType: "image/png",
          byteSize: existing.byteSize,
          checksum: existing.checksum
        }
      };
    }

    const pageSource = await this.resolvePageRenderSource({
      conversationId: input.conversationId,
      fileId: attachment.fileId,
      format: attachment.format,
      filename: attachment.filename
    });
    const imageBytes = await this.renderPage({
      bytes: pageSource.bytes,
      pageNumber,
      dpi,
      filename: pageSource.filename
    });
    const checksum = createChecksum(imageBytes);
    const objectKey = createPageImageObjectKey({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId,
      fileId: attachment.fileId,
      checksum: attachment.checksum,
      pageNumber,
      dpi
    });
    await this.objectStore.putObject({
      key: objectKey,
      body: imageBytes,
      contentType: "image/png"
    });
    const artifact = await this.store.createManagedArtifact({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId,
      sourceFileId: attachment.fileId,
      kind: "document.page_image",
      objectKey,
      filename: `${attachment.filename}.page-${pageNumber}.png`,
      mimeType: "image/png",
      byteSize: imageBytes.byteLength,
      checksum,
      metadata: {
        pageNumber,
        pageCount: attachment.pageCount,
        dpi,
        sourceChecksum: attachment.checksum
      }
    });
    return {
      fileId: attachment.fileId,
      pageNumber,
      pageCount: attachment.pageCount,
      dpi,
      image: {
        artifactId: artifact.id,
        mimeType: "image/png",
        byteSize: artifact.byteSize,
        checksum: artifact.checksum
      }
    };
  }

  private async resolvePageRenderSource(input: {
    conversationId: ConversationId;
    fileId: ManagedFileId;
    format: string | undefined;
    filename: string;
  }): Promise<{ bytes: Uint8Array; filename: string }> {
    if (input.format === "pdf") {
      const file = await this.store.getManagedFile({
        clientInstanceId: this.clientInstanceId,
        fileId: input.fileId
      });
      if (!file) {
        throw new AppError("NOT_FOUND", "Managed file is not available");
      }
      return {
        bytes: await this.objectStore.getObject(file.objectKey),
        filename: input.filename
      };
    }

    const [canonicalPdf] = await this.store.listManagedArtifactsForFile({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId,
      fileId: input.fileId,
      kind: "document.canonical_pdf"
    });
    if (!canonicalPdf) {
      throw new AppError("VALIDATION_FAILED", "Document does not have a canonical PDF for visual rendering");
    }
    return {
      bytes: await this.objectStore.getObject(canonicalPdf.objectKey),
      filename: canonicalPdf.filename ?? `${input.filename}.canonical.pdf`
    };
  }

  private async findExistingPageImage(input: {
    conversationId: ConversationId;
    fileId: ManagedFileId;
    pageNumber: number;
    dpi: number;
    checksum: string;
  }): Promise<ManagedArtifactRecord | undefined> {
    const artifacts = await this.store.listManagedArtifactsForFile({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId,
      fileId: input.fileId,
      kind: "document.page_image"
    });
    return artifacts.find(
      (artifact) =>
        artifact.metadata.pageNumber === input.pageNumber &&
        artifact.metadata.dpi === input.dpi &&
        artifact.metadata.sourceChecksum === input.checksum
    );
  }

  private async renderPage(input: {
    bytes: Uint8Array;
    pageNumber: number;
    dpi: number;
    filename: string;
  }): Promise<Uint8Array> {
    const directory = await mkdtemp(path.join(tmpdir(), "vivd-page-"));
    const pdfPath = path.join(directory, sanitizeTempFilename(input.filename));
    const outputPrefix = path.join(directory, "page");
    const outputPath = `${outputPrefix}.png`;
    await writeFile(pdfPath, input.bytes);
    try {
      await runCommand({
        command: this.environment.commands.pdfRenderer,
        args: [
          "-f",
          String(input.pageNumber),
          "-l",
          String(input.pageNumber),
          "-r",
          String(input.dpi),
          "-png",
          "-singlefile",
          pdfPath,
          outputPrefix
        ],
        timeoutMs: this.timeoutMs
      });
      return readFile(outputPath);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }
}

function normalizeDpi(value: number | undefined): number {
  if (value === undefined) {
    return 160;
  }
  const dpi = Math.trunc(value);
  if (![150, 160, 200].includes(dpi)) {
    throw new AppError("VALIDATION_FAILED", "Page render DPI must be 150, 160, or 200");
  }
  return dpi;
}

function sanitizeTempFilename(filename: string): string {
  const basename = path.basename(filename).replaceAll(/[^a-zA-Z0-9._-]/gu, "_");
  return basename.length > 0 ? basename : "document.pdf";
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

function runCommand(input: {
  command: string;
  args: string[];
  timeoutMs: number;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      stdio: ["ignore", "ignore", "pipe"]
    });
    const stderr: Buffer[] = [];
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`PDF page rendering timed out after ${input.timeoutMs}ms`));
    }, input.timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (isMissingCommandError(error, input.command)) {
        reject(new Error(`PDF renderer command '${input.command}' was not found on PATH.`));
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
        reject(new Error(errorText || `PDF renderer exited with code ${code ?? "unknown"}`));
        return;
      }
      resolve();
    });
  });
}
