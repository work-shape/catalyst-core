import {
  APP_ACTION_NAME_PATTERN,
  DATA_STORE_SCALAR_TYPES,
  readYamlData,
  type JsonObject,
  type JsonValue
} from "@vivd-catalyst/core";
import { z } from "zod";
import {
  APP_ACTION_DESCRIPTION_MAX_CHARS,
  APP_ACTION_MAPPING_MAX_DEPTH,
  APP_ACTION_MAPPING_MAX_NODES,
  APP_ACTION_POLICY_VALUES,
  appActionInputSchemaSchema,
  readMappingText,
  type AppActionInputSchema,
  type CompiledAppAction,
  type SqlActionParameter
} from "./action-input";
import type { PageBuildError } from "./errors";
import { KIT_WORKFLOW_ACTIONS_SINCE, kitStartsWorkflows } from "./kit";
import { PAGE_MANIFEST_FILE, type PageManifest } from "./manifest";
import {
  APP_SQL_ACTION_FILE_MAX_BYTES,
  APP_SQL_ACTION_FILE_SUFFIX,
  compileSqlStatement
} from "./sql-action";
import type { PageFile } from "./types";

// The named actions of a Page: one file of `actions/` each, and the ending of its name says
// which kind. `<name>.action.yaml` says which operation of which Connection the action stands
// for, or which Workflow it starts, what the browser may pass, and where each parameter goes
// in the input of the operation or of the run.
// `<name>.sql` is a statement on the Data Store of the manifest, with its parameters declared
// in its header: one that reads, or one that adds a row. The build reads a file as data and writes the action into the
// manifest. At a call the platform reads the manifest and nothing else: no file of `actions/`
// is given to a browser and none is read again.
//
// The build runs without the instance, so it checks what the files say among themselves. What
// only the instance knows, whether a Connection or a Data Store exists and what effect an
// operation was accepted with, is checked when the App is written and published and again at
// every call. Whether a Workflow exists, and whether the caller may start it, is asked at
// every call.

/** The folder the action files are in. */
export const APP_ACTIONS_DIRECTORY = "actions/";
/** What the name of an action file ends with. */
export const APP_ACTION_FILE_SUFFIX = ".action.yaml";
/** An action file is a few lines. One larger than this is refused before it is parsed. */
export const APP_ACTION_FILE_MAX_BYTES = 64 * 1024;
/** How many named actions one Page has. */
export const APP_MAX_ACTIONS = 100;

const actionFileFields = {
  description: z.string().max(APP_ACTION_DESCRIPTION_MAX_CHARS).optional(),
  policy: z.enum(APP_ACTION_POLICY_VALUES).optional(),
  input: z
    .strictObject({
      schema: appActionInputSchemaSchema.optional(),
      mapping: z.record(z.string(), z.unknown()).optional()
    })
    .optional()
};

/** An action file that calls an operation of a Connection. */
const connectionActionFileSchema = z.strictObject({
  connection: z.string().min(1).max(64),
  operation: z.string().min(1).max(128),
  effect: z.enum(["reading", "changing"]),
  ...actionFileFields
});

/**
 * An action file that starts a Workflow. It names no effect: a start always changes
 * something. The mapping makes the input of the run.
 */
const workflowActionFileSchema = z.strictObject({
  workflow: z.string().min(1).max(64),
  ...actionFileFields
});

export type CompiledActions =
  | { status: "compiled"; actions: CompiledAppAction[] }
  | { status: "errors"; errors: PageBuildError[] };

/** The endings an action file has, each with the kind of action it defines. */
const ACTION_FILE_KINDS = [
  { suffix: APP_ACTION_FILE_SUFFIX, kind: "connection" },
  { suffix: APP_SQL_ACTION_FILE_SUFFIX, kind: "sql" }
] as const;

type ManifestAction = NonNullable<PageManifest["actions"]>[number];

interface ActionFile {
  file: PageFile;
  /** The name the file gives its action: its own, without the folder and the ending. */
  name: string;
  kind: CompiledAppAction["kind"];
}

/** A file of `actions/` as an action file, or nothing for a file that is none. */
function actionFileOf(file: PageFile): ActionFile | undefined {
  if (!file.path.startsWith(APP_ACTIONS_DIRECTORY)) return undefined;
  const found = ACTION_FILE_KINDS.find(({ suffix }) => file.path.endsWith(suffix));
  return (
    found && {
      file,
      name: file.path.slice(APP_ACTIONS_DIRECTORY.length, -found.suffix.length),
      kind: found.kind
    }
  );
}

