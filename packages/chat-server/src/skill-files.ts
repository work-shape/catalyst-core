import {
  formatSkillMarkdown,
  parseSkillManifest,
  skillConfigSchema,
  skillFileEntrySchema,
  skillResourceMediaTypeForPath,
  SkillMarkdownError,
  type SkillConfig,
  type SkillFileEntry
} from "@vivd-catalyst/config-schema";
import { z } from "zod";
import {
  AppError,
  fileSetContentType,
  fileSetPathIssue,
  type FileSet,
  type JsonObject
} from "@vivd-catalyst/core";

// A skill as a folder of files: `SKILL.md`, and files below `references/`, `scripts/` and
// `assets/`. The config of a skill stays what it was and stays the one place its text is
// read from: the instructions of `SKILL.md` and the text resources. Every other file, such as
// a script, a PDF or an image, is kept in the file set of the revision, and the config names
// it in an index (`files`) without its content. So a skill that is text alone has the config
// it always had and needs no store of files, and a write that sends a config alone leaves the
// other files of the skill where they are.

/** The file of a skill's folder that holds its instructions. */
export const SKILL_MANIFEST_FILE = "SKILL.md";
/** The folders of a skill below which its files lie. */
const SKILL_FOLDERS = ["references", "scripts", "assets"] as const;
/** The folder whose files a skill runs: each is UTF-8 text. */
const SKILL_SCRIPTS_FOLDER = "scripts";

/** How large one file of a skill is at most, in bytes. */
const SKILL_FILE_MAX_BYTES = 2 * 1024 * 1024;
/** How many files one skill holds at most. */
const SKILL_MAX_FILES = 500;
/** How large the files of one skill are at most together, in bytes: what one write carries. */
const SKILL_MAX_BYTES = 8 * 1024 * 1024;

type SkillFileRefusal =
  | "skill_manifest_missing"
  | "skill_manifest_invalid"
  | "skill_path_invalid"
  | "skill_path_duplicate"
  | "skill_file_outside_folders"
  | "skill_file_too_large"
  | "skill_too_many_files"
  | "skill_too_large"
  | "skill_file_executable"
  | "skill_file_lfs_pointer"
  | "skill_script_not_text";

function refusal(reason: SkillFileRefusal, message: string, details: JsonObject = {}): AppError {
  return new AppError("VALIDATION_FAILED", message, { reason, ...details });
}

