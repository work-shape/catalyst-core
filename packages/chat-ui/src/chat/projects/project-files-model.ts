import JSZip from "jszip";
import type {
  LocaleCode,
  ProjectFilesView,
  ProjectFileView
} from "@work-shape/catalyst-api-client";

// What a person hands a project's folder: picked files, a picked folder, a drop, or a .zip that
// is unpacked into a folder of its name. Sizes are checked against the project's caps before
// anything is read or sent.

/** A file to upload with the path it takes in the project's folder. */
export interface ProjectUpload {
  path: string;
  /** A .zip's entries carry the size counted while the archive was unpacked. */
  size: number;
  read(): Promise<File>;
}

export type ProjectFileLimitsView = ProjectFilesView["limits"];
export type ProjectFileUsageView = ProjectFilesView["usage"];

/** Why a set of uploads does not fit the project, with the first file that does not. */
export type ProjectUploadRefusal =
  | { limit: "files"; count: number; max: number }
  | { limit: "file_bytes"; path: string; size: number; max: number }
  | { limit: "project_bytes"; bytes: number; max: number }
  | { limit: "unreadable"; path: string }
  /** A .zip with an entry that climbs out of its folder with `..`. */
  | { limit: "unsafe_path"; path: string };

const SKIPPED_FOLDERS = new Set(["__MACOSX"]);
const SKIPPED_FILES = new Set([".DS_Store"]);

/** Folders and files a system adds beside what a person means to hand over. */
export function isSkippedUploadPath(path: string): boolean {
  const segments = path.split("/").filter((segment) => segment !== "");
  const name = segments.at(-1);
  return (
    name === undefined ||
    SKIPPED_FILES.has(name) ||
    segments.some((segment) => SKIPPED_FOLDERS.has(segment))
  );
}

/** The folder a .zip is unpacked into: its name without `.zip`. */
export function zipFolderName(name: string): string {
  return name.replace(/\.zip$/iu, "") || name;
}

function isZipName(name: string): boolean {
  return /\.zip$/iu.test(name);
}

/**
 * Whether uploads fit the project beside what it holds. A path that is taken replaces its file:
 * it adds no file, and its bytes count as a new version, since every kept version counts.
 */
export function checkProjectUploads(
  uploads: readonly Pick<ProjectUpload, "path" | "size">[],
  current: {
    usage: ProjectFileUsageView;
    limits: ProjectFileLimitsView;
    paths: ReadonlySet<string>;
  }
): ProjectUploadRefusal | undefined {
  const { limits, usage, paths } = current;
  for (const upload of uploads) {
    if (upload.size > limits.maxFileBytes) {
      return {
        limit: "file_bytes",
        path: upload.path,
        size: upload.size,
        max: limits.maxFileBytes
      };
    }
  }
  const added = new Set(uploads.map((upload) => upload.path).filter((path) => !paths.has(path)));
  const count = usage.files + added.size;
  if (count > limits.maxFiles) return { limit: "files", count, max: limits.maxFiles };
  const bytes = uploads.reduce((sum, upload) => sum + upload.size, usage.bytes);
  if (bytes > limits.maxProjectBytes) {
    return { limit: "project_bytes", bytes, max: limits.maxProjectBytes };
  }
  return undefined;
}

/** Picked files at their own name, or at their place in a picked folder. */
export function pickedUploads(files: readonly File[]): ProjectUpload[] {
  return files.map((file) => ({
    path: file.webkitRelativePath || file.name,
    size: file.size,
    read: () => Promise.resolve(file)
  }));
}

function isFileEntry(entry: FileSystemEntry): entry is FileSystemFileEntry {
  return entry.isFile;
}

function isFolderEntry(entry: FileSystemEntry): entry is FileSystemDirectoryEntry {
  return entry.isDirectory;
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function childrenOf(folder: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = folder.createReader();
  const all: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    // A reader answers a folder in batches, and an empty one at its end.
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) return resolve(all);
        all.push(...batch);
        next();
      }, reject);
    next();
  });
}

/**
 * What a drop holds, folders walked with their paths. The drag's items are taken at once, as
 * they are gone once the drop event ends.
 */
