import {
  SKILL_FILE_MAX_BYTES as SKILL_IMPORT_FILE_MAX_BYTES,
  SKILL_MAX_BYTES as SKILL_IMPORT_MAX_BYTES,
  SKILL_MAX_FILES as SKILL_IMPORT_MAX_FILES
} from "@work-shape/catalyst-api-contract";
import JSZip from "jszip";
import { SKILL_NAME_PATTERN, parseSkillMarkdown } from "@work-shape/catalyst-core";
import {
  SKILL_ROOT_FILE_NAME,
  skillFileBlob,
  skillFileOfBytes,
  skillManifest,
  type SkillFileForm,
  type SkillFormState
} from "./skill-form-model";

// A skill brought in whole, as a public skill library ships one: a folder, or a .zip of it.
// The browser reads it; the instance never unpacks an archive. What the instance would refuse
// for its limits is refused here already, by path, in the sentences a save's refusal has; the
// instance checks every write again.

export {
  SKILL_FILE_MAX_BYTES as SKILL_IMPORT_FILE_MAX_BYTES,
  SKILL_MAX_BYTES as SKILL_IMPORT_MAX_BYTES,
  SKILL_MAX_FILES as SKILL_IMPORT_MAX_FILES
} from "@work-shape/catalyst-api-contract";
/**
 * How large an archive is read at most. A .zip of a skill within its limits is smaller: a
 * larger one is refused before it is opened.
 */
export const SKILL_IMPORT_ARCHIVE_MAX_BYTES = 2 * SKILL_IMPORT_MAX_BYTES;

/** Folders and files a folder or an archive carries that are no part of a skill. */
const SKIPPED_FOLDERS = new Set(["__MACOSX", ".git"]);
const SKIPPED_FILES = new Set([".DS_Store", ".catalyst-skill.json", ".catalyst-state.json"]);

/** The folder whose files are scripts: UTF-8 text. */
const SCRIPTS_FOLDER = "scripts";

/** One file of a folder or an archive before its bytes are read. */
export interface SkillImportEntry {
  /** Its path from the folder or archive on, with `/` between segments. */
  path: string;
  /** The size the source names: a file's size, or what an archive's entry declares. */
  size: number | undefined;
  /** The entry is a symbolic link. */
  link?: boolean;
  /** Reads the bytes. More than `limit` bytes stop the read with `SkillImportTooLarge`. */
  read(limit: number): Promise<Uint8Array>;
}

/** A read that stopped: the entry holds more bytes than it was allowed. */
export class SkillImportTooLarge extends Error {
  /** How many bytes had come when the read stopped. */
  readonly read: number;

  constructor(read: number) {
    super("The file is larger than a skill holds");
    this.name = "SkillImportTooLarge";
    this.read = read;
  }
}

/**
 * Why a folder or an archive is no skill that can be imported. The reasons the instance names
 * too carry its details, so they are told in the sentences of a save's refusal.
 */
export type SkillImportRefusal =
  | { reason: "skill_file_too_large"; path: string; limit: number; actual: number }
  | { reason: "skill_too_many_files"; limit: number; actual: number }
  | { reason: "skill_too_large"; limit: number; actual: number }
  | {
      reason: "skill_file_executable" | "skill_file_lfs_pointer" | "skill_file_not_text";
      path: string;
    }
  | { reason: "import_link"; path: string }
  | { reason: "import_archive_too_large"; limit: number; actual: number }
  | { reason: "import_archive_unreadable" }
  | { reason: "import_no_skill" }
  | { reason: "import_manifest_invalid"; message: string };

/** A folder or an archive read as a skill: the form of the skill and every file with its size. */
export interface SkillImport {
  form: SkillFormState;
  /** Every file of the folder, `SKILL.md` among them, by path, as they were read. */
  files: { path: string; bytes: number }[];
}

export type SkillImportRead =
  { ok: true; skill: SkillImport } | { ok: false; refusals: SkillImportRefusal[] };

/** The first bytes of the formats a compiled program has, as the instance reads them. */
const EXECUTABLE_MAGIC: readonly (readonly number[])[] = [
  [0x7f, 0x45, 0x4c, 0x46],
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe]
];
/** Where the first header of a PE program says its second one begins. */
const PE_HEADER_OFFSET_AT = 0x3c;
const LFS_POINTER = /^version https:\/\/git-lfs\.[a-z0-9.-]+\/spec\/v\d+\r?\n/u;

