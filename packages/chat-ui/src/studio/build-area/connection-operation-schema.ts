// What one accepted operation of a Connection calls and takes, as its page lists it: the request
// a REST API declares in the definition, or the input schema an MCP server named. Pure and
// bounded: every value comes from outside the instance, so a member of the wrong shape is
// passed over, long texts are cut, and no more than a fixed number of parameters, values and
// schema nodes is read. Nothing here is rendered as markup; the page shows each text as text.

/** Where a parameter goes: into the path, into the query, or into the tool's input. */
export type ParameterLocation = "path" | "query" | "input";

/** The constraints of a schema the page names in words, in this order. */
export const PARAMETER_CONSTRAINTS = [
  "minimum",
  "exclusiveMinimum",
  "maximum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "format",
  "pattern",
  "default"
] as const;
export type ParameterConstraintKey = (typeof PARAMETER_CONSTRAINTS)[number];

export interface OperationParameter {
  /** The member's name; a nested one is named by its path, such as `address.city`. */
  name: string;
  location: ParameterLocation;
  /** The JSON types the value may have, such as `string`. Empty where the schema names none. */
  types: string[];
  /** For a list: the types of its items. */
  itemTypes: string[];
  required: boolean;
  description?: string;
  /** The values the schema allows, where it lists them. */
  values: string[];
  /** The schema lists more values than `values` holds. */
  moreValues: boolean;
  /** For a list: the values each of its entries may have, where its item schema lists them. */
  itemValues: string[];
  /** The item schema lists more values than `itemValues` holds. */
  moreItemValues: boolean;
  constraints: { key: ParameterConstraintKey; value: string }[];
}

export interface OperationDeclaration {
  /** For a REST API: the method and the path relative to the Connection's address. */
  request?: { method: string; path: string };
  parameters: OperationParameter[];
  /** The declaration has more parameters than the page lists. */
  moreParameters: boolean;
  /**
   * The declaration says the operation takes nothing. Where it lists no parameter and this is
   * false, its inputs are written in a way the page does not list, such as `allOf` or `$ref`.
   */
  takesNothing: boolean;
  /** The declaration as JSON, for "Technical details": whole, unless it is over `RAW_MAX_CHARS`. */
  raw: string;
  /** `raw` was cut at `RAW_MAX_CHARS` and is not the whole declaration. */
  rawCut: boolean;
}

/** How many parameters one operation lists at most. */
export const PARAMETERS_MAX = 40;
/** How many allowed values one parameter lists at most. */
export const VALUES_MAX = 20;
/** How long one text from outside is at most as the page shows it. */
export const TEXT_MAX_CHARS = 300;
/**
 * How long the declaration under "Technical details" is at most, as pretty-printed JSON. A
 * generous display bound: a longer one is cut there, and the page says it was cut.
 */
export const RAW_MAX_CHARS = 1_000_000;
/** How deep members of members are listed. */
const DEPTH_MAX = 3;
/** How many schema nodes one operation reads at most, whatever their shape. */
const NODES_MAX = 400;

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

/** A text cut to `max` characters, with an ellipsis where it was cut. */
export function cut(text: string, max = TEXT_MAX_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? cut(value.trim()) : undefined;
}

/** A value of a schema as a person reads it: a text as it is, anything else as JSON. */
function valueText(value: unknown): string {
  if (typeof value === "string") return cut(value, 100);
  try {
    return cut(JSON.stringify(value) ?? String(value), 100);
  } catch {
    return "…";
  }
}

/** The JSON for "Technical details", cut where it is over the bound, or nothing. */
function rawOf(value: unknown): { raw: string; rawCut: boolean } {
  try {
    const raw = JSON.stringify(value, null, 2) ?? "";
    return raw.length <= RAW_MAX_CHARS
      ? { raw, rawCut: false }
      : { raw: raw.slice(0, RAW_MAX_CHARS), rawCut: true };
  } catch {
    return { raw: "", rawCut: false };
  }
}

