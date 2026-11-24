import {
  AppError,
  WORKFLOW_FILE_KEY,
  workflowDatasetReferenceSchema,
  workflowFileReferenceSchema,
  type ConversationId,
  type JsonObject,
  type JsonValue,
  type WorkflowDatasetReference,
  type WorkflowManifest
} from "@work-shape/catalyst-core";
import { codeOutputDatasetSchema, outputFileRows } from "./code-datasets";
import { holdsDatasetReference, jsonObjectSchema } from "./json";
import { WorkflowStepFailure } from "./step-failure";

// An agent step with `workspace: true` (events-workflows-and-guardrails.md, An agent step with a
// workspace): its agent works in an Execution Workspace of its own, the one a chat agent's
// commands and a code step's script run in. Its input reaches it as files, it runs commands on
// them, and it answers a dataset of its output with the path of a JSON Lines file it wrote.

/** The tools a step's agent gets with a workspace, beside the Workflow's `tools`. */
export const AGENT_WORKSPACE_TOOL_NAMES = [
  "workspace.exec",
  "workspace.read_file",
  "workspace.write_file",
  "workspace.edit_file",
  "workspace.list_files"
] as const;

const WORKSPACE_TOOL_PREFIX = "workspace.";

/** Where the input lies in the workspace, relative to `/workspace`. */
const AGENT_WORKSPACE_INPUT_DIRECTORY = "in";

/** A string longer than this is also a file, and the task message names the file instead. */
const AGENT_WORKSPACE_LONG_TEXT_CHARS = 2_000;

/**
 * The tools of an agent step's run: the Workflow's, and the workspace tools where the step has
 * a workspace. A `workspace.*` name in the Workflow's tools gives a step without one nothing.
 */
export function workflowAgentToolNames(
  tools: readonly string[],
  step: { workspace?: boolean }
): string[] {
  const own = tools.filter((name) => !name.startsWith(WORKSPACE_TOOL_PREFIX));
  return step.workspace === true ? [...new Set([...own, ...AGENT_WORKSPACE_TOOL_NAMES])] : own;
}

/** What the agent's instructions get beside the step's own. */
export const AGENT_WORKSPACE_INSTRUCTIONS = `You work in a sandbox at /workspace that has no network. Your input is in /workspace/${AGENT_WORKSPACE_INPUT_DIRECTORY}/: input.json holds all of it, each dataset is a JSON Lines file, each long text a .txt file and each file of the run is under ${AGENT_WORKSPACE_INPUT_DIRECTORY}/files/. Your task message names them by path. Look at the data before you decide how to read it: run Bash or Python with workspace.exec, check what came out and try again until it is right. For each field of your answer that is a dataset, write a JSON Lines file (one JSON object per line, each matching the row schema) such as out/<name>.jsonl and answer { "path": "out/<name>.jsonl" } in its place.`;

/** One file the worker writes into the workspace before the first turn. */
export type AgentWorkspaceInputFile =
  | { path: string; kind: "text"; text: string }
  | { path: string; kind: "dataset"; reference: WorkflowDatasetReference }
  | { path: string; kind: "file"; fileId: string };

/**
 * The input of an agent step with a workspace, as files: `in/input.json` with each dataset and
 * each run file replaced by the path of its file, each of those files, and each string longer
 * than `AGENT_WORKSPACE_LONG_TEXT_CHARS` as a text file too. `task` is the input as the task
 * message holds it, `input.json` with the long strings replaced by `{ path, chars }`.
 * The same input always gives the same paths: the engine writes the task, the worker the files.
 */
