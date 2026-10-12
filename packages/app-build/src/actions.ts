import { APP_ACTION_NAME_PATTERN, type JsonObject, type JsonValue } from "@vivd-catalyst/core";
import { load, JSON_SCHEMA, YAMLException } from "js-yaml";
import { z } from "zod";
import {
  APP_ACTION_DESCRIPTION_MAX_CHARS,
  APP_ACTION_MAPPING_MAX_DEPTH,
  APP_ACTION_MAPPING_MAX_NODES,
  APP_ACTION_POLICY_VALUES,
  appActionInputSchemaSchema,
  readMappingText,
  type CompiledAppAction
} from "./action-input";
import type { PageBuildError } from "./errors";
import { PAGE_MANIFEST_FILE, type PageManifest } from "./manifest";
import type { PageFile } from "./types";

// The named actions of a Page: one file `actions/<name>.action.yaml` each. An action says
// which operation of which Connection it stands for, what the browser may pass, and where each
// parameter goes in the operation's input. The build reads the file as data and writes the
// action into the manifest. At a call the platform reads the manifest and nothing else: no
// file of `actions/` is given to a browser and none is read again.
//
// The build runs without the instance, so it checks what the files say among themselves. What
// only the instance knows, whether the Connection exists and what effect its operation was
// accepted with, is checked when the App is written and again at every call.

/** The folder the action files are in. */
export const APP_ACTIONS_DIRECTORY = "actions/";
/** What the name of an action file ends with. */
export const APP_ACTION_FILE_SUFFIX = ".action.yaml";
/** An action file is a few lines. One larger than this is refused before it is parsed. */
export const APP_ACTION_FILE_MAX_BYTES = 64 * 1024;
/** How many named actions one Page has. */
export const APP_MAX_ACTIONS = 100;

const actionFileSchema = z.strictObject({
  connection: z.string().min(1).max(64),
  operation: z.string().min(1).max(128),
  effect: z.enum(["reading", "changing"]),
  description: z.string().max(APP_ACTION_DESCRIPTION_MAX_CHARS).optional(),
  policy: z.enum(APP_ACTION_POLICY_VALUES).optional(),
  input: z
    .strictObject({
      schema: appActionInputSchemaSchema.optional(),
      mapping: z.record(z.string(), z.unknown()).optional()
    })
    .optional()
});

export type CompiledActions =
  | { status: "compiled"; actions: CompiledAppAction[] }
  | { status: "errors"; errors: PageBuildError[] };

/** The name an action file gives its action, or nothing for a file that is no action file. */
function actionNameOf(path: string): string | undefined {
  if (!path.startsWith(APP_ACTIONS_DIRECTORY) || !path.endsWith(APP_ACTION_FILE_SUFFIX)) {
    return undefined;
  }
  return path.slice(APP_ACTIONS_DIRECTORY.length, -APP_ACTION_FILE_SUFFIX.length);
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
  const actionFiles = files
    .filter((file) => actionNameOf(file.path) !== undefined)
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

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

  for (const file of actionFiles) {
    const compiled = compileActionFile(file, actionNameOf(file.path) ?? "", declared);
    if ("errors" in compiled) {
      errors.push(...compiled.errors);
    } else {
      actions.push(compiled.action);
    }
  }
  errors.push(
    ...declarationErrors(manifest, actions, new Set(actionFiles.map(({ path }) => path)))
  );
  return errors.length > 0 ? { status: "errors", errors } : { status: "compiled", actions };
}

/**
 * What the manifest says about actions, held against the files. The files define the actions;
 * a line under `actions` of the manifest may name one of them and must then say the same.
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
    if (!file.endsWith(APP_ACTION_FILE_SUFFIX)) {
      fail(
        `The action '${entry.name}' names '${file}'. An action is a file '${APP_ACTIONS_DIRECTORY}<name>${APP_ACTION_FILE_SUFFIX}' that calls an operation of a Connection; no other kind of action exists yet.`
      );
      continue;
    }
    if (file !== `${APP_ACTIONS_DIRECTORY}${entry.name}${APP_ACTION_FILE_SUFFIX}`) {
      fail(
        `The action '${entry.name}' names '${file}'. Its file is '${APP_ACTIONS_DIRECTORY}${entry.name}${APP_ACTION_FILE_SUFFIX}': an action has the name of its file.`
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
    if (entry.effect !== action.effect) {
      fail(
        `The manifest calls the action '${entry.name}' ${entry.effect} and '${file}' calls it ${action.effect}. Say it once, in the file.`
      );
    }
    if (entry.connection !== undefined && entry.connection !== action.connection) {
      fail(
        `The manifest names the Connection '${entry.connection}' for the action '${entry.name}' and '${file}' names '${action.connection}'.`
      );
    }
    if (entry.policy !== undefined && entry.policy !== action.policy) {
      fail(
        `The manifest gives the action '${entry.name}' the policy '${entry.policy}' and '${file}' ${action.policy ? `gives it '${action.policy}'` : "gives it none"}. Say it once, in the file.`
      );
    }
  }
  return errors;
}

function compileActionFile(
  file: PageFile,
  name: string,
  declaredConnections: ReadonlySet<string>
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
  let value: unknown;
  try {
    value = load(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes), {
      schema: JSON_SCHEMA,
      filename: file.path
    });
  } catch (error) {
    return error instanceof YAMLException
      ? fail(
          `The action file is not valid YAML: ${error.reason}`,
          "action_invalid",
          error.mark.line + 1
        )
      : fail("The action file is not UTF-8 text.");
  }
  const parsed = actionFileSchema.safeParse(value);
  if (!parsed.success) {
    return {
      errors: parsed.error.issues.map((issue) => ({
        file: file.path,
        code: "action_invalid" as const,
        message: describeIssue(issue)
      }))
    };
  }
  const { connection, operation, effect, description, policy, input } = parsed.data;
  if (!declaredConnections.has(connection)) {
    return fail(
      `The action calls the Connection '${connection}', which the manifest does not list. Add it under 'connections' in ${PAGE_MANIFEST_FILE}: a Page reaches what its manifest names and nothing else.`,
      "connection_not_declared"
    );
  }
  const schema = input?.schema ?? { type: "object" as const, properties: {} };
  const unknownRequired = (schema.required ?? []).filter(
    (parameter) => !Object.hasOwn(schema.properties, parameter)
  );
  if (unknownRequired.length > 0) {
    return fail(
      `'input.schema.required' names ${unknownRequired.map((parameter) => `'${parameter}'`).join(", ")}, which 'input.schema.properties' does not hold.`
    );
  }
  const mapping = readMapping(input?.mapping ?? {}, new Set(Object.keys(schema.properties)));
  if ("message" in mapping) {
    return fail(mapping.message);
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
      input: { schema, mapping: mapping.value }
    }
  };
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

function describeIssue(issue: z.core.$ZodIssue): string {
  if (issue.code === "unrecognized_keys") {
    const where = issue.path.length > 0 ? ` under '${issue.path.join(".")}'` : "";
    return `Unknown key${issue.keys.length > 1 ? "s" : ""} ${issue.keys.map((key) => `'${key}'`).join(", ")}${where}. An action file holds connection, operation, effect, description, policy and input with schema and mapping.`;
  }
  const key = issue.path.length > 0 ? `'${issue.path.join(".")}'` : "The action file";
  return `${key}: ${issue.message}`;
}