const startsWith = (bytes: Uint8Array, prefix: readonly number[]) =>
  bytes.byteLength >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);

/** Whether a file that begins with `MZ` is a PE program: a text may begin with the letters. */
function isPeProgram(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, [0x4d, 0x5a]) || bytes.byteLength < PE_HEADER_OFFSET_AT + 4) return false;
  const at = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    PE_HEADER_OFFSET_AT,
    true
  );
  return at + 4 <= bytes.byteLength && startsWith(bytes.subarray(at), [0x50, 0x45, 0, 0]);
}

function isProgram(bytes: Uint8Array): boolean {
  return EXECUTABLE_MAGIC.some((magic) => startsWith(bytes, magic)) || isPeProgram(bytes);
}

function isLfsPointer(bytes: Uint8Array): boolean {
  return LFS_POINTER.test(String.fromCharCode(...bytes.subarray(0, 128)));
}

/** A path as a skill names it: `/` between segments, nothing before the first. */
function normalPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^(?:\.?\/)+/u, "");
}

function isSkipped(path: string): boolean {
  const segments = path.split("/");
  return (
    segments.slice(0, -1).some((segment) => SKIPPED_FOLDERS.has(segment)) ||
    SKIPPED_FILES.has(segments.at(-1) ?? "")
  );
}

/**
 * The entries of a skill and the name of the folder they lie in: the one folder every entry
 * shares is stripped, where `SKILL.md` is not at the top already.
 */
