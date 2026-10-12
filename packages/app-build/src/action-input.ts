import { APP_ACTION_NAME_PATTERN, type JsonObject, type JsonValue } from "@vivd-catalyst/core";
import { z } from "zod";

// A named action as the build compiled it, and what the platform does with one at a call: read
// the caller's parameters against the action's schema and put them into the input of the
// operation the action stands for. Nothing here evaluates anything: a parameter is put where
// its placeholder stood, as the value it is, and no text of an author is run.

/** How many parameters one action takes. */
export const APP_ACTION_MAX_PARAMETERS = 50;
/** How many values the mapping of one action holds, objects, lists and leaves together. */
export const APP_ACTION_MAPPING_MAX_NODES = 500;
/** How deep the mapping of one action nests. */
export const APP_ACTION_MAPPING_MAX_DEPTH = 16;
/** The longest description of an action or of one of its parameters. */
export const APP_ACTION_DESCRIPTION_MAX_CHARS = 2000;

const parameterName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u, "letters, digits and '_', at most 63");
const description = z.string().max(APP_ACTION_DESCRIPTION_MAX_CHARS).optional();

const scalarParameter = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("string"),
    description,
    minLength: z.number().int().min(0).optional(),
    maxLength: z.number().int().min(0).optional(),
    enum: z.array(z.string()).min(1).max(200).optional()
  }),
  z.strictObject({
    type: z.enum(["integer", "number"]),
    description,
    minimum: z.number().optional(),
    maximum: z.number().optional()
  }),
  z.strictObject({ type: z.literal("boolean"), description })
]);

const parameter = z.union([
  scalarParameter,
  z.strictObject({
    type: z.literal("array"),
    description,
    items: scalarParameter,
    maxItems: z.number().int().min(0).optional()
  })
]);

/**
 * What an action takes: named parameters that are text, numbers, booleans or lists of them.
 * It is JSON Schema, the part of it an action needs, so the same object describes the action
 * to an agent that carries it as a tool. A key that is not listed here is refused.
 */
export const appActionInputSchemaSchema = z.strictObject({
  type: z.literal("object"),
  properties: z
    .record(parameterName, parameter)
    .refine((value) => Object.keys(value).length <= APP_ACTION_MAX_PARAMETERS, {
      message: `at most ${APP_ACTION_MAX_PARAMETERS} parameters (APP_ACTION_MAX_PARAMETERS)`
    }),
  required: z.array(parameterName).max(APP_ACTION_MAX_PARAMETERS).optional(),
  additionalProperties: z.literal(false).optional()
});

export type AppActionInputSchema = z.infer<typeof appActionInputSchemaSchema>;

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue)
  ])
);

/** The policy values an action may ask for. Each can only tighten what the instance says. */
export const APP_ACTION_POLICY_VALUES = ["confirm", "approval", "deny"] as const;

/**
 * One named action as the build wrote it into the manifest. `connection` actions are the only
 * kind today: the action stands for one operation of one Connection the manifest lists.
 */
export const compiledAppActionSchema = z.strictObject({
  name: z.string().regex(APP_ACTION_NAME_PATTERN),
  kind: z.literal("connection"),
  /** The file of the Page the action was compiled from. */
  file: z.string().min(1).max(512),
  effect: z.enum(["reading", "changing"]),
  description,
  policy: z.enum(APP_ACTION_POLICY_VALUES).optional(),
  connection: z.string().min(1).max(64),
  operation: z.string().min(1).max(128),
  input: z.strictObject({
    schema: appActionInputSchemaSchema,
    mapping: z.record(z.string(), jsonValue)
  })
});

export type CompiledAppAction = z.infer<typeof compiledAppActionSchema>;

/**
 * The compiled actions of a stored manifest. A manifest is kept as its build wrote it, so
 * nothing here trusts its shape: an entry that is no compiled action is left out. A manifest
 * of a build before named actions lists none.
 */
