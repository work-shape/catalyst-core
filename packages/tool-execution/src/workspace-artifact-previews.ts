import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, isAbsolute, join, parse } from "node:path";
import { promisify } from "node:util";
import type {
  ClientInstanceId,
  ConversationId,
  ExecutionWorkspaceId,
  ManagedArtifactImagePagesPreview,
  ManagedArtifactPreviewMetadata,
  ManagedArtifactRecord,
  PlatformStore,
  WorkspaceCommandId
} from "@vivd-catalyst/core";
import type { WorkspaceFileByteStore } from "./workspace-file-bytes";

const execFileAsync = promisify(execFile);
const DEFAULT_PREVIEW_TIMEOUT_MS = 60_000;
const DEFAULT_PREVIEW_DPI = 144;
const DEFAULT_MAX_PREVIEW_PAGES = 80;
const CODEX_RUNTIME_BIN = ".cache/codex-runtimes/codex-primary-runtime/dependencies/bin";

export type PreviewableOfficeArtifactKind = "document" | "presentation";

export interface WorkspaceArtifactPreviewImage {
  bytes: Uint8Array;
  filename: string;
  mimeType: "image/png";
  pageNumber?: number;
  slideNumber?: number;
}

export interface WorkspaceArtifactPreviewGeneratorInput {
  sourcePath: string;
  filename: string;
  mimeType?: string;
  kind: string;
  previewKind: PreviewableOfficeArtifactKind;
}

export interface WorkspaceArtifactPreviewGenerator {
  generatePreviewImages(
    input: WorkspaceArtifactPreviewGeneratorInput
  ): Promise<WorkspaceArtifactPreviewImage[]>;
}

export type WorkspaceArtifactPreviewStore = Pick<PlatformStore, "createManagedArtifact">;

export interface CreateWorkspaceArtifactPreviewMetadataInput {
  artifactKind: string;
  artifactMimeType?: string;
  clientInstanceId: ClientInstanceId;
  commandId: WorkspaceCommandId;
  conversationId: ConversationId;
  filename: string;
  generator?: WorkspaceArtifactPreviewGenerator;
  sourcePath: string;
  store: WorkspaceArtifactPreviewStore;
  workspaceId: ExecutionWorkspaceId;
  workspacePath: string;
  byteStore: WorkspaceFileByteStore;
}

export class LibreOfficeArtifactPreviewGenerator implements WorkspaceArtifactPreviewGenerator {
  private readonly maxPages: number;
  private readonly pdfToPpmPath: string;
  private readonly previewDpi: number;
  private readonly sofficePath: string;
  private readonly tempRootDirectory: string;
  private readonly timeoutMs: number;

  constructor(options: {
    maxPages?: number;
    pdfToPpmPath?: string;
    previewDpi?: number;
    sofficePath?: string;
    tempRootDirectory?: string;
    timeoutMs?: number;
  } = {}) {
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PREVIEW_PAGES;
    this.pdfToPpmPath = options.pdfToPpmPath ?? "pdftoppm";
    this.previewDpi = options.previewDpi ?? DEFAULT_PREVIEW_DPI;
    this.sofficePath = options.sofficePath ?? "soffice";
    this.tempRootDirectory = options.tempRootDirectory ?? tmpdir();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PREVIEW_TIMEOUT_MS;
  }