function strippedEntries(entries: readonly SkillImportEntry[]): {
  entries: SkillImportEntry[];
  folder: string | undefined;
} {
  const kept = entries
    .map((entry) => ({ ...entry, path: normalPath(entry.path) }))
    .filter((entry) => entry.path !== "" && !entry.path.endsWith("/") && !isSkipped(entry.path));
  const first = kept[0]?.path.split("/")[0];
  const shared =
    first !== undefined &&
    !kept.some((entry) => entry.path === SKILL_ROOT_FILE_NAME) &&
    kept.every((entry) => entry.path.startsWith(`${first}/`));
  return shared
    ? {
        entries: kept.map((entry) => ({ ...entry, path: entry.path.slice(first.length + 1) })),
        folder: first
      }
    : { entries: kept, folder: undefined };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOf(record: Record<string, unknown>, key: string): string | undefined {
  const found = record[key];
  return typeof found === "string" ? found : undefined;
}

/**
 * The form of a skill from its `SKILL.md` and the files beside it. A `SKILL.md` without a name
 * takes it from the folder or the archive, `source`.
 */
function skillForm(
  manifest: string,
  source: string,
  files: SkillFileForm[]
): SkillFormState | { invalid: string } {
  let parsed: unknown;
  try {
    parsed = parseSkillMarkdown(
      manifest,
      SKILL_ROOT_FILE_NAME,
      `${source}/${SKILL_ROOT_FILE_NAME}`
    );
  } catch (error) {
    return { invalid: error instanceof Error ? error.message : String(error) };
  }
  const record = isRecord(parsed) ? parsed : {};
  // Without a name in the frontmatter the parser derives one from the folder's; a folder name
  // that is an address already is kept as written (pdf-tools stays pdf-tools).
  const named = /^name\s*:/mu.test(/^---\r?\n([\s\S]*?)\r?\n---/u.exec(manifest)?.[1] ?? "");
  const folder = source.split("/").pop() ?? "";
  return {
    name: !named && SKILL_NAME_PATTERN.test(folder) ? folder : (stringOf(record, "name") ?? ""),
    title: stringOf(record, "title") ?? "",
    description: stringOf(record, "description") ?? "",
    summary: stringOf(record, "summary") ?? "",
    starters: Array.isArray(record.starters) ? record.starters : [],
    frontmatter: isRecord(record.frontmatter) ? record.frontmatter : {},
    content: stringOf(record, "content") ?? "",
    files
  };
}

/**
 * Reads a folder or an archive as a skill. `source` is the name of the folder or the archive,
 * which names a skill whose `SKILL.md` does not. One folder every file shares is stripped, and
 * what a folder carries beside a skill, such as `.git/` and `__MACOSX/`, is skipped. Links and
 * what passes the limits are refused by path; sizes are checked before a byte is read, and a
 * read stops where the limits would pass.
 */
export async function readSkillImport(
  source: string,
  entries: readonly SkillImportEntry[]
): Promise<SkillImportRead> {
  const { entries: kept, folder } = strippedEntries(entries);
  const refusals: SkillImportRefusal[] = [];
  for (const entry of kept) {
    if (entry.link) refusals.push({ reason: "import_link", path: entry.path });
  }
  if (kept.length > SKILL_IMPORT_MAX_FILES) {
    refusals.push({
      reason: "skill_too_many_files",
      limit: SKILL_IMPORT_MAX_FILES,
      actual: kept.length
    });
  }
  const declared = kept.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  if (declared > SKILL_IMPORT_MAX_BYTES) {
    refusals.push({ reason: "skill_too_large", limit: SKILL_IMPORT_MAX_BYTES, actual: declared });
  }
  if (refusals.length > 0) return { ok: false, refusals };

  const read: { path: string; bytes: Uint8Array }[] = [];
  let total = 0;
  for (const entry of kept) {
    if ((entry.size ?? 0) > SKILL_IMPORT_FILE_MAX_BYTES) {
      refusals.push({
        reason: "skill_file_too_large",
        path: entry.path,
        limit: SKILL_IMPORT_FILE_MAX_BYTES,
        actual: entry.size ?? 0
      });
      continue;
    }
    const left = SKILL_IMPORT_MAX_BYTES - total;
    const limit = Math.min(SKILL_IMPORT_FILE_MAX_BYTES, left);
    try {
      const bytes = await entry.read(limit);
      total += bytes.byteLength;
      read.push({ path: entry.path, bytes });
    } catch (error) {
      if (!(error instanceof SkillImportTooLarge)) throw error;
      if (limit < SKILL_IMPORT_FILE_MAX_BYTES) {
        // The skill passes its limit: nothing further is read.
        refusals.push({
          reason: "skill_too_large",
          limit: SKILL_IMPORT_MAX_BYTES,
          actual: total + error.read
        });
        return { ok: false, refusals };
      }
      refusals.push({
        reason: "skill_file_too_large",
        path: entry.path,
        limit: SKILL_IMPORT_FILE_MAX_BYTES,
        actual: error.read
      });
    }
  }

  const files: SkillFileForm[] = [];
  let manifest: string | undefined;
  for (const { path, bytes } of read) {
    if (isProgram(bytes)) {
      refusals.push({ reason: "skill_file_executable", path });
      continue;
    }
    if (isLfsPointer(bytes)) {
      refusals.push({ reason: "skill_file_lfs_pointer", path });
      continue;
    }
    const file = skillFileOfBytes(path, bytes);
    if (
      file.text === undefined &&
      (path.startsWith(`${SCRIPTS_FOLDER}/`) || path === SKILL_ROOT_FILE_NAME)
    ) {
      refusals.push({ reason: "skill_file_not_text", path });
      continue;
    }
    if (path === SKILL_ROOT_FILE_NAME) manifest = file.text;
    else files.push(file);
  }
  if (refusals.length > 0) return { ok: false, refusals };
  if (manifest === undefined) return { ok: false, refusals: [{ reason: "import_no_skill" }] };

  const form = skillForm(manifest, folder ?? source, files);
  if ("invalid" in form) {
    return { ok: false, refusals: [{ reason: "import_manifest_invalid", message: form.invalid }] };
  }
  return {
    ok: true,
    skill: {
      form,
      files: read.map(({ path, bytes }) => ({ path, bytes: bytes.byteLength }))
    }
  };
}

/** The name a folder or an archive is known by: an archive's without its extension. */
export function skillImportSourceName(name: string): string {
  return name.replace(/\.zip$/iu, "");
}

/** The entries of files a folder dialog chose, each with its path from the folder on. */
export function folderEntries(files: readonly File[]): SkillImportEntry[] {
  return files.map((file) => fileEntry(file.webkitRelativePath || file.name, file));
}

/** One file of a folder as an entry: its size is known before it is read. */
function fileEntry(path: string, file: File): SkillImportEntry {
  return {
    path,
    size: file.size,
    read: async (limit) => {
      if (file.size > limit) throw new SkillImportTooLarge(file.size);
      return new Uint8Array(await file.arrayBuffer());
    }
  };
}

/** What a person handed over: one .zip, or a folder (or loose files) with its name. */
export type SkillImportSource =
  { kind: "zip"; file: File } | { kind: "folder"; name: string; entries: SkillImportEntry[] };

/** The source of files a dialog chose: a single .zip is an archive, anything else a folder. */
export function chosenSource(files: readonly File[]): SkillImportSource {
  const [only] = files;
  if (files.length === 1 && only && /\.zip$/iu.test(only.name)) return { kind: "zip", file: only };
  const top = only?.webkitRelativePath.split("/")[0] ?? "";
  return { kind: "folder", name: top, entries: folderEntries(files) };
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
 * The source a drop holds. The drag's items are taken at once, as they are gone once the drop
 * event ends; the folders are walked after, and the walk stops once more files came than a
 * skill holds.
 */
export function droppedSource(data: DataTransfer): Promise<SkillImportSource> {
  const roots = [...data.items]
    .map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is FileSystemEntry => entry !== null);
  const files = [...data.files];
  return (async () => {
    if (roots.length === 0) return chosenSource(files);
    const [root] = roots;
    if (roots.length === 1 && root && isFileEntry(root) && /\.zip$/iu.test(root.name)) {
      return { kind: "zip", file: await fileOf(root) };
    }
    const found: { path: string; file: File }[] = [];
    const walk = async (entry: FileSystemEntry): Promise<void> => {
      if (found.length > SKILL_IMPORT_MAX_FILES) return;
      if (isFileEntry(entry)) {
        found.push({ path: entry.fullPath.replace(/^\//u, ""), file: await fileOf(entry) });
      } else if (isFolderEntry(entry)) {
        for (const child of await childrenOf(entry)) await walk(child);
      }
    };
    for (const entry of roots) await walk(entry);
    return {
      kind: "folder",
      name: roots.length === 1 && root?.isDirectory ? root.name : "",
      entries: found.map(({ path, file }) => fileEntry(path, file))
    };
  })();
}

/** Reads what a person handed over as a skill. */
export async function readSkillSource(source: SkillImportSource): Promise<SkillImportRead> {
  if (source.kind === "folder") return readSkillImport(source.name, source.entries);
  const opened = await zipEntries(source.file);
  return opened.ok
    ? readSkillImport(skillImportSourceName(source.file.name), opened.entries)
    : { ok: false, refusals: [opened.refusal] };
}

/** The part of JSZip's stream that a capped read uses. Its typings leave it out. */
interface ZipStream {
  on(event: "data", listener: (chunk: Uint8Array) => void): ZipStream;
  on(event: "end", listener: () => void): ZipStream;
  on(event: "error", listener: (error: Error) => void): ZipStream;
  pause(): ZipStream;
  resume(): ZipStream;
}

/** An archive's entry with the stream JSZip has and its typings leave out. */
function streams(object: object): object is { internalStream(type: "uint8array"): ZipStream } {
  return "internalStream" in object && typeof object.internalStream === "function";
}

/** Inflates one entry of an archive, and stops once more than `limit` bytes came. */
function readZipEntry(object: JSZip.JSZipObject, limit: number): Promise<Uint8Array> {
  if (!streams(object)) return object.async("uint8array");
  const stream = object.internalStream("uint8array");
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let length = 0;
    let stopped = false;
    stream
      .on("data", (chunk) => {
        if (stopped) return;
        length += chunk.byteLength;
        if (length > limit) {
          stopped = true;
          stream.pause();
          reject(new SkillImportTooLarge(length));
          return;
        }
        chunks.push(chunk);
      })
      .on("error", (error) => {
        if (!stopped) reject(error);
      })
      .on("end", () => {
        if (stopped) return;
        const bytes = new Uint8Array(length);
        let at = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, at);
          at += chunk.byteLength;
        }
        resolve(bytes);
      })
      .resume();
  });
}