export function droppedUploads(data: DataTransfer): Promise<ProjectUpload[]> {
  const roots = [...data.items]
    .map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is FileSystemEntry => entry !== null);
  const files = [...data.files];
  return (async () => {
    if (roots.length === 0) return pickedUploads(files);
    const found: ProjectUpload[] = [];
    const walk = async (entry: FileSystemEntry): Promise<void> => {
      if (isFileEntry(entry)) {
        const file = await fileOf(entry);
        found.push({
          path: entry.fullPath.replace(/^\/+/u, ""),
          size: file.size,
          read: () => Promise.resolve(file)
        });
      } else if (isFolderEntry(entry)) {
        for (const child of await childrenOf(entry)) await walk(child);
      }
    };
    for (const entry of roots) await walk(entry);
    return found;
  })();
}

/** What a project may still take, to stop an archive at while it is unpacked. */
export interface ProjectUploadCaps {
  maxFileBytes: number;
  maxProjectBytes: number;
  /** What the project holds already, every kept version counted. */
  usedBytes: number;
}

/** The caps a project's files view sets, for `expandProjectUploads`. */
export function projectUploadCaps(
  files: Pick<ProjectFilesView, "limits" | "usage">
): ProjectUploadCaps {
  return {
    maxFileBytes: files.limits.maxFileBytes,
    maxProjectBytes: files.limits.maxProjectBytes,
    usedBytes: files.usage.bytes
  };
}

/** Whether an archive's entry name climbs out of the folder it is unpacked into. */
function climbsOut(name: string): boolean {
  return name.split(/[/\\]/u).some((segment) => segment === "..");
}

/** The library's stream of an entry's content, which its typings leave out. */
interface InflatingEntry {
  internalStream(type: "uint8array"): InflatingStream;
}
interface InflatingStream {
  on(event: "data", handler: (chunk: Uint8Array) => void): InflatingStream;
  on(event: "error", handler: (error: unknown) => void): InflatingStream;
  on(event: "end", handler: () => void): InflatingStream;
  pause(): void;
  resume(): void;
}

function inflates(object: JSZip.JSZipObject): object is JSZip.JSZipObject & InflatingEntry {
  return "internalStream" in object && typeof object.internalStream === "function";
}

/** The name an entry has in the archive, which the library lists resolved of `..`. */
function writtenName(object: JSZip.JSZipObject, listed: string): string {
  return "unsafeOriginalName" in object && typeof object.unsafeOriginalName === "string"
    ? object.unsafeOriginalName
    : listed;
}

/**
 * The real size of an entry, counted while it is inflated and not kept. It stops as soon as
 * the count passes `stopAbove`, as an archive's declared sizes are only what it says.
 */
function inflatedSize(object: JSZip.JSZipObject, stopAbove: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let size = 0;
    if (!inflates(object)) {
      reject(new Error("The archive library cannot stream an entry."));
      return;
    }
    const stream = object.internalStream("uint8array");
    stream
      .on("data", (chunk: Uint8Array) => {
        size += chunk.byteLength;
        if (size > stopAbove) {
          stream.pause();
          resolve(size);
        }
      })
      .on("error", reject)
      .on("end", () => resolve(size))
      .resume();
  });
}

/**
 * Uploads with each .zip unpacked into a folder of its name beside it, the archive itself left
 * out. An entry is inflated once to count its real size, stopping at the caps, so the sizes
 * returned are the real ones whatever the archive declares and nothing is sent before they are
 * known. An entry that climbs out of the folder with `..` refuses the archive. System files are
 * left out.
 */
export async function expandProjectUploads(
  uploads: readonly ProjectUpload[],
  caps: ProjectUploadCaps
): Promise<{ ok: true; uploads: ProjectUpload[] } | { ok: false; refusal: ProjectUploadRefusal }> {
  const expanded: ProjectUpload[] = [];
  let bytes = caps.usedBytes;
  for (const upload of uploads) {
    if (isSkippedUploadPath(upload.path)) continue;
    if (!isZipName(upload.path)) {
      bytes += upload.size;
      expanded.push(upload);
      continue;
    }
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(await (await upload.read()).arrayBuffer());
    } catch {
      return { ok: false, refusal: { limit: "unreadable", path: upload.path } };
    }
    const folder = zipFolderName(upload.path);
    const entries: { path: string; name: string; object: JSZip.JSZipObject }[] = [];
    let unsafe = false;
    zip.forEach((entryPath, object) => {
      if (object.dir) return;
      // The library resolves `..` in the name it lists and keeps the name as the archive wrote it.
      if (climbsOut(writtenName(object, entryPath))) unsafe = true;
      if (isSkippedUploadPath(entryPath)) return;
      const path = `${folder}/${entryPath.replace(/^\/+/u, "")}`;
      entries.push({ path, name: path.slice(path.lastIndexOf("/") + 1), object });
    });
    if (unsafe) return { ok: false, refusal: { limit: "unsafe_path", path: upload.path } };
    for (const { path, name, object } of entries) {
      let size: number;
      try {
        size = await inflatedSize(
          object,
          Math.min(caps.maxFileBytes, caps.maxProjectBytes - bytes)
        );
      } catch {
        return { ok: false, refusal: { limit: "unreadable", path: upload.path } };
      }
      if (size > caps.maxFileBytes) {
        return {
          ok: false,
          refusal: { limit: "file_bytes", path, size, max: caps.maxFileBytes }
        };
      }
      bytes += size;
      if (bytes > caps.maxProjectBytes) {
        return {
          ok: false,
          refusal: { limit: "project_bytes", bytes, max: caps.maxProjectBytes }
        };
      }
      expanded.push({
        path,
        size,
        read: async () => new File([await object.async("blob")], name)
      });
    }
  }
  return { ok: true, uploads: expanded };
}