export function compiledActionsOf(manifest: unknown): CompiledAppAction[] {
  const read = z.object({ actions: z.array(z.unknown()) }).safeParse(manifest);
  if (!read.success) return [];
  return read.data.actions.flatMap((entry) => {
    const action = compiledAppActionSchema.safeParse(entry);
    return action.success ? [action.data] : [];
  });
}

/** The Connections a stored manifest lists. */
export function declaredConnectionsOf(manifest: unknown): string[] {
  const read = z.object({ connections: z.array(z.string()) }).safeParse(manifest);
  return read.success ? read.data.connections : [];
}

const PLACEHOLDER = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,62})\s*\}\}$/u;

/**
 * What a text of a mapping is: the place of one parameter, a text that is passed on as it is,
 * or something that looks like more than a placeholder and is refused by the build.
 */
export function readMappingText(
  text: string
): { kind: "placeholder"; parameter: string } | { kind: "literal" } | { kind: "expression" } {
  const placeholder = PLACEHOLDER.exec(text);
  if (placeholder?.[1] !== undefined) {
    return { kind: "placeholder", parameter: placeholder[1] };
  }
  return text.includes("{{") || text.includes("}}") ? { kind: "expression" } : { kind: "literal" };
}

function scalarAsZod(definition: z.infer<typeof scalarParameter>): z.ZodType {
  switch (definition.type) {
    case "string": {
      if (definition.enum) return z.enum(definition.enum);
      let text = z.string();
      if (definition.minLength !== undefined) text = text.min(definition.minLength);
      if (definition.maxLength !== undefined) text = text.max(definition.maxLength);
      return text;
    }
    case "integer":
    case "number": {
      let number = definition.type === "integer" ? z.number().int() : z.number().finite();
      if (definition.minimum !== undefined) number = number.min(definition.minimum);
      if (definition.maximum !== undefined) number = number.max(definition.maximum);
      return number;
    }
    case "boolean":
      return z.boolean();
  }
}

/** The check of a call's parameters against the schema of its action. Unknown names are refused. */
export function appActionInputAsZod(schema: AppActionInputSchema): z.ZodType<JsonObject> {
  const required = new Set(schema.required ?? []);
  const shape: Record<string, z.ZodType> = {};
  for (const [name, definition] of Object.entries(schema.properties)) {
    const value =
      definition.type === "array"
        ? definition.maxItems === undefined
          ? z.array(scalarAsZod(definition.items))
          : z.array(scalarAsZod(definition.items)).max(definition.maxItems)
        : scalarAsZod(definition);
    shape[name] = required.has(name) ? value : value.optional();
  }
  return z.strictObject(shape).pipe(z.record(z.string(), jsonValue));
}

/**
 * The input of the operation an action stands for: the mapping with each placeholder replaced
 * by the value of its parameter. A parameter the caller left out leaves out the key, or the
 * list entry, its placeholder stood in.
 */
export function applyAppActionMapping(mapping: JsonObject, parameters: JsonObject): JsonObject {
  const absent = Symbol("absent");
  const fill = (value: JsonValue): JsonValue | typeof absent => {
    if (typeof value === "string") {
      const read = readMappingText(value);
      if (read.kind !== "placeholder") return value;
      const given = Object.hasOwn(parameters, read.parameter)
        ? parameters[read.parameter]
        : undefined;
      return given === undefined ? absent : given;
    }
    if (Array.isArray(value)) {
      return value.flatMap((entry) => {
        const filled = fill(entry);
        return filled === absent ? [] : [filled];
      });
    }
    if (typeof value === "object" && value !== null) {
      return fillObject(value);
    }
    return value;
  };
  const fillObject = (value: JsonObject): JsonObject => {
    const filled: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      const next = entry === undefined ? absent : fill(entry);
      if (next !== absent) {
        Object.defineProperty(filled, key, { value: next, enumerable: true, writable: true });
      }
    }
    return filled;
  };
  return fillObject(mapping);
}