export function agentWorkspaceInput(input: JsonObject): {
  task: JsonObject;
  inputJson: JsonObject;
  files: AgentWorkspaceInputFile[];
} {
  const taken = new Set<string>();
  const files: AgentWorkspaceInputFile[] = [];
  const named = new Map<string, string>();
  const unique = (base: string, extension: string) => {
    let path = `${base}${extension}`;
    for (let count = 2; taken.has(path); count += 1) path = `${base}-${String(count)}${extension}`;
    taken.add(path);
    return path;
  };
  const fieldBase = (at: readonly string[]) =>
    `${AGENT_WORKSPACE_INPUT_DIRECTORY}/${at.map((part) => part.replace(/[^A-Za-z0-9_-]/gu, "_")).join(".") || "input"}`;
  // Both views at once: what `input.json` holds, and what the task message holds.
  function walk(value: JsonValue, at: string[]): { full: JsonValue; task: JsonValue } {
    if (typeof value === "string" && value.length > AGENT_WORKSPACE_LONG_TEXT_CHARS) {
      const path = unique(fieldBase(at), ".txt");
      files.push({ path, kind: "text", text: value });
      return { full: value, task: { path, chars: value.length } };
    }
    if (value === null || typeof value !== "object") return { full: value, task: value };
    if (Array.isArray(value)) {
      const parts = value.map((item, index) => walk(item, [...at, String(index)]));
      return { full: parts.map((part) => part.full), task: parts.map((part) => part.task) };
    }
    const dataset = workflowDatasetReferenceSchema.safeParse(value);
    if (dataset.success) {
      const key = `dataset:${dataset.data.$dataset}:${String(dataset.data.offset ?? "all")}:${String(dataset.data.rowCount)}`;
      let path = named.get(key);
      if (!path) {
        path = unique(fieldBase(at), ".jsonl");
        named.set(key, path);
        files.push({ path, kind: "dataset", reference: dataset.data });
      }
      const shown = { path, rowCount: dataset.data.rowCount };
      return { full: shown, task: shown };
    }
    if (Object.hasOwn(value, WORKFLOW_FILE_KEY)) {
      const file = workflowFileReferenceSchema.parse(value);
      const filename = typeof value.filename === "string" ? value.filename : file.$file;
      let path = named.get(`file:${file.$file}`);
      if (!path) {
        const safe = filename.replace(/[^A-Za-z0-9._-]/gu, "_").replace(/^\.+/u, "_") || "file";
        const dot = safe.lastIndexOf(".");
        path =
          dot > 0
            ? unique(
                `${AGENT_WORKSPACE_INPUT_DIRECTORY}/files/${safe.slice(0, dot)}`,
                safe.slice(dot)
              )
            : unique(`${AGENT_WORKSPACE_INPUT_DIRECTORY}/files/${safe}`, "");
        named.set(`file:${file.$file}`, path);
        files.push({ path, kind: "file", fileId: file.$file });
      }
      const shown = { path, filename };
      return { full: shown, task: shown };
    }
    const full: JsonObject = {};
    const task: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      const part = walk(child, [...at, key]);
      full[key] = part.full;
      task[key] = part.task;
    }
    return { full, task };
  }
  const { full, task } = walk(input, []);
  return {
    task: jsonObjectSchema.parse(task),
    inputJson: jsonObjectSchema.parse(full),
    files
  };
}

/** What writes the input into a thread's workspace and reads back what its agent wrote. */
export interface WorkflowAgentWorkspaceFiles {
  /** The most bytes one workspace holds: the bound of the input and of each returned dataset. */
  maxBytes: number;
  /** Writes files into the thread's workspace, which is made where it does not exist yet. */
  write(input: {
    conversationId: ConversationId;
    ownerUserId: string;
    files: readonly { path: string; bytes: Uint8Array; mimeType?: string }[];
  }): Promise<void>;
  /** The bytes of a file of the thread's workspace, or `undefined` where it has none. */
  read(input: { conversationId: ConversationId; path: string }): Promise<Uint8Array | undefined>;
}

/** Where the worker reads the input's datasets and run files from. */
export interface AgentWorkspaceInputSources {
  rows(reference: WorkflowDatasetReference): Promise<AsyncIterable<JsonObject>>;
  /** The bytes of a file of the run, or `undefined` where it is gone. */
  file(fileId: string): Promise<Uint8Array | undefined>;
}

/**
 * Writes an agent step's input into its thread's workspace before the first turn. Everything
 * is bounded by the workspace's size together: a larger input fails the run with
 * `workspace_limit` before the agent starts, and nothing of it reaches a message.
 */
export async function stageAgentWorkspace(input: {
  conversationId: ConversationId;
  ownerUserId: string;
  stepInput: JsonObject;
  workspace: Pick<WorkflowAgentWorkspaceFiles, "write" | "maxBytes">;
  sources: AgentWorkspaceInputSources;
  signal?: AbortSignal;
}): Promise<void> {
  const { inputJson, files } = agentWorkspaceInput(input.stepInput);
  const encoder = new TextEncoder();
  const written: { path: string; bytes: Uint8Array; mimeType?: string }[] = [];
  let total = 0;
  const add = (path: string, bytes: Uint8Array, mimeType?: string) => {
    total += bytes.byteLength;
    if (total > input.workspace.maxBytes) throw workspaceLimit(input.workspace.maxBytes);
    written.push({ path, bytes, ...(mimeType ? { mimeType } : {}) });
  };
  add(
    `${AGENT_WORKSPACE_INPUT_DIRECTORY}/input.json`,
    encoder.encode(`${JSON.stringify(inputJson, null, 2)}\n`),
    "application/json"
  );
  for (const file of files) {
    input.signal?.throwIfAborted();
    if (file.kind === "text") add(file.path, encoder.encode(file.text), "text/plain");
    else if (file.kind === "file") {
      const bytes = await input.sources.file(file.fileId);
      if (bytes) add(file.path, bytes);
    } else {
      const lines: Uint8Array[] = [];
      let bytes = 0;
      for await (const row of await input.sources.rows(file.reference)) {
        const line = encoder.encode(`${JSON.stringify(row)}\n`);
        bytes += line.byteLength;
        if (total + bytes > input.workspace.maxBytes)
          throw workspaceLimit(input.workspace.maxBytes);
        lines.push(line);
      }
      add(file.path, Buffer.concat(lines, bytes), "text/plain");
    }
  }
  await input.workspace.write({
    conversationId: input.conversationId,
    ownerUserId: input.ownerUserId,
    files: written
  });
}