/** The values a schema and its first-level branches allow, as a person reads them. */
function allowedOf(sources: readonly Record<string, unknown>[]): unknown[] {
  const allowed: unknown[] = [];
  for (const source of sources) {
    if (Array.isArray(source.enum)) allowed.push(...source.enum.slice(0, VALUES_MAX + 1));
    if ("const" in source) allowed.push(source.const);
  }
  return allowed;
}

/** Counts the schema nodes read, so a schema of any size costs a fixed amount. */
interface Budget {
  nodes: number;
}

function typesOf(schema: Record<string, unknown>): string[] {
  const { type } = schema;
  if (typeof type === "string") return [cut(type, 40)];
  if (Array.isArray(type)) {
    return type
      .filter((entry): entry is string => typeof entry === "string")
      .slice(0, 4)
      .map((entry) => cut(entry, 40));
  }
  return [];
}

/** The branches of `anyOf` and `oneOf`, the first level only. */
function branchesOf(schema: Record<string, unknown>, budget: Budget): Record<string, unknown>[] {
  const branches: Record<string, unknown>[] = [];
  for (const key of ["anyOf", "oneOf"]) {
    const list = schema[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list.slice(0, 8)) {
      const branch = recordOf(entry);
      if (branch === undefined || budget.nodes >= NODES_MAX) continue;
      budget.nodes += 1;
      branches.push(branch);
    }
  }
  return branches;
}

/** One parameter of a schema: its types, allowed values and constraints, in words. */
function parameterOf(
  name: string,
  location: ParameterLocation,
  schemaValue: unknown,
  required: boolean,
  description: string | undefined,
  budget: Budget
): OperationParameter {
  const schema = recordOf(schemaValue) ?? {};
  budget.nodes += 1;
  const branches = branchesOf(schema, budget);
  const types = [...new Set([...typesOf(schema), ...branches.flatMap(typesOf)])].slice(0, 4);
  const allowed = allowedOf([schema, ...branches]);
  const values = [...new Set(allowed.map(valueText))];
  const items = recordOf(schema.items);
  const itemValues = items ? [...new Set(allowedOf([items]).map(valueText))] : [];
  const constraints = PARAMETER_CONSTRAINTS.flatMap((key) => {
    const value = schema[key];
    return value === undefined || value === null ? [] : [{ key, value: valueText(value) }];
  });
  // A type the schema leaves out is read from the values it allows.
  const derived =
    types.length === 0 && allowed.length > 0
      ? [...new Set(allowed.map((value) => (value === null ? "null" : typeof value)))]
      : types;
  const said = description ?? textOf(schema.description);
  return {
    name,
    location,
    types: derived,
    itemTypes: items ? typesOf(items) : [],
    required,
    ...(said === undefined ? {} : { description: said }),
    values: values.slice(0, VALUES_MAX),
    moreValues: values.length > VALUES_MAX,
    itemValues: itemValues.slice(0, VALUES_MAX),
    moreItemValues: itemValues.length > VALUES_MAX,
    constraints
  };
}

/** The required members of an object schema, by name. */
function requiredOf(schema: Record<string, unknown>): Set<string> {
  const { required } = schema;
  return new Set(
    Array.isArray(required)
      ? required.filter((entry): entry is string => typeof entry === "string")
      : []
  );
}

/**
 * The members of an object schema as parameters, and the members of members to `DEPTH_MAX`.
 * A member's member is required where its parent is and its parent requires it.
 */
function membersOf(
  schema: Record<string, unknown>,
  prefix: string,
  parentRequired: boolean,
  depth: number,
  into: OperationParameter[],
  budget: Budget
): boolean {
  const properties = recordOf(schema.properties);
  if (properties === undefined) return false;
  const required = requiredOf(schema);
  for (const [key, value] of Object.entries(properties)) {
    if (into.length >= PARAMETERS_MAX || budget.nodes >= NODES_MAX) return true;
    const name = prefix === "" ? cut(key, 80) : `${prefix}.${cut(key, 80)}`;
    const isRequired = parentRequired && required.has(key);
    into.push(parameterOf(name, "input", value, isRequired, undefined, budget));
    const member = recordOf(value);
    if (member === undefined || depth + 1 >= DEPTH_MAX) continue;
    const items = recordOf(member.items);
    const nested = recordOf(member.properties)
      ? member
      : items && recordOf(items.properties)
        ? items
        : undefined;
    if (nested === undefined) continue;
    const more = membersOf(
      nested,
      nested === member ? name : `${name}[]`,
      isRequired,
      depth + 1,
      into,
      budget
    );
    if (more) return true;
  }
  return false;
}