export interface SkillFileInput {
  path: string;
  bytes: Uint8Array;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The text of a file, or nothing where its bytes are no UTF-8 text. */
function textOf(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * The media types of what a skill commonly carries beside its text, by extension. A file set
 * knows the types a Page serves; a skill holds documents, images and scripts as well.
 */
const SKILL_MEDIA_TYPES: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  py: "text/x-python",
  sh: "application/x-sh",
  js: "text/javascript",
  ts: "text/typescript"
};

/** The media type of a file of a skill, from its path. */
function skillMediaType(path: string): string {
  const extension = /\.([A-Za-z0-9]+)$/u.exec(path)?.[1]?.toLowerCase();
  return (
    (path === SKILL_MANIFEST_FILE ? "text/markdown" : undefined) ??
    skillResourceMediaTypeForPath(path) ??
    (extension === undefined ? undefined : SKILL_MEDIA_TYPES[extension]) ??
    fileSetContentType(path)
  );
}

/** The first bytes of the formats a compiled program has, each with its name. */
const EXECUTABLE_MAGIC: readonly { name: string; bytes: readonly number[] }[] = [
  { name: "ELF", bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { name: "PE", bytes: [0x4d, 0x5a] },
  { name: "Mach-O", bytes: [0xfe, 0xed, 0xfa, 0xce] },
  { name: "Mach-O", bytes: [0xfe, 0xed, 0xfa, 0xcf] },
  { name: "Mach-O", bytes: [0xce, 0xfa, 0xed, 0xfe] },
  { name: "Mach-O", bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  // A universal binary of several architectures.
  { name: "Mach-O", bytes: [0xca, 0xfe, 0xba, 0xbe] }
];

/**
 * The first line of a Git LFS pointer: `version`, then the address of the pointer format on
 * whichever host serves Git LFS. Read on the first bytes of a file.
 */
const LFS_POINTER = /^version https:\/\/git-lfs\.[a-z0-9.-]+\/spec\/v\d+\r?\n/u;
/** How many bytes of a file are read for the first line of a pointer. */
const LFS_POINTER_LINE_MAX_BYTES = 128;

const startsWith = (bytes: Uint8Array, prefix: ArrayLike<number>) =>
  bytes.byteLength >= prefix.length &&
  Array.from(prefix).every((byte, index) => bytes[index] === byte);

/** Refuses one file for what it is, whatever its path says it is. */
function requireStorableSkillFile(file: SkillFileInput): void {
  const { path, bytes } = file;
  const issue = fileSetPathIssue(path);
  if (issue || path.includes("\\")) {
    throw refusal(
      "skill_path_invalid",
      `The file '${path}' cannot be a file of a skill: ${issue ?? "a path has '/' between its segments"}.`,
      { path }
    );
  }
  if (bytes.byteLength > SKILL_FILE_MAX_BYTES) {
    throw refusal(
      "skill_file_too_large",
      `The file '${path}' has ${bytes.byteLength} bytes. One file of a skill has at most ${SKILL_FILE_MAX_BYTES} (SKILL_FILE_MAX_BYTES).`,
      { path, cap: "SKILL_FILE_MAX_BYTES", limit: SKILL_FILE_MAX_BYTES, actual: bytes.byteLength }
    );
  }
  const compiled = EXECUTABLE_MAGIC.find((magic) => startsWith(bytes, magic.bytes));
  if (compiled) {
    throw refusal(
      "skill_file_executable",
      `The file '${path}' is a compiled program (${compiled.name}). A skill holds scripts as text and no compiled program.`,
      { path, format: compiled.name }
    );
  }
  if (
    LFS_POINTER.test(Buffer.from(bytes.subarray(0, LFS_POINTER_LINE_MAX_BYTES)).toString("latin1"))
  ) {
    throw refusal(
      "skill_file_lfs_pointer",
      `The file '${path}' is a Git LFS pointer and not the file it stands for. Send the file itself.`,
      { path }
    );
  }
}

/** What the files of a write are read into. */
export interface SkillFilesReading {
  /** The config the files make: the instructions and the text resources. No index yet. */
  config: Record<string, unknown>;
  /** The paths of the files the config does not hold: they are kept in the file set alone. */
  extras: string[];
}

/**
 * Reads the whole folder of a skill as one write carries it. It refuses the set for a limit
 * and each file for its path, its place and what it is, with the path and a reason of its own.
 *
 * A text file with the extension of a resource (`.md`, `.txt`, `.json`, `.yaml`, `.yml`)
 * outside `scripts/` is a resource of the config, at whatever path: the resources a skill had
 * before it could hold other files stay where they are. Every other file lies below
 * `references/`, `scripts/` or `assets/`, and one below `scripts/` is UTF-8 text.
 */
export function readSkillFiles(name: string, files: readonly SkillFileInput[]): SkillFilesReading {
  if (files.length > SKILL_MAX_FILES) {
    throw refusal(
      "skill_too_many_files",
      `The skill has ${files.length} files. A skill holds at most ${SKILL_MAX_FILES} (SKILL_MAX_FILES).`,
      { cap: "SKILL_MAX_FILES", limit: SKILL_MAX_FILES, actual: files.length }
    );
  }
  const total = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (total > SKILL_MAX_BYTES) {
    throw refusal(
      "skill_too_large",
      `The files of the skill have ${total} bytes. A skill holds at most ${SKILL_MAX_BYTES} (SKILL_MAX_BYTES).`,
      { cap: "SKILL_MAX_BYTES", limit: SKILL_MAX_BYTES, actual: total }
    );
  }
  const seen = new Set<string>();
  for (const file of files) {
    requireStorableSkillFile(file);
    const key = file.path.toLowerCase();
    if (seen.has(key)) {
      throw refusal(
        "skill_path_duplicate",
        `The file '${file.path}' is in the skill twice. Paths that differ in case alone count as one.`,
        { path: file.path }
      );
    }
    seen.add(key);
  }
  const manifest = files.find((file) => file.path === SKILL_MANIFEST_FILE);
  if (!manifest) {
    throw refusal(
      "skill_manifest_missing",
      `The files hold no '${SKILL_MANIFEST_FILE}'. Every write carries the whole folder of the skill, '${SKILL_MANIFEST_FILE}' among it.`,
      { path: SKILL_MANIFEST_FILE }
    );
  }
  const root = readSkillManifest(name, manifest.bytes);
  const resources: NonNullable<SkillConfig["resources"]> = [];
  const extras: string[] = [];
  for (const file of files) {
    if (file === manifest) continue;
    const { path, bytes } = file;
    const [folder, ...below] = path.split("/");
    const text = textOf(bytes);
    if (path.toLowerCase().endsWith(`/${SKILL_MANIFEST_FILE.toLowerCase()}`)) {
      throw refusal(
        "skill_path_invalid",
        `The file '${path}' cannot be a file of a skill: '${SKILL_MANIFEST_FILE}' is the one file at the root of a skill.`,
        { path }
      );
    }
    const inScripts = below.length > 0 && folder === SKILL_SCRIPTS_FOLDER;
    if (inScripts && text === undefined) {
      throw refusal(
        "skill_script_not_text",
        `The file '${path}' is no UTF-8 text. A file below '${SKILL_SCRIPTS_FOLDER}/' is a script as text.`,
        { path }
      );
    }
    const mediaType = skillResourceMediaTypeForPath(path);
    if (text !== undefined && mediaType !== undefined && !inScripts) {
      resources.push({ path, mediaType, content: text });
      continue;
    }
    if (below.length === 0 || !SKILL_FOLDERS.some((allowed) => allowed === folder)) {
      throw refusal(
        "skill_file_outside_folders",
        `The file '${path}' lies outside the folders of a skill. Beside '${SKILL_MANIFEST_FILE}' and its text resources a skill holds files below ${SKILL_FOLDERS.map((allowed) => `'${allowed}/'`).join(", ")}.`,
        { path }
      );
    }
    extras.push(path);
  }
  return {
    config: { ...root, ...(resources.length > 0 ? { resources } : {}) },
    extras
  };
}

/** The name, title, description and content a `SKILL.md` holds. A file without a name has the skill's. */
function readSkillManifest(name: string, bytes: Uint8Array): Record<string, unknown> {
  const invalid = (message: string, details: JsonObject = {}) =>
    refusal("skill_manifest_invalid", message, { path: SKILL_MANIFEST_FILE, ...details });
  const text = textOf(bytes);
  if (text === undefined) {
    throw invalid(`'${SKILL_MANIFEST_FILE}' is no UTF-8 text.`);
  }
  try {
    const read = parseSkillManifest(text, SKILL_MANIFEST_FILE, `${name}/${SKILL_MANIFEST_FILE}`);
    const named = /^---\r?\n(?:[\s\S]*?\r?\n)?name\s*:/u.test(text);
    return { ...z.record(z.string(), z.unknown()).parse(read), ...(named ? {} : { name }) };
  } catch (error) {
    if (!(error instanceof SkillMarkdownError)) throw error;
    throw invalid(
      `${error.message}.`,
      error.details
        ? {
            issues: error.details.issues.map(({ message, path }) => ({
              message,
              path: path.map(String)
            }))
          }
        : {}
    );
  }
}

/** The files a config holds itself: `SKILL.md` of its instructions, and its text resources. */
export function skillFilesOfConfig(config: unknown): SkillFileInput[] {
  const skill = skillConfigSchema.safeParse(config);
  if (!skill.success) return [];
  const encode = (text: string) => new TextEncoder().encode(text);
  return [
    { path: SKILL_MANIFEST_FILE, bytes: encode(formatSkillMarkdown(skill.data)) },
    ...(skill.data.resources ?? []).map((resource) => ({
      path: resource.path,
      bytes: encode(resource.content)
    }))
  ];
}

/**
 * Whether stored bytes say what the config says at that path, so that a read may answer the
 * bytes as they were written: a `SKILL.md` that reads as the config's instructions, a resource
 * whose text is the config's.
 */
export function storedFileMatchesConfig(config: unknown, file: SkillFileInput): boolean {
  const skill = skillConfigSchema.safeParse(config);
  if (!skill.success) return false;
  if (file.path !== SKILL_MANIFEST_FILE) {
    const resource = skill.data.resources?.find((candidate) => candidate.path === file.path);
    return resource !== undefined && textOf(file.bytes) === resource.content;
  }
  try {
    const read = skillConfigSchema.safeParse(readSkillManifest(skill.data.name, file.bytes));
    return (
      read.success &&
      read.data.name === skill.data.name &&
      read.data.title === skill.data.title &&
      read.data.description === skill.data.description &&
      read.data.content === skill.data.content
    );
  } catch {
    return false;
  }
}

const extrasSchema = (manifest: unknown): string[] => {
  if (typeof manifest !== "object" || manifest === null || !("extras" in manifest)) return [];
  const { extras } = manifest;
  return Array.isArray(extras)
    ? extras.filter((path): path is string => typeof path === "string")
    : [];
};

/** What the file set of a skill's revision names as its manifest: the files the config does not hold. */
export function skillFileSetManifest(extras: readonly string[]): JsonObject {
  return { kind: "skill", extras: [...extras] };
}

/** The files of a file set that the config does not hold, as the index of the config names them. */
export function skillFileIndex(fileSet: FileSet | undefined): SkillFileEntry[] {
  if (!fileSet) return [];
  const extras = new Set(extrasSchema(fileSet.manifest));
  return fileSet.sourceFiles
    .filter((file) => extras.has(file.path))
    .map((file) => ({
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
      mediaType: skillMediaType(file.path)
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** The index a stored config of a skill carries, or none. */
export function skillFileIndexOfConfig(config: unknown): SkillFileEntry[] {
  const read = z.object({ files: z.array(skillFileEntrySchema) }).safeParse(config);
  return read.success ? read.data.files : [];
}

/** The config of a skill with the index of the files it does not hold, or without one. */
export function withSkillFileIndex(
  config: JsonObject,
  index: readonly SkillFileEntry[]
): JsonObject {
  const { files: _sent, ...own } = config;
  return index.length > 0 ? { ...own, files: index.map((entry) => ({ ...entry })) } : own;
}
