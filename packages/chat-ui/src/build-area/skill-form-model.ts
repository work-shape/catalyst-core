import type { LocaleCode } from "@work-shape/catalyst-api-client";
import { formatSkillMarkdown, skillResourceMediaTypeForPath } from "@work-shape/catalyst-core";
import type { AssetFileEntry, AssetFileRead, AssetFileWrite } from "../api/asset-writes";

/** The file that holds a skill's instructions. */
export const SKILL_ROOT_FILE_NAME = "SKILL.md";

/** The folders a file is added to, in the order the editor shows them. */
export const SKILL_FOLDERS = ["references", "scripts", "assets"] as const;
export type SkillFolder = (typeof SKILL_FOLDERS)[number];

/** The folder whose files are scripts: text, and never a reference of the config. */
const SCRIPTS_FOLDER: SkillFolder = "scripts";

/**
 * One file of a skill's folder beside `SKILL.md`, as the form holds it. A file the instance
 * named in the skill's index and the page has not read yet carries neither `text` nor `base64`.
 */
export interface SkillFileForm {
  path: string;
  /** The size of the content in bytes. */
  bytes: number;
  /** The content of UTF-8 text: it is edited in place. */
  text?: string;
  /** The content of every other file. */
  base64?: string;
  /** The hash the instance names the stored file by. Absent for a file added or replaced here. */
  sha256?: string;
}

export interface SkillFormState {
  name: string;
  title: string;
  description: string;
  /** The sentence for people. Empty where the skill has none. */
  summary: string;
  /**
   * The skill's starters as its file holds them. The form does not edit them: they are kept
   * so that a save here leaves them as they are.
   */
  starters: unknown[];
  /**
   * The further keys of the frontmatter of `SKILL.md`, such as a license. The form does not
   * edit them: a save of the folder writes them back.
   */
  frontmatter: Record<string, unknown>;
  content: string;
  /** Every file of the folder but `SKILL.md`, in the order they were read or added. */
  files: SkillFileForm[];
}

export function emptySkillForm(): SkillFormState {
  return {
    name: "",
    title: "",
    description: "",
    summary: "",
    starters: [],
    frontmatter: {},
    content: "",
    files: []
  };
}