/** The size an archive's entry declares, read before it is inflated. */
function declaredSize(object: JSZip.JSZipObject): number | undefined {
  const data: unknown = "_data" in object ? object._data : undefined;
  return isRecord(data) && typeof data.uncompressedSize === "number"
    ? data.uncompressedSize
    : undefined;
}

/** The mode of a symbolic link among a file's Unix permissions. */
const UNIX_LINK = 0o120000;
const UNIX_TYPE = 0o170000;

/**
 * The entries of a .zip, or why it cannot be read: it is too large to open, or no archive.
 * Nothing is inflated here.
 */
export async function zipEntries(
  archive: Blob
): Promise<{ ok: true; entries: SkillImportEntry[] } | { ok: false; refusal: SkillImportRefusal }> {
  if (archive.size > SKILL_IMPORT_ARCHIVE_MAX_BYTES) {
    return {
      ok: false,
      refusal: {
        reason: "import_archive_too_large",
        limit: SKILL_IMPORT_ARCHIVE_MAX_BYTES,
        actual: archive.size
      }
    };
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await archive.arrayBuffer());
  } catch {
    return { ok: false, refusal: { reason: "import_archive_unreadable" } };
  }
  const entries: SkillImportEntry[] = [];
  zip.forEach((path, object) => {
    if (object.dir) return;
    const mode = typeof object.unixPermissions === "number" ? object.unixPermissions : 0;
    entries.push({
      path,
      size: declaredSize(object),
      link: (mode & UNIX_TYPE) === UNIX_LINK,
      read: (limit) => readZipEntry(object, limit)
    });
  });
  return { ok: true, entries };
}