/**
 * Compiles the action files of a Page against its manifest. It answers every action, or every
 * fault an author has to fix, each with its file.
 */
export function compileActions(
  manifest: PageManifest,
  files: readonly PageFile[]
): CompiledActions {
  const errors: PageBuildError[] = [];
  const actions: CompiledAppAction[] = [];
  const declared = new Set(manifest.connections ?? []);
  const entries = new Map((manifest.actions ?? []).map((entry) => [entry.name, entry]));
  const actionFiles = files
    .flatMap((file) => actionFileOf(file) ?? [])
    .sort((left, right) =>
      left.file.path < right.file.path ? -1 : left.file.path > right.file.path ? 1 : 0
    );

  if (actionFiles.length > APP_MAX_ACTIONS) {
    return {
      status: "errors",
      errors: [
        {
          file: PAGE_MANIFEST_FILE,
          code: "action_invalid",
          message: `The Page has ${actionFiles.length} actions. It has at most ${APP_MAX_ACTIONS} (APP_MAX_ACTIONS).`
        }
      ]
    };
  }

  const defined = new Set<string>();
  for (const { file, name, kind } of actionFiles) {
    if (defined.has(name)) {
      errors.push({
        file: file.path,
        code: "action_invalid",
        message: `Two files define the action '${name}'. A name is one action: keep one of the files.`
      });
      continue;
    }
    defined.add(name);
    const compiled =
      kind === "sql"
        ? compileSqlActionFile(file, name, entries.get(name), manifest)
        : compileActionFile(file, name, declared, manifest.kit);
    if ("errors" in compiled) {
      errors.push(...compiled.errors);
    } else {
      actions.push(compiled.action);
    }
  }
  errors.push(
    ...declarationErrors(manifest, actions, new Set(actionFiles.map(({ file }) => file.path)))
  );
  return errors.length > 0 ? { status: "errors", errors } : { status: "compiled", actions };
}

/**
 * What the manifest says about actions, held against the files. A file defines its action. A
 * line under `actions` of the manifest names one of them: for a `connection` or a `workflow`
 * action it may, and must then say the same as the file; for an `sql` action it must, because
 * the statement says nothing of its effect.
 */
function declarationErrors(
  manifest: PageManifest,
  actions: readonly CompiledAppAction[],
  actionFiles: ReadonlySet<string>
): PageBuildError[] {
  const errors: PageBuildError[] = [];
  const fail = (message: string, code: PageBuildError["code"] = "action_invalid") =>
    errors.push({ file: PAGE_MANIFEST_FILE, code, message });
  const byName = new Map(actions.map((action) => [action.name, action]));
  for (const entry of manifest.actions ?? []) {
    const file = entry.file ?? `${APP_ACTIONS_DIRECTORY}${entry.name}${APP_ACTION_FILE_SUFFIX}`;
    if (entry.cache !== undefined) {
      fail(
        `The action '${entry.name}' asks for a cache. Results of actions are not cached yet: remove 'cache'.`,
        "cache_not_available"
      );
    }
    const suffix = ACTION_FILE_KINDS.find((known) => file.endsWith(known.suffix))?.suffix;
    if (suffix === undefined) {
      fail(
        `The action '${entry.name}' names '${file}'. An action is a file '${APP_ACTIONS_DIRECTORY}<name>${APP_ACTION_FILE_SUFFIX}' that calls an operation of a Connection or starts a Workflow, or a file '${APP_ACTIONS_DIRECTORY}<name>${APP_SQL_ACTION_FILE_SUFFIX}' that reads a Data Store; no other kind of action exists yet.`
      );
      continue;
    }
    if (file !== `${APP_ACTIONS_DIRECTORY}${entry.name}${suffix}`) {
      fail(
        `The action '${entry.name}' names '${file}'. Its file is '${APP_ACTIONS_DIRECTORY}${entry.name}${suffix}': an action has the name of its file.`
      );
      continue;
    }
    const action = byName.get(entry.name);
    if (!action) {
      if (!actionFiles.has(file)) {
        fail(`The action '${entry.name}' names '${file}', which is not a file of the Page.`);
      }
      continue;
    }
    // An `sql` action was compiled from this line, so there is nothing to hold it against.
    if (action.kind === "sql" || action.file !== file) continue;
    if (entry.effect !== action.effect) {
      fail(
        action.kind === "workflow"
          ? `The manifest calls the action '${entry.name}' ${entry.effect}. It starts a Workflow, which always changes something: say 'effect: changing' or leave the line out.`
          : `The manifest calls the action '${entry.name}' ${entry.effect} and '${file}' calls it ${action.effect}. Say it once, in the file.`
      );
    }
    if (entry.connection !== undefined) {
      if (action.kind === "workflow") {
        fail(
          `The manifest names the Connection '${entry.connection}' for the action '${entry.name}', which starts the Workflow '${action.workflow}' and calls no Connection. Remove 'connection'.`
        );
      } else if (entry.connection !== action.connection) {
        fail(
          `The manifest names the Connection '${entry.connection}' for the action '${entry.name}' and '${file}' names '${action.connection}'.`
        );
      }
    }
    if (entry.policy !== undefined && entry.policy !== action.policy) {
      fail(
        `The manifest gives the action '${entry.name}' the policy '${entry.policy}' and '${file}' ${action.policy ? `gives it '${action.policy}'` : "gives it none"}. Say it once, in the file.`
      );
    }
  }
  return errors;
}

