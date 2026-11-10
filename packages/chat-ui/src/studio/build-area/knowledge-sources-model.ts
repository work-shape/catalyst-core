// The synced sources of a Knowledge Base of documents as its page edits them: each names the
// Connection it reads through and the folders it reads, the boundary, by their ids at the
// source. Adding, narrowing or removing a source is a draft change that takes effect at
// publish (spec: Synced sources, "The shape").

/** One source as the form holds it: the lists as typed, one entry per line. */
export interface KnowledgeSourceForm {
  /** Stable within the Knowledge Base; the operations name the source by it. */
  id: string;
  /** The Connection the source reads through. It stays once the source is published. */
  connection: string;
  /** The folder ids, one per line or separated by commas. */
  folders: string;
  /** Patterns on the file name, one per line. Empty for every file. */
  include: string;
  /** Patterns on the path below the folders, one per line. Empty for none. */
  exclude: string;
  /** When the source syncs by itself (SRC-SYNC); a field left out is the instance's default. */
  schedule?: KnowledgeSourceSchedule;
}

/** A source's `schedule` as the page edits it: `off` starts no pass of that mode. */
export interface KnowledgeSourceSchedule {
  /** Minutes between `changes` polls. */
  changes?: number | typeof SYNC_OFF;
  /** The full pass as a cron expression in the instance's time zone. */
  full?: string;
}

/** A schedule field that starts no pass of its mode. */
export const SYNC_OFF = "off";
/** The full pass of a source that sets none: nightly at 02:00. */
export const FULL_SYNC_DEFAULT = "0 2 * * *";

/** Whether the source syncs by itself at all. */
export function syncsByItself(schedule: KnowledgeSourceSchedule | undefined): boolean {
  return !(schedule?.changes === SYNC_OFF && schedule.full === SYNC_OFF);
}

/** A stored `schedule`, as far as the page reads it. */
function scheduleOf(value: unknown): KnowledgeSourceSchedule | undefined {
  const changes = member(value, "changes");
  const full = member(value, "full");
  const schedule: KnowledgeSourceSchedule = {
    ...(changes === SYNC_OFF || typeof changes === "number" ? { changes } : {}),
    ...(typeof full === "string" ? { full } : {})
  };
  return Object.keys(schedule).length > 0 ? schedule : undefined;
}

/** The longest source id the definition takes. */
const SOURCE_ID_MAX_LENGTH = 63;

function member(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
}

function lines(value: unknown, separator: string): string {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").join(separator)
    : "";
}

/** The sources of a stored definition. An entry the page cannot read is left out. */
export function knowledgeSourcesFromConfig(value: unknown): KnowledgeSourceForm[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const id = member(entry, "id");
    const connection = member(entry, "connection");
    if (typeof id !== "string" || typeof connection !== "string") return [];
    const schedule = scheduleOf(member(entry, "schedule"));
    return [
      {
        id,
        connection,
        folders: lines(member(entry, "folders"), "\n"),
        include: lines(member(entry, "include"), "\n"),
        exclude: lines(member(entry, "exclude"), "\n"),
        ...(schedule === undefined ? {} : { schedule })
      }
    ];
  });
}

/** The folder ids typed into a source, in order, each once. */
export function sourceFolderIds(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/u)
        .map((folder) => folder.trim())
        .filter((folder) => folder !== "")
    )
  ];
}

/** Patterns, one per line: a pattern such as `*.{pdf,docx}` may hold a comma. */
function patterns(text: string): string[] {
  return text
    .split("\n")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== "");
}

/** The `sources` a save writes. An empty pattern list is left out: every file is read. */
export function knowledgeSourcesToConfig(
  sources: readonly KnowledgeSourceForm[]
): Record<string, unknown>[] {
  return sources.map((source) => {
    const include = patterns(source.include);
    const exclude = patterns(source.exclude);
    const schedule = scheduleConfig(source.schedule);
    return {
      id: source.id,
      connection: source.connection,
      folders: sourceFolderIds(source.folders),
      ...(include.length > 0 ? { include } : {}),
      ...(exclude.length > 0 ? { exclude } : {}),
      ...(schedule === undefined ? {} : { schedule })
    };
  });
}

/** The `schedule` a save writes: a field left at its default is left out, and so is an empty one. */
function scheduleConfig(
  schedule: KnowledgeSourceSchedule | undefined
): KnowledgeSourceSchedule | undefined {
  const written = {
    ...(schedule?.changes === undefined ? {} : { changes: schedule.changes }),
    ...(schedule?.full === undefined ? {} : { full: schedule.full })
  };
  return Object.keys(written).length > 0 ? written : undefined;
}

/**
 * The id of a new source through `connection`: its name in lowercase words joined by hyphens,
 * numbered where another source of the Knowledge Base has it already.
 */
export function newSourceId(connection: string, taken: readonly string[]): string {
  const words = connection
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const base = (/^[a-z]/u.test(words) ? words : `source-${words}`)
    .slice(0, SOURCE_ID_MAX_LENGTH - 3)
    .replace(/-+$/u, "");
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let number = 2; ; number += 1) {
    const id = `${base}-${number}`;
    if (!used.has(id)) return id;
  }
}

/** A new source through `connection`, with no folder yet. */
export function newKnowledgeSource(
  connection: string,
  sources: readonly KnowledgeSourceForm[]
): KnowledgeSourceForm {
  return {
    id: newSourceId(
      connection,
      sources.map((source) => source.id)
    ),
    connection,
    folders: "",
    include: "",
    exclude: ""
  };
}