  async generatePreviewImages(
    input: WorkspaceArtifactPreviewGeneratorInput
  ): Promise<WorkspaceArtifactPreviewImage[]> {
    const tempDirectory = await mkdtemp(join(this.tempRootDirectory, "catalyst-artifact-preview-"));
    try {
      const pdfDirectory = join(tempDirectory, "pdf");
      const imageDirectory = join(tempDirectory, "images");
      await mkdir(pdfDirectory, { recursive: true });
      await mkdir(imageDirectory, { recursive: true });

      const sofficePath = await resolveExecutablePath(this.sofficePath, ["soffice", "libreoffice"]);
      const pdfToPpmPath = await resolveExecutablePath(this.pdfToPpmPath, ["pdftoppm"]);

      await execFileAsync(
        sofficePath,
        [
          "--headless",
          "--nologo",
          "--nofirststartwizard",
          "--nolockcheck",
          "--nodefault",
          "--convert-to",
          "pdf",
          "--outdir",
          pdfDirectory,
          input.sourcePath
        ],
        { timeout: this.timeoutMs }
      );

      const pdfPath = await firstFileWithExtension(pdfDirectory, ".pdf");
      if (!pdfPath) {
        return [];
      }

      await execFileAsync(
        pdfToPpmPath,
        [
          "-png",
          "-r",
          String(this.previewDpi),
          "-f",
          "1",
          "-l",
          String(this.maxPages),
          pdfPath,
          join(imageDirectory, "page")
        ],
        { timeout: this.timeoutMs }
      );

      const pagePaths = await numberedPngPaths(imageDirectory);
      const sourceName = parse(input.filename).name || "artifact";
      const label = input.previewKind === "presentation" ? "slide" : "page";
      const images: WorkspaceArtifactPreviewImage[] = [];
      for (const [index, pagePath] of pagePaths.entries()) {
        const number = index + 1;
        images.push({
          bytes: await readFile(pagePath),
          filename: `${sourceName}-${label}-${number}.png`,
          mimeType: "image/png",
          ...(input.previewKind === "presentation" ? { slideNumber: number } : { pageNumber: number })
        });
      }
      return images;
    } catch {
      return [];
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }
}

export function detectWorkspaceArtifactPreviewKind(input: {
  filename?: string;
  kind?: string;
  mimeType?: string;
}): PreviewableOfficeArtifactKind | undefined {
  const descriptor = `${input.mimeType ?? ""} ${input.kind ?? ""} ${input.filename ?? ""}`.toLowerCase();
  if (isOfficePresentation(descriptor)) {
    return "presentation";
  }
  if (isOfficeDocument(descriptor)) {
    return "document";
  }
  return undefined;
}

export async function createWorkspaceArtifactPreviewMetadata(
  input: CreateWorkspaceArtifactPreviewMetadataInput
): Promise<ManagedArtifactPreviewMetadata | undefined> {
  const previewKind = detectWorkspaceArtifactPreviewKind({
    filename: input.filename,
    kind: input.artifactKind,
    mimeType: input.artifactMimeType
  });
  if (!previewKind || !input.generator) {
    return undefined;
  }

  try {
    const images = await input.generator.generatePreviewImages({
      sourcePath: input.sourcePath,
      filename: input.filename,
      kind: input.artifactKind,
      previewKind,
      ...(input.artifactMimeType ? { mimeType: input.artifactMimeType } : {})
    });
    if (images.length === 0) {
      return undefined;
    }

    const pages = [];
    for (const [index, image] of images.entries()) {
      const checksum = checksumBytes(image.bytes);
      const objectPath = previewObjectPath(input.workspacePath, image.filename, index);
      const stored = await input.byteStore.putWorkspaceFile({
        clientInstanceId: input.clientInstanceId,
        conversationId: input.conversationId,
        workspaceId: input.workspaceId,
        commandId: input.commandId,
        path: objectPath,
        bytes: image.bytes,
        checksum,
        mimeType: image.mimeType
      });
      const artifact = await input.store.createManagedArtifact({
        clientInstanceId: input.clientInstanceId,
        conversationId: input.conversationId,
        kind: previewKind === "presentation" ? "presentation.preview_slide_image" : "document.preview_page_image",
        objectKey: stored.objectKey,
        filename: image.filename,
        mimeType: image.mimeType,
        byteSize: image.bytes.byteLength,
        checksum,
        metadata: {
          source: "execution_workspace",
          workspaceId: input.workspaceId,
          workspacePath: input.workspacePath,
          commandId: input.commandId,
          previewRole: previewKind === "presentation" ? "slide_image" : "page_image",
          ...(image.pageNumber ? { pageNumber: image.pageNumber } : {}),
          ...(image.slideNumber ? { slideNumber: image.slideNumber } : {})
        }
      });
      pages.push(previewPageRef(artifact, image));
    }

    const preview: ManagedArtifactImagePagesPreview = {
      type: "image_pages",
      format: "png",
      pages
    };
    return { preview };
  } catch {
    return undefined;
  }
}

function previewPageRef(
  artifact: ManagedArtifactRecord,
  image: WorkspaceArtifactPreviewImage
): ManagedArtifactImagePagesPreview["pages"][number] {
  return {
    artifactId: artifact.id,
    kind: artifact.kind,
    mimeType: "image/png",
    ...(artifact.filename ? { filename: artifact.filename } : {}),
    ...(image.pageNumber ? { pageNumber: image.pageNumber } : {}),
    ...(image.slideNumber ? { slideNumber: image.slideNumber } : {})
  };
}

async function firstFileWithExtension(directory: string, extension: string): Promise<string | undefined> {
  const entries = await readdir(directory);
  const matches = entries
    .filter((entry) => entry.toLowerCase().endsWith(extension))
    .sort((left, right) => left.localeCompare(right));
  return matches[0] ? join(directory, matches[0]) : undefined;
}

async function numberedPngPaths(directory: string): Promise<string[]> {
  const entries = await readdir(directory);
  const numbered = await Promise.all(
    entries
      .filter((entry) => entry.toLowerCase().endsWith(".png"))
      .map(async (entry) => {
        const path = join(directory, entry);
        const file = await stat(path);
        const match = /-(\d+)\.png$/iu.exec(entry);
        return file.isFile() ? { number: match ? Number(match[1]) : 0, path } : undefined;
      })
  );
  return numbered
    .flatMap((entry) => (entry ? [entry] : []))
    .sort((left, right) => left.number - right.number || left.path.localeCompare(right.path))
    .map((entry) => entry.path);
}

function previewObjectPath(workspacePath: string, filename: string, index: number): string {
  const originalName = basename(workspacePath).replaceAll(/[^a-z0-9_.-]/giu, "_") || "artifact";
  const safeFilename = filename.replaceAll(/[^a-z0-9_.-]/giu, "_") || `page-${index + 1}.png`;
  return `.artifact-previews/${originalName}/${safeFilename}`;
}

function checksumBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function resolveExecutablePath(command: string, fallbackNames: string[]): Promise<string> {
  for (const candidate of executablePathCandidates(command, fallbackNames)) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep looking; the final execFile call should surface a concrete failure if none are found.
    }
  }
  return command;
}