/** The part of JSON Schema each declared type of a statement's parameter is. */
const SQL_PARAMETER_SCHEMAS = {
  text: { type: "string" },
  integer: { type: "integer" },
  number: { type: "number" },
  boolean: { type: "boolean" },
  date: { type: "string", format: "date" },
  timestamp: { type: "string", format: "date-time" }
} as const;

function sqlParameterSchema(
  type: SqlActionParameter["type"]
): AppActionInputSchema["properties"][string] {
  const scalar = DATA_STORE_SCALAR_TYPES.find((candidate) => candidate === type);
  if (scalar !== undefined) return SQL_PARAMETER_SCHEMAS[scalar];
  const items = DATA_STORE_SCALAR_TYPES.find((candidate) => `${candidate}[]` === type);
  return { type: "array", items: SQL_PARAMETER_SCHEMAS[items ?? "text"] };
}

/**
 * Compiles one statement file with the line of the manifest that declares it. What the line
 * asks for that an `sql` action cannot be yet is refused with the reason, at the manifest.
 */
function compileSqlActionFile(
  file: PageFile,
  name: string,
  entry: ManifestAction | undefined,
  manifest: PageManifest
): { action: CompiledAppAction } | { errors: PageBuildError[] } {
  const inFile = (message: string, line?: number): PageBuildError => ({
    file: file.path,
    code: "action_invalid",
    message,
    ...(line === undefined ? {} : { line })
  });
  if (!APP_ACTION_NAME_PATTERN.test(name)) {
    return {
      errors: [
        inFile(
          `'${name}' cannot be the name of an action. A name has lowercase letters, digits, '-' and '_', at most 63, and the file is '${APP_ACTIONS_DIRECTORY}<name>${APP_SQL_ACTION_FILE_SUFFIX}'.`
        )
      ]
    };
  }
  if (entry?.file !== file.path) {
    return {
      errors: [
        inFile(
          `The statement has no line under 'actions' in ${PAGE_MANIFEST_FILE}. Add '{ name: ${name}, file: ${file.path}, effect: reading }': the manifest says what a statement does.`
        )
      ]
    };
  }
  const errors: PageBuildError[] = [];
  const inManifest = (message: string, code: PageBuildError["code"] = "action_invalid") =>
    errors.push({ file: PAGE_MANIFEST_FILE, code, message });
  if (entry.connection !== undefined) {
    inManifest(
      `The action '${name}' names the Connection '${entry.connection}'. A statement on a Connection is not available yet: an sql action reads the Data Store the manifest lists. Remove 'connection'.`,
      "sql_target_not_available"
    );
  }
  const policy = APP_ACTION_POLICY_VALUES.find((value) => value === entry.policy);
  if (entry.policy !== undefined && policy === undefined) {
    inManifest(
      `The action '${name}' asks for the policy '${entry.policy}'. A policy of a manifest tightens what the instance says: it is one of ${APP_ACTION_POLICY_VALUES.join(", ")}.`
    );
  }
  const [store, ...furtherStores] = manifest.dataStores ?? [];
  if (store === undefined) {
    inManifest(
      `The action '${name}' reads a Data Store and the manifest lists no Data Store. Add it under 'dataStores' in ${PAGE_MANIFEST_FILE}: a Page reaches what its manifest names and nothing else.`,
      "data_store_not_declared"
    );
  } else if (furtherStores.length > 0) {
    inManifest(
      `The action '${name}' reads a Data Store and the manifest lists ${furtherStores.length + 1}. An action cannot name its Data Store yet, so a manifest with sql actions lists one.`
    );
  }
  if (file.bytes.byteLength > APP_SQL_ACTION_FILE_MAX_BYTES) {
    errors.push(
      inFile(
        `The statement file has ${file.bytes.byteLength} bytes. It has at most ${APP_SQL_ACTION_FILE_MAX_BYTES} (APP_SQL_ACTION_FILE_MAX_BYTES).`
      )
    );
    return { errors };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    errors.push(inFile("The statement file is not UTF-8 text."));
    return { errors };
  }
  const compiled = compileSqlStatement(text, entry.effect);
  if ("faults" in compiled) {
    errors.push(
      ...compiled.faults.map(({ message, line, notAllowed }) => ({
        ...inFile(message, line),
        ...(notAllowed ? { code: "sql_statement_not_allowed" as const } : {})
      }))
    );
  }
  if (errors.length > 0 || "faults" in compiled || store === undefined) {
    return { errors };
  }
  const required = compiled.parameters.filter(({ optional }) => !optional).map(({ name }) => name);
  return {
    action: {
      name,
      kind: "sql",
      file: file.path,
      ...(policy === undefined ? {} : { policy }),
      dataStore: store.name,
      ...(compiled.effect === "reading"
        ? { effect: compiled.effect, statement: compiled.statement }
        : { effect: compiled.effect, insert: compiled.insert }),
      parameters: compiled.parameters.map(({ name: parameter, type }) => ({
        name: parameter,
        type
      })),
      input: {
        schema: {
          type: "object",
          properties: Object.fromEntries(
            compiled.parameters.map(({ name: parameter, type }) => [
              parameter,
              sqlParameterSchema(type)
            ])
          ),
          ...(required.length > 0 ? { required } : {})
        }
      }
    }
  };
}

