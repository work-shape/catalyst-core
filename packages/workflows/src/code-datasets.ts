import { constants, createWriteStream } from "node:fs";
import { chmod, lstat, open, opendir, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  workflowDatasetReferenceSchema,
  type JsonObject,
  type JsonValue,
  type WorkflowDatasetReference,
  type WorkflowManifest
} from "@work-shape/catalyst-core";
import { WORKFLOW_CODE_ERRORS } from "./code-step";
import { rowSchemaOf } from "./dataset-schema";
import { holdsDatasetReference, jsonObjectSchema } from "./json";
import { WorkflowStepFailure } from "./step-failure";

// Datasets in and out of a code step. The container has no network and never reaches the
// object store: the worker writes each dataset of the step's input as a file of JSON Lines
// into a directory the container reads, and after the script has ended it reads the files the
// result names from the directory the script wrote, storing every line as a row.
//
// This is the one place the worker opens a file a script left. It opens only a regular file
// directly in the output directory, never through a link, and stops at the step's bound while
// it reads. Nothing of a line reaches an error: a line that is no row is named by its number.

/** What the worker reads and writes datasets with, for one step run. */
export interface CodeStepDatasets {
  /** The longest line a row may be, in bytes. */
  rowBytes: number;
  /** The rows of a dataset the run may read, in order. Refuses one it may not. */
  rows(id: string): Promise<AsyncIterable<JsonObject>>;
  /** Stores rows as a dataset of the step run at `field`, each checked against `rowSchema`. */
  store(input: {
    field: string;
    rowSchema: JsonObject;
    rows: AsyncIterable<unknown>;
    maxBytes?: number;
    signal: AbortSignal;
  }): Promise<WorkflowDatasetReference>;
}

/** What a script reads in place of a dataset of its input. */
interface CodeInputDatasetFile {
  path: string;
  rowCount: number;
}

/** The output schema of a step with the row schema of each of its datasets written out. */
export function codeOutputDatasetSchema(
  schema: JsonObject,
  types: WorkflowManifest["types"]
): JsonObject {
  function walk(value: JsonValue): JsonValue {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== "object") return value;
    if (value.type === "dataset")
      return { ...value, row: rowSchemaOf(jsonObjectSchema.parse(value.row), types) };
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child)]));
  }
  return jsonObjectSchema.parse(walk(schema));
}

/** A file name from the place of a dataset in the input: `postings`, `months.0.rows`. */
function inputFileName(path: readonly string[], taken: Set<string>): string {
  const base = path.map((part) => part.replace(/[^A-Za-z0-9_-]/gu, "_")).join(".") || "dataset";
  let name = `${base}.jsonl`;
  for (let count = 2; taken.has(name); count += 1) name = `${base}-${String(count)}.jsonl`;
  taken.add(name);
  return name;
}

/**
 * Writes each dataset of a step's input as a file of JSON Lines into `directory` and answers
 * the input with `{ path, rowCount }` in each dataset's place, the path as the script sees it.
 * A dataset the input names more than once is written once. The files count against the
 * step's disk bound: a line that would take them past it is not written, and the step fails.
 */
export async function writeInputDatasets(input: {
  value: JsonObject;
  directory: string;
  /** Where the script sees `directory`. */
  seenAs: string;
  /** The bytes of disk the step may take, its input files among them. */
  bound: number;
  datasets: CodeStepDatasets;
  signal: AbortSignal;
}): Promise<{ value: JsonObject; bytes: number }> {
  const taken = new Set<string>();
  const written = new Map<string, CodeInputDatasetFile>();
  let bytes = 0;
  async function walk(value: JsonValue, path: string[]): Promise<JsonValue> {
    if (value === null || typeof value !== "object") return value;
    const reference = workflowDatasetReferenceSchema.safeParse(value);
    if (reference.success) {
      const id = reference.data.$dataset;
      const already = written.get(id);
      if (already) return { ...already };
      const name = inputFileName(path, taken);
      const rows = await input.datasets.rows(id);
      let rowCount = 0;
      async function* lines(): AsyncIterable<string> {
        for await (const row of rows) {
          const line = `${JSON.stringify(row)}\n`;
          bytes += Buffer.byteLength(line);
          if (bytes > input.bound) throw inputDiskLimit(input.bound);
          rowCount += 1;
          yield line;
        }
      }
      // A new file, read-only for whoever reads it, which the script cannot change.
      await pipeline(
        Readable.from(lines()),
        createWriteStream(join(input.directory, name), { flags: "wx", mode: 0o444 }),
        { signal: input.signal }
      );
      const file: CodeInputDatasetFile = { path: `${input.seenAs}/${name}`, rowCount };
      written.set(id, file);
      return { ...file };
    }
    if (Array.isArray(value)) {
      const items: JsonValue[] = [];
      for (const [index, item] of value.entries())
        items.push(await walk(item, [...path, String(index)]));
      return items;
    }
    const object: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value))
      object[key] = await walk(child, [...path, key]);
    return object;
  }
  return { value: jsonObjectSchema.parse(await walk(input.value, [])), bytes };
}