const workspaceLimit = (maxBytes: number) =>
  new AppError(
    "VALIDATION_FAILED",
    `The input of the agent step takes more than the ${String(maxBytes)} bytes a workspace holds`,
    { reason: "workspace_limit" }
  );

/**
 * The output schema as the agent answers it: each dataset field is `{ path }` of a JSON Lines
 * file in its workspace. The provider's structured output and both checks of the answer use it.
 */
export function agentFacingOutputSchema(schema: JsonObject): JsonObject {
  function walk(value: JsonValue): JsonValue {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== "object") return value;
    if (value.type === "dataset")
      return {
        type: "object",
        description:
          "A dataset: the path in /workspace of a JSON Lines file you wrote, one row per line.",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false
      };
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child)]));
  }
  return jsonObjectSchema.parse(walk(schema));
}

/**
 * Stores each dataset an agent's answer names by the path of a file in its workspace, every
 * line checked against the row schema, and answers the output with each dataset's reference in
 * its place. The file is bounded by the workspace's size.
 */
export async function storeAgentOutputDatasets(input: {
  value: JsonValue;
  outputSchema: JsonObject;
  types: WorkflowManifest["types"];
  read(path: string): Promise<Uint8Array | undefined>;
  rowBytes: number;
  store(input: {
    field: string;
    rowSchema: JsonObject;
    rows: AsyncIterable<unknown>;
  }): Promise<WorkflowDatasetReference>;
}): Promise<JsonValue> {
  if (holdsDatasetReference(input.value))
    throw new WorkflowStepFailure(
      "output_invalid",
      "The answer holds '$dataset': the agent names a dataset by the path of its file"
    );
  const schema = codeOutputDatasetSchema(input.outputSchema, input.types);
  async function walk(value: JsonValue, at: JsonObject, path: string[]): Promise<JsonValue> {
    const field = path.join(".");
    if (at.type === "dataset") {
      const named = jsonObjectSchema.safeParse(value).data;
      const filePath =
        typeof named?.path === "string" ? named.path.replace(/^\/workspace\//u, "") : "";
      const bytes = filePath ? await input.read(filePath) : undefined;
      if (!bytes)
        throw new WorkflowStepFailure(
          "output_invalid",
          `The answer names no file of the workspace at the dataset '${field}'`
        );
      const reference = await input.store({
        field,
        rowSchema: jsonObjectSchema.parse(at.row),
        rows: outputFileRows({
          handle: bytesHandle(bytes),
          bound: bytes.byteLength,
          rowBytes: input.rowBytes
        })
      });
      return { ...reference };
    }
    if (Array.isArray(value)) {
      const items = jsonObjectSchema.safeParse(at.items).data;
      if (!items) return value;
      const out: JsonValue[] = [];
      for (const [index, item] of value.entries())
        out.push(await walk(item, items, [...path, String(index)]));
      return out;
    }
    if (value === null || typeof value !== "object") return value;
    const properties = jsonObjectSchema.safeParse(at.properties).data ?? {};
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      const childSchema = Object.hasOwn(properties, key)
        ? jsonObjectSchema.safeParse(properties[key]).data
        : undefined;
      out[key] = childSchema ? await walk(child, childSchema, [...path, key]) : child;
    }
    return out;
  }
  return walk(input.value, schema, []);
}

/** Bytes read as a file is, for the reader of JSON Lines a code step's output goes through. */
function bytesHandle(bytes: Uint8Array) {
  let position = 0;
  return {
    read(buffer: Buffer, offset: number, length: number) {
      const end = Math.min(position + length, bytes.byteLength);
      buffer.set(bytes.subarray(position, end), offset);
      const bytesRead = end - position;
      position = end;
      return Promise.resolve({ bytesRead, buffer });
    }
  };
}