function compileActionFile(
  file: PageFile,
  name: string,
  declaredConnections: ReadonlySet<string>,
  kitVersion: string
): { action: CompiledAppAction } | { errors: PageBuildError[] } {
  const fail = (
    message: string,
    code: PageBuildError["code"] = "action_invalid",
    line?: number
  ): { errors: PageBuildError[] } => ({
    errors: [{ file: file.path, code, message, ...(line ? { line } : {}) }]
  });
  if (!APP_ACTION_NAME_PATTERN.test(name)) {
    return fail(
      `'${name}' cannot be the name of an action. A name has lowercase letters, digits, '-' and '_', at most 63, and the file is '${APP_ACTIONS_DIRECTORY}<name>${APP_ACTION_FILE_SUFFIX}'.`
    );
  }
  if (file.bytes.byteLength > APP_ACTION_FILE_MAX_BYTES) {
    return fail(
      `The action file has ${file.bytes.byteLength} bytes. It has at most ${APP_ACTION_FILE_MAX_BYTES} (APP_ACTION_FILE_MAX_BYTES).`
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    return fail("The action file is not UTF-8 text.");
  }
  const read = readYamlData(text, file.path, { refuseAliases: true });
  if (!read.ok) {
    return fail(read.issue.message, "action_invalid", read.issue.line);
  }
  const value = read.value;
  const issues = (error: z.ZodError, keys: string) => ({
    errors: error.issues.map((issue) => ({
      file: file.path,
      code: "action_invalid" as const,
      message: describeIssue(issue, keys)
    }))
  });
  // The key `workflow` makes the file one that starts a Workflow.
  if (typeof value === "object" && value !== null && "workflow" in value) {
    const parsed = workflowActionFileSchema.safeParse(value);
    if (!parsed.success) {
      return issues(
        parsed.error,
        "An action file that starts a Workflow holds workflow, description, policy and input with schema and mapping."
      );
    }
    const { workflow, description, policy } = parsed.data;
    if (!kitStartsWorkflows(kitVersion)) {
      return fail(
        `The action starts the Workflow '${workflow}', and the manifest names kit ${kitVersion}. An App that starts a Workflow names kit ${KIT_WORKFLOW_ACTIONS_SINCE} or later in ${PAGE_MANIFEST_FILE}.`
      );
    }
    const input = readInput(parsed.data.input);
    return "message" in input
      ? fail(input.message)
      : {
          action: {
            name,
            kind: "workflow",
            file: file.path,
            effect: "changing",
            ...(description === undefined ? {} : { description }),
            ...(policy === undefined ? {} : { policy }),
            workflow,
            input
          }
        };
  }
  const parsed = connectionActionFileSchema.safeParse(value);
  if (!parsed.success) {
    return issues(
      parsed.error,
      "An action file holds connection, operation, effect, description, policy and input with schema and mapping, or workflow in place of connection, operation and effect."
    );
  }
  const { connection, operation, effect, description, policy } = parsed.data;
  if (!declaredConnections.has(connection)) {
    return fail(
      `The action calls the Connection '${connection}', which the manifest does not list. Add it under 'connections' in ${PAGE_MANIFEST_FILE}: a Page reaches what its manifest names and nothing else.`,
      "connection_not_declared"
    );
  }
  const input = readInput(parsed.data.input);
  if ("message" in input) {
    return fail(input.message);
  }
  return {
    action: {
      name,
      kind: "connection",
      file: file.path,
      effect,
      ...(description === undefined ? {} : { description }),
      ...(policy === undefined ? {} : { policy }),
      connection,
      operation,
      input
    }
  };
}

/** The schema and the mapping of an action file, read against each other. */
function readInput(
  input: { schema?: AppActionInputSchema; mapping?: Record<string, unknown> } | undefined
): { schema: AppActionInputSchema; mapping: JsonObject } | { message: string } {
  const schema = input?.schema ?? { type: "object" as const, properties: {} };
  const unknownRequired = (schema.required ?? []).filter(
    (parameter) => !Object.hasOwn(schema.properties, parameter)
  );
  if (unknownRequired.length > 0) {
    return {
      message: `'input.schema.required' names ${unknownRequired.map((parameter) => `'${parameter}'`).join(", ")}, which 'input.schema.properties' does not hold.`
    };
  }
  const mapping = readMapping(input?.mapping ?? {}, new Set(Object.keys(schema.properties)));
  return "message" in mapping ? mapping : { schema, mapping: mapping.value };
}

/**
 * The mapping as JSON, with every text read: a placeholder names a parameter of the schema, a
 * text with braces that is no placeholder is an expression and is refused.
 */
function readMapping(
  mapping: Record<string, unknown>,
  parameters: ReadonlySet<string>
): { value: JsonObject } | { message: string } {
  let nodes = 0;
  let fault: string | undefined;
  const read = (value: unknown, path: string, depth: number): JsonValue => {
    nodes += 1;
    if (fault !== undefined) return null;
    if (nodes > APP_ACTION_MAPPING_MAX_NODES) {
      fault = `'input.mapping' holds more than ${APP_ACTION_MAPPING_MAX_NODES} values (APP_ACTION_MAPPING_MAX_NODES).`;
      return null;
    }
    if (depth > APP_ACTION_MAPPING_MAX_DEPTH) {
      fault = `'input.mapping' nests deeper than ${APP_ACTION_MAPPING_MAX_DEPTH} levels (APP_ACTION_MAPPING_MAX_DEPTH).`;
      return null;
    }
    if (typeof value === "string") {
      const text = readMappingText(value);
      if (text.kind === "expression") {
        fault = `'${path}' holds '${value}'. A mapping holds fixed values and placeholders of the form '{{parameter}}', one per value. It computes nothing.`;
      } else if (text.kind === "placeholder" && !parameters.has(text.parameter)) {
        fault = `'${path}' holds the placeholder '{{${text.parameter}}}', and 'input.schema.properties' has no parameter '${text.parameter}'.`;
      }
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((entry, index) => read(entry, `${path}[${index}]`, depth + 1));
    }
    if (typeof value === "object") {
      const object: JsonObject = {};
      for (const [key, entry] of Object.entries(value)) {
        Object.defineProperty(object, key, {
          value: read(entry, `${path}.${key}`, depth + 1),
          enumerable: true,
          writable: true
        });
      }
      return object;
    }
    fault = `'${path}' holds a value that is not JSON.`;
    return null;
  };
  const value: JsonObject = {};
  for (const [key, entry] of Object.entries(mapping)) {
    Object.defineProperty(value, key, {
      value: read(entry, `input.mapping.${key}`, 1),
      enumerable: true,
      writable: true
    });
  }
  return fault === undefined ? { value } : { message: fault };
}

function describeIssue(issue: z.core.$ZodIssue, keys: string): string {
  if (issue.code === "unrecognized_keys") {
    const where = issue.path.length > 0 ? ` under '${issue.path.join(".")}'` : "";
    return `Unknown key${issue.keys.length > 1 ? "s" : ""} ${issue.keys.map((key) => `'${key}'`).join(", ")}${where}. ${keys}`;
  }
  const key = issue.path.length > 0 ? `'${issue.path.join(".")}'` : "The action file";
  return `${key}: ${issue.message}`;
}