const inputDiskLimit = (bound: number) =>
  new WorkflowStepFailure(
    WORKFLOW_CODE_ERRORS.diskLimit,
    `The datasets of the step's input take more than ${String(bound)} bytes of disk, the bound of a code step`
  );

/** A name of a file directly in a directory: no `/`, not `.` or `..`, no hidden file. */
const OUTPUT_FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/u;

const diskLimit = (bound: number) =>
  new WorkflowStepFailure(
    WORKFLOW_CODE_ERRORS.diskLimit,
    `The step's input datasets and what its script wrote take more than ${String(bound)} bytes of disk`
  );

/**
 * Opens the file a result names, or refuses it. The name is one file directly in the output
 * directory. The file is opened without following a link and without waiting for a writer, and
 * is taken only where it is a regular file with no second name and within the bound.
 */
export async function openOutputFile(input: {
  path: string;
  directory: string;
  seenAs: string;
  field: string;
  bound: number;
}): Promise<FileHandle> {
  const prefix = `${input.seenAs}/`;
  const name = input.path.startsWith(prefix) ? input.path.slice(prefix.length) : "";
  if (!OUTPUT_FILE_NAME.test(name)) {
    throw new WorkflowStepFailure(
      WORKFLOW_CODE_ERRORS.datasetPathInvalid,
      `The result names the dataset '${input.field}' by a path that is no file directly in ${input.seenAs}`
    );
  }
  const invalid = () =>
    new WorkflowStepFailure(
      WORKFLOW_CODE_ERRORS.datasetFileInvalid,
      `The file the result names for the dataset '${input.field}' is no regular file in ${input.seenAs}`
    );
  let handle: FileHandle;
  try {
    handle = await open(
      join(input.directory, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch {
    // Missing, a link, or nothing the worker may open.
    throw invalid();
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw invalid();
    if (stat.size > input.bound) throw diskLimit(input.bound);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * The rows of a file of JSON Lines, read from an open file and never past `bound` bytes. A line
 * longer than a row may be, or one that is no JSON, ends the reading with its number.
 */
export async function* outputFileRows(input: {
  handle: FileHandle;
  bound: number;
  rowBytes: number;
}): AsyncIterable<unknown> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = Buffer.alloc(1024 * 1024);
  let total = 0;
  let line = 0;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  const tooLong = () =>
    new WorkflowStepFailure(
      "dataset_limit",
      `The dataset reached 'rowBytes' at line ${String(line + 1)}`
    );
  const parse = (bytes: Buffer): unknown => {
    line += 1;
    const text = bytes.at(-1) === 13 ? bytes.subarray(0, -1) : bytes;
    try {
      return JSON.parse(decoder.decode(text));
    } catch {
      throw new WorkflowStepFailure(
        "dataset_row_invalid",
        `Dataset line ${String(line)} is no JSON in UTF-8`
      );
    }
  };
  for (;;) {
    const { bytesRead } = await input.handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > input.bound) throw diskLimit(input.bound);
    let chunk = buffer.subarray(0, bytesRead);
    let end = chunk.indexOf(10);
    while (end !== -1) {
      const piece = chunk.subarray(0, end);
      if (pendingBytes + piece.length + 1 > input.rowBytes) throw tooLong();
      const whole = pending.length > 0 ? Buffer.concat([...pending, piece]) : piece;
      pending = [];
      pendingBytes = 0;
      yield parse(whole);
      chunk = chunk.subarray(end + 1);
      end = chunk.indexOf(10);
    }
    if (chunk.length > 0) {
      if (pendingBytes + chunk.length + 1 > input.rowBytes) throw tooLong();
      // The buffer is read into again: what waits for its line's end is copied.
      pending.push(Buffer.from(chunk));
      pendingBytes += chunk.length;
    }
  }
  if (pendingBytes > 0) yield parse(Buffer.concat(pending));
}

/**
 * Stores each dataset a script's result names and answers the result with each dataset's
 * reference in its place. A result that holds a reference of its own is refused: a script
 * names a dataset by its file, never by an id.
 */
export async function storeOutputDatasets(input: {
  value: JsonValue;
  /** The step's output schema, every row written out (`codeOutputDatasetSchema`). */
  schema: JsonObject;
  directory: string;
  seenAs: string;
  bound: number;
  maxBytes?: number;
  datasets: CodeStepDatasets;
  signal: AbortSignal;
}): Promise<JsonValue> {
  if (holdsDatasetReference(input.value)) {
    throw new WorkflowStepFailure(
      WORKFLOW_CODE_ERRORS.outputInvalid,
      "The result holds '$dataset': a script names a dataset by the path of its file"
    );
  }
  async function walk(value: JsonValue, schema: JsonObject, path: string[]): Promise<JsonValue> {
    const field = path.join(".");
    if (schema.type === "dataset") {
      const named = jsonObjectSchema.safeParse(value).data;
      if (!named || typeof named.path !== "string" || Object.keys(named).length !== 1) {
        throw new WorkflowStepFailure(
          WORKFLOW_CODE_ERRORS.datasetPathInvalid,
          `The result holds no { path } at the dataset '${field}'`
        );
      }
      const handle = await openOutputFile({
        path: named.path,
        directory: input.directory,
        seenAs: input.seenAs,
        field,
        bound: input.bound
      });
      try {
        const reference = await input.datasets.store({
          field,
          rowSchema: jsonObjectSchema.parse(schema.row),
          rows: outputFileRows({ handle, bound: input.bound, rowBytes: input.datasets.rowBytes }),
          ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
          signal: input.signal
        });
        return { ...reference };
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
    if (Array.isArray(value)) {
      const items = jsonObjectSchema.safeParse(schema.items).data;
      if (!items) return value;
      const out: JsonValue[] = [];
      for (const [index, item] of value.entries())
        out.push(await walk(item, items, [...path, String(index)]));
      return out;
    }
    if (value === null || typeof value !== "object") return value;
    const properties = jsonObjectSchema.safeParse(schema.properties).data ?? {};
    const out: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      const childSchema = Object.hasOwn(properties, key)
        ? jsonObjectSchema.safeParse(properties[key]).data
        : undefined;
      out[key] = childSchema ? await walk(child, childSchema, [...path, key]) : child;
    }
    return out;
  }
  return walk(input.value, input.schema, []);
}

/**
 * How many bytes lie in a directory and below it, links not followed. A directory the worker
 * cannot read is refused rather than counted as empty: what it holds cannot be bounded.
 */
export async function directoryBytes(directory: string, bound: number): Promise<number> {
  let total = 0;
  async function walk(path: string): Promise<void> {
    let entries;
    try {
      entries = await opendir(path);
    } catch (error) {
      // A folder the script removed while it was measured holds nothing any more.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw diskLimit(bound);
    }
    for await (const entry of entries) {
      const child = join(path, entry.name);
      const stat = await lstat(child).catch(() => undefined);
      if (!stat) continue;
      total += stat.size;
      if (total > bound) return;
      if (stat.isDirectory()) await walk(child);
    }
  }
  await walk(directory);
  return total;
}

/**
 * Removes a directory a script wrote into. A script may leave a folder it took its own rights
 * from; the worker gives them back, without following a link, and removes it then.
 */
export async function removeScriptDirectory(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
    return;
  } catch {
    // Below: a folder the worker could not list.
  }
  async function open(path: string): Promise<void> {
    const stat = await lstat(path).catch(() => undefined);
    if (!stat?.isDirectory()) return;
    await chmod(path, 0o700).catch(() => undefined);
    const entries = await opendir(path).catch(() => undefined);
    if (!entries) return;
    for await (const entry of entries) await open(join(path, entry.name));
  }
  await open(directory);
  await rm(directory, { recursive: true, force: true });
}