/** A size in bytes as a person reads it: bytes, kilobytes, megabytes or gigabytes. */
export function formatProjectBytes(bytes: number, locale: LocaleCode): string {
  const [amount, unit] =
    bytes < 1_000
      ? [bytes, "byte"]
      : bytes < 1_000_000
        ? [bytes / 1_000, "kilobyte"]
        : bytes < 1_000_000_000
          ? [bytes / 1_000_000, "megabyte"]
          : [bytes / 1_000_000_000, "gigabyte"];
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    maximumFractionDigits: 1
  }).format(amount);
}

/** The name of a file: the last part of its path. */
export function projectFileName(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** The folder a path lies in, ending in `/`; `""` at the top level. */
export function projectParentFolder(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  return trimmed.slice(0, trimmed.lastIndexOf("/") + 1);
}

/**
 * The folders of a project, each ending in `/`, that a file or folder may be moved into: the
 * top level is `""`. A folder never goes into itself or below itself.
 */
export function projectMoveTargets(paths: readonly string[], moving: string): string[] {
  const folders = new Set<string>([""]);
  for (const path of paths) {
    const segments = path.split("/").slice(0, -1);
    segments.forEach((_, index) => folders.add(`${segments.slice(0, index + 1).join("/")}/`));
  }
  return [...folders]
    .filter((folder) => !(moving.endsWith("/") && folder.startsWith(moving)))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

/** Where a file or folder lies once it is put into `toFolder`; a folder's path ends in `/`. */
export function projectPathInFolder(path: string, toFolder: string): string {
  const name = projectFileName(path);
  return `${toFolder}${name}${path.endsWith("/") ? "/" : ""}`;
}

/** How a file's content is shown: as text, in an image or PDF viewer, or not at all. */
export type ProjectFilePreviewKind = "text" | "image" | "pdf" | "none";

const TEXT_EXTENSIONS = new Set([
  "md",
  "markdown",
  "txt",
  "csv",
  "json",
  "yaml",
  "yml",
  "xml",
  "log"
]);

export function projectFilePreviewKind(
  file: Pick<ProjectFileView, "path" | "mimeType">
): ProjectFilePreviewKind {
  const type = file.mimeType.toLowerCase();
  const extension = file.path.slice(file.path.lastIndexOf(".") + 1).toLowerCase();
  if (type === "application/pdf" || extension === "pdf") return "pdf";
  if (type.startsWith("image/") && type !== "image/svg+xml") return "image";
  if (type.startsWith("text/") || type === "application/json" || TEXT_EXTENSIONS.has(extension)) {
    return type === "text/html" ? "none" : "text";
  }
  return "none";
}

/** A file shows as text up to this size; a larger one only downloads. */
export const PROJECT_FILE_TEXT_PREVIEW_MAX_BYTES = 1_000_000;

/** The project paths of uploads that are taken, with the version each replaces. */
export function takenUploadPaths(
  uploads: readonly Pick<ProjectUpload, "path">[],
  files: readonly Pick<ProjectFileView, "path" | "version">[]
): Map<string, number> {
  const versions = new Map(files.map((file) => [file.path, file.version]));
  const taken = new Map<string, number>();
  for (const upload of uploads) {
    const version = versions.get(upload.path);
    if (version !== undefined) taken.set(upload.path, version);
  }
  return taken;
}

/** Runs `run` on each item, at most `limit` at a time. */
export async function runLimited<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