/**
 * An input schema that says the tool takes nothing: a closed object (`additionalProperties:
 * false`) that declares no member, requires none and is built from no `allOf`, `anyOf`, `oneOf`,
 * `$ref` or `patternProperties`. Any other schema without listed members takes inputs the page
 * does not list.
 */
function takesNothing(schema: Record<string, unknown>): boolean {
  const properties = recordOf(schema.properties);
  const declaresNone =
    schema.properties === undefined ||
    (properties !== undefined && Object.keys(properties).length === 0);
  const requiresNone = !Array.isArray(schema.required) || schema.required.length === 0;
  return (
    declaresNone &&
    requiresNone &&
    schema.additionalProperties === false &&
    ["allOf", "anyOf", "oneOf", "$ref", "patternProperties"].every((key) => !(key in schema))
  );
}

/**
 * The parameters an MCP tool takes, from the input schema its server named. Nothing where
 * the server named none or named something that is no object.
 */
export function mcpOperationDeclaration(inputSchema: unknown): OperationDeclaration | undefined {
  const schema = recordOf(inputSchema);
  if (schema === undefined) return undefined;
  const parameters: OperationParameter[] = [];
  const more = membersOf(schema, "", true, 0, parameters, { nodes: 0 });
  return {
    parameters,
    moreParameters: more,
    takesNothing: parameters.length === 0 && takesNothing(schema),
    ...rawOf(schema)
  };
}

/** The declaration of one accepted operation in a REST API's definition, by its name. */
function declaredOperation(
  config: Record<string, unknown>,
  name: string
): Record<string, unknown> | undefined {
  const { operations } = config;
  if (!Array.isArray(operations)) return undefined;
  for (const entry of operations) {
    const operation = recordOf(entry);
    if (operation?.name === name) return operation;
  }
  return undefined;
}

/** The members of a declaration the page shows under "Technical details". */
const DECLARATION_FIELDS = ["method", "path", "pathParams", "query"] as const;

/**
 * What a REST API's operation sends, read from the definition the page has: its method and
 * path, each path parameter, required, and each query parameter. Nothing where the definition
 * declares no such operation.
 */
export function httpOperationDeclaration(
  config: Record<string, unknown>,
  name: string
): OperationDeclaration | undefined {
  const operation = declaredOperation(config, name);
  if (operation === undefined) return undefined;
  const budget: Budget = { nodes: 0 };
  const parameters: OperationParameter[] = [];
  let more = false;
  for (const [field, location] of [
    ["pathParams", "path"],
    ["query", "query"]
  ] as const) {
    for (const [key, value] of Object.entries(recordOf(operation[field]) ?? {})) {
      if (parameters.length >= PARAMETERS_MAX || budget.nodes >= NODES_MAX) {
        more = true;
        break;
      }
      const parameter = recordOf(value) ?? {};
      parameters.push(
        parameterOf(
          cut(key, 80),
          location,
          parameter.schema,
          location === "path" || parameter.required === true,
          textOf(parameter.description),
          budget
        )
      );
    }
  }
  const method = typeof operation.method === "string" ? operation.method : "GET";
  const path = typeof operation.path === "string" ? operation.path : "";
  const shown = Object.fromEntries(
    DECLARATION_FIELDS.filter((field) => operation[field] !== undefined).map((field) => [
      field,
      operation[field]
    ])
  );
  return {
    request: { method: cut(method.toUpperCase(), 12), path: cut(path, 500) },
    parameters,
    moreParameters: more,
    // A REST API's operation sends what its path and query declare, and nothing else.
    takesNothing: parameters.length === 0,
    ...rawOf(shown)
  };
}