export function startedSkillForm(start: { name: string; title: string }): SkillFormState {
  return { ...emptySkillForm(), name: start.name, title: start.title };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/** A size in bytes as people read it: bytes, KiB or MiB, as the limits of a skill are named. */
export function formatFileBytes(bytes: number, locale: LocaleCode): string {
  const [amount, unit] =
    bytes < 1024
      ? [bytes, "B"]
      : bytes < 1024 * 1024
        ? [bytes / 1024, "KiB"]
        : [bytes / (1024 * 1024), "MiB"];
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(amount)} ${unit}`;
}

/** The size of a text as UTF-8. */
export function textBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * The form of a skill's config: its text resources with their content, and the files its
 * index names, whose content the page reads from the folder.
 */
export function skillConfigToForm(config: Record<string, unknown>): SkillFormState {
  const resources = (Array.isArray(config.resources) ? config.resources : []).flatMap(
    (resource: unknown): SkillFileForm[] => {
      if (!isRecord(resource)) return [];
      const path = stringField(resource, "path");
      const content = stringField(resource, "content");
      return path !== undefined && content !== undefined
        ? [{ path, bytes: textBytes(content), text: content }]
        : [];
    }
  );
  const held = new Set(resources.map((file) => file.path));
  const indexed = (Array.isArray(config.files) ? config.files : []).flatMap(
    (entry: unknown): SkillFileForm[] => {
      if (!isRecord(entry)) return [];
      const path = stringField(entry, "path");
      const sha256 = stringField(entry, "sha256");
      const { bytes } = entry;
      return path !== undefined && !held.has(path) && typeof bytes === "number"
        ? [{ path, bytes, ...(sha256 === undefined ? {} : { sha256 }) }]
        : [];
    }
  );
  return {
    name: stringField(config, "name") ?? "",
    title: stringField(config, "title") ?? "",
    description: stringField(config, "description") ?? "",
    summary: stringField(config, "summary") ?? "",
    starters: Array.isArray(config.starters) ? config.starters : [],
    frontmatter: isRecord(config.frontmatter) ? config.frontmatter : {},
    content: stringField(config, "content") ?? "",
    files: [...resources, ...indexed]
  };
}

/**
 * Whether a file is a reference the config holds as text, as the instance reads a folder: UTF-8
 * text with the extension of a reference, outside `scripts/`. Every other file is kept beside
 * the config.
 */
function isConfigResource(file: SkillFileForm): boolean {
  return (
    file.text !== undefined &&
    !file.path.startsWith(`${SCRIPTS_FOLDER}/`) &&
    skillResourceMediaTypeForPath(file.path) !== undefined
  );
}

/** The config a save of the form writes, where the files beside it stay as they are. */
export function skillFormToConfig(form: SkillFormState): Record<string, unknown> {
  const resources = form.files.flatMap((file) => {
    const mediaType = skillResourceMediaTypeForPath(file.path);
    return isConfigResource(file) && file.text !== undefined && mediaType !== undefined
      ? [{ path: file.path, mediaType, content: file.text }]
      : [];
  });
  return {
    name: form.name.trim(),
    title: form.title.trim(),
    description: form.description.trim(),
    ...(form.summary.trim() ? { summary: form.summary.trim() } : {}),
    ...(form.starters.length ? { starters: form.starters } : {}),
    ...(Object.keys(form.frontmatter).length ? { frontmatter: form.frontmatter } : {}),
    content: form.content,
    ...(resources.length ? { resources } : {})
  };
}

/** The files beside `SKILL.md`, in the order of their paths, for a comparison. */
function filesOf(form: SkillFormState): string {
  return JSON.stringify(
    form.files
      .map((file) => [file.path, file.text, file.base64, file.sha256])
      .sort(([left], [right]) => ((left ?? "") < (right ?? "") ? -1 : 1))
  );
}

/**
 * Whether a save writes the whole folder: a file beside `SKILL.md` was added, replaced,
 * renamed, edited or deleted, a text resource the config holds too. The instance checks such a
 * write file by file and names the file it refuses. A save that changed only the fields and
 * the text of `SKILL.md` writes the config, and the files beside it stay.
 */
export function skillFolderChanged(form: SkillFormState, baseline: SkillFormState): boolean {
  return filesOf(form) !== filesOf(baseline);
}

/** A file whose content the page has not read yet. */
export function isUnread(file: SkillFileForm): boolean {
  return file.text === undefined && file.base64 === undefined;
}

/** The form with the content of the files the folder read answered. */
export function withReadFiles(
  form: SkillFormState,
  read: readonly AssetFileRead[]
): SkillFormState {
  const byPath = new Map(read.map((file) => [file.path, file]));
  return {
    ...form,
    files: form.files.map((file) => {
      const found = isUnread(file) ? byPath.get(file.path) : undefined;
      if (found === undefined) return file;
      return {
        path: file.path,
        bytes: found.bytes,
        sha256: found.sha256,
        ...(found.text === undefined ? {} : { text: found.text }),
        ...(found.base64 === undefined ? {} : { base64: found.base64 })
      };
    })
  };
}

/** The form with the hash of every file a save of the folder stored. */
export function withStoredHashes(
  form: SkillFormState,
  stored: readonly AssetFileEntry[]
): SkillFormState {
  const byPath = new Map(stored.map((file) => [file.path, file]));
  return {
    ...form,
    files: form.files.map((file) => {
      const found = byPath.get(file.path);
      return found === undefined ? file : { ...file, sha256: found.sha256, bytes: found.bytes };
    })
  };
}

/**
 * The whole folder a save writes: `SKILL.md` made from the form's fields, and every other file.
 * Every file has to be read first.
 */
export function skillFormToFolder(form: SkillFormState): AssetFileWrite[] {
  const summary = form.summary.trim();
  const manifest = formatSkillMarkdown({
    name: form.name.trim(),
    title: form.title.trim(),
    description: form.description.trim(),
    ...(summary ? { summary } : {}),
    content: form.content,
    // The starters are kept as the file held them, so they are written as the frontmatter key
    // they are, right after the fields the form edits.
    frontmatter: {
      ...(form.starters.length ? { starters: form.starters } : {}),
      ...form.frontmatter
    }
  });
  return [
    { path: SKILL_ROOT_FILE_NAME, text: manifest },
    ...form.files.map((file): AssetFileWrite =>
      file.text !== undefined
        ? { path: file.path, text: file.text }
        : { path: file.path, base64: file.base64 ?? "" }
    )
  ];
}

/** Where a file lies: one of the three folders and its name in it, or the root. */
export function skillFilePlace(path: string): { folder?: SkillFolder; name: string } {
  const slash = path.indexOf("/");
  const folder = SKILL_FOLDERS.find((candidate) => candidate === path.slice(0, slash));
  return folder === undefined ? { name: path } : { folder, name: path.slice(slash + 1) };
}

/** The path of a file named `name` in `folder`, or at the root. */
export function skillFilePath(folder: SkillFolder | undefined, name: string): string {
  return folder === undefined ? name : `${folder}/${name}`;
}

/** The name a new empty file of a folder starts with. */
const NEW_FILE_NAMES: Record<SkillFolder, string> = {
  references: "reference.md",
  scripts: "script.py",
  assets: "notes.txt"
};

/** A path in `folder` that no file has yet, from `name` or the folder's own first name. */
export function freeSkillFilePath(
  files: readonly SkillFileForm[],
  folder: SkillFolder,
  name: string = NEW_FILE_NAMES[folder]
): string {
  const used = new Set(files.map((file) => file.path.toLowerCase()));
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  let path = skillFilePath(folder, name);
  for (let number = 2; used.has(path.toLowerCase()); number += 1) {
    path = skillFilePath(folder, `${stem}-${number}${extension}`);
  }
  return path;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The text of bytes, or nothing where they are no UTF-8 text. */
function textOf(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}

/** Bytes as base64, in pieces small enough for one call each. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.byteLength; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

/** The file of a folder made of bytes a person chose: text where they are UTF-8. */
export function skillFileOfBytes(path: string, bytes: Uint8Array): SkillFileForm {
  const text = textOf(bytes);
  return text === undefined
    ? { path, bytes: bytes.byteLength, base64: toBase64(bytes) }
    : { path, bytes: bytes.byteLength, text };
}

/** The bytes of a file the page holds the content of, for a download. */
export function skillFileBlob(file: SkillFileForm): Blob {
  if (file.text !== undefined) return new Blob([file.text]);
  const binary = atob(file.base64 ?? "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes]);
}