/** What changes where a skill's whole folder is replaced: files by path, each with its size. */
export interface SkillFolderDiff {
  added: { path: string; bytes: number }[];
  /** A file whose content differs, by its SHA-256, with its size before and after. */
  changed: { path: string; bytes: number; before: number }[];
  removed: { path: string; bytes: number }[];
  /** How many files stay as they are. */
  unchanged: number;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The SHA-256 of a file: of its content where the page holds it, else the stored one's. */
async function hashOf(file: SkillFileForm): Promise<string | undefined> {
  if (file.text === undefined && file.base64 === undefined) return file.sha256;
  const bytes = await skillFileBlob(file).arrayBuffer();
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

/** `SKILL.md` and every other file of a form, as a save of the folder writes them. */
function folderFiles(form: SkillFormState): SkillFileForm[] {
  const manifest = skillManifest(form);
  return [
    {
      path: SKILL_ROOT_FILE_NAME,
      bytes: new TextEncoder().encode(manifest).byteLength,
      text: manifest
    },
    ...form.files
  ];
}

/**
 * What replacing the folder `before` with `after` changes: files added, changed by their
 * SHA-256, and removed. `SKILL.md` is compared as a save writes it on both sides.
 */
export async function diffSkillFolders(
  before: SkillFormState,
  after: SkillFormState
): Promise<SkillFolderDiff> {
  const old = new Map(folderFiles(before).map((file) => [file.path, file]));
  const diff: SkillFolderDiff = { added: [], changed: [], removed: [], unchanged: 0 };
  const byPath = (left: { path: string }, right: { path: string }) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  for (const file of folderFiles(after)) {
    const was = old.get(file.path);
    old.delete(file.path);
    if (was === undefined) {
      diff.added.push({ path: file.path, bytes: file.bytes });
    } else if ((await hashOf(was)) !== (await hashOf(file))) {
      diff.changed.push({ path: file.path, bytes: file.bytes, before: was.bytes });
    } else {
      diff.unchanged += 1;
    }
  }
  diff.removed = [...old.values()].map((file) => ({ path: file.path, bytes: file.bytes }));
  diff.added.sort(byPath);
  diff.changed.sort(byPath);
  diff.removed.sort(byPath);
  return diff;
}

/**
 * A folder or an archive handed over for the skill it would replace: the import found that
 * name taken, and the skill's page asks about the replace. It is kept here for the one step to
 * that page, which takes it.
 */
let replaceRequested: { name: string; skill: SkillImport } | undefined;

/** Asks the page of the skill `name` to offer replacing its files with `skill`'s. */
export function requestSkillReplace(name: string, skill: SkillImport): void {
  replaceRequested = { name, skill };
}

/** The folder the page of the skill `name` was asked to replace its files with. */
export function requestedSkillReplace(name: string | undefined): SkillImport | undefined {
  return name !== undefined && replaceRequested?.name === name ? replaceRequested.skill : undefined;
}

/** Forgets the request: the page took it. */
export function clearSkillReplaceRequest(): void {
  replaceRequested = undefined;
}