function executablePathCandidates(command: string, fallbackNames: string[]): string[] {
  if (isPathLikeCommand(command)) {
    return [command];
  }
  const pathCandidates = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, command));
  return uniqueStrings([
    ...pathCandidates,
    ...knownBinaryDirectories().flatMap((directory) =>
      uniqueStrings([command, ...fallbackNames]).map((name) => join(directory, name))
    )
  ]);
}

function knownBinaryDirectories(): string[] {
  return [
    process.env.HOME ? join(process.env.HOME, CODEX_RUNTIME_BIN) : undefined,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/Applications/LibreOffice.app/Contents/MacOS"
  ].flatMap((directory) => (directory ? [directory] : []));
}

function isPathLikeCommand(command: string): boolean {
  return isAbsolute(command) || command.includes("/") || command.includes("\\");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isOfficePresentation(descriptor: string): boolean {
  return (
    descriptor.includes("presentationml") ||
    descriptor.includes("powerpoint") ||
    hasExtension(descriptor, ["pptx", "ppt", "pptm", "odp"])
  );
}

function isOfficeDocument(descriptor: string): boolean {
  return (
    descriptor.includes("wordprocessingml") ||
    descriptor.includes("msword") ||
    descriptor.includes("opendocument.text") ||
    hasExtension(descriptor, ["docx", "doc", "odt", "rtf"])
  );
}

function hasExtension(value: string, extensions: string[]): boolean {
  return extensions.some((extension) => new RegExp(`\\.${escapeRegExp(extension)}(?:\\s|$)`, "iu").test(value));
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
