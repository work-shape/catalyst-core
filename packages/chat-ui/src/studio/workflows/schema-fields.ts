import type { FieldListItem } from "@work-shape/catalyst-ui";
import { keyFrom } from "./step-edits";

// What an AI step or a script answers with, as the Settings tab edits it (workflow-canvas 9.4,
// WF-EDIT-2): a list of named fields in the subset of JSON Schema every model binding takes,
// and back. A field holds text, a number, a whole number, yes or no, one of a few choices, a
// list of texts, a record of fields or a list of records; a record's fields hold no record, so
// no answer nests itself. A schema outside the subset is not a list of fields: the form shows
// it read-only and leaves it to the agent.

/** The kinds of a field, by the value `FieldListEditor` names them with. */
const ANSWER_FIELD_KINDS = [
  "text",
  "number",
  "integer",
  "boolean",
  "choice",
  "list",
  "record",
  "records"
] as const;

export type AnswerFieldKind = (typeof ANSWER_FIELD_KINDS)[number];

type Schema = Record<string, unknown>;

function isRecord(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The keys a field's schema may hold for the form to read it. */
const FIELD_KEYS: ReadonlySet<string> = new Set([
  "type",
  "title",
  "description",
  "enum",
  "items",
  "properties",
  "required",
  "additionalProperties"
]);

const onlyKeys = (schema: Schema) => Object.keys(schema).every((key) => FIELD_KEYS.has(key));

/** What a person calls a field: its title, or its key where it has none. */
const titleOf = (name: string, schema: Schema) =>
  typeof schema.title === "string" && schema.title.trim() !== "" ? schema.title : name;

const description = (schema: Schema) =>
  typeof schema.description === "string" && schema.description !== ""
    ? { description: schema.description }
    : {};

/** A field of a scalar kind or a list of texts, or nothing where the schema is no such field. */
function flatKind(schema: Schema): { kind: AnswerFieldKind; choices?: string[] } | undefined {
  if (!onlyKeys(schema) || schema.properties !== undefined) return undefined;
  if (Array.isArray(schema.enum)) {
    const choices = schema.enum;
    return schema.type === "string" &&
      choices.length > 0 &&
      choices.every((choice) => typeof choice === "string")
      ? { kind: "choice", choices }
      : undefined;
  }
  switch (schema.type) {
    case "string":
      return { kind: "text" };
    case "number":
      return { kind: "number" };
    case "integer":
      return { kind: "integer" };
    case "boolean":
      return { kind: "boolean" };
    case "array": {
      const items = isRecord(schema.items) ? schema.items : undefined;
      return items !== undefined &&
        items.type === "string" &&
        items.enum === undefined &&
        Object.keys(items).every((key) => key === "type" || key === "description")
        ? { kind: "list" }
        : undefined;
    }
    default:
      return undefined;
  }
}

/** The named fields of an object schema, each read by `field`; nothing where one is not. */
function fieldsOf(
  schema: Schema,
  idPrefix: string,
  field: (name: string, schema: Schema, id: string) => FieldListItem | undefined
): FieldListItem[] | undefined {
  if (!onlyKeys(schema) || schema.type !== "object") return undefined;
  const properties = schema.properties ?? {};
  if (!isRecord(properties)) return undefined;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const items: FieldListItem[] = [];
  for (const [name, value] of Object.entries(properties)) {
    if (!isRecord(value)) return undefined;
    const item = field(name, value, `${idPrefix}${name}`);
    if (item === undefined) return undefined;
    items.push({ ...item, required: required.includes(name) });
  }
  return items;
}

/** A field of a record: no record or list of records inside it. */
function innerField(name: string, schema: Schema, id: string): FieldListItem | undefined {
  const flat = flatKind(schema);
  return flat === undefined
    ? undefined
    : {
        id,
        name,
        title: titleOf(name, schema),
        kind: flat.kind,
        required: false,
        ...description(schema),
        ...(flat.choices === undefined ? {} : { choices: flat.choices })
      };
}

function outerField(name: string, schema: Schema, id: string): FieldListItem | undefined {
  const flat = innerField(name, schema, id);
  if (flat !== undefined) return flat;
  if (schema.type === "object") {
    const fields = fieldsOf(schema, `${id}.`, innerField);
    return fields === undefined
      ? undefined
      : {
          id,
          name,
          title: titleOf(name, schema),
          kind: "record",
          required: false,
          ...description(schema),
          fields
        };
  }
  if (schema.type === "array" && onlyKeys(schema) && isRecord(schema.items)) {
    const fields = fieldsOf(schema.items, `${id}.`, innerField);
    return fields === undefined
      ? undefined
      : {
          id,
          name,
          title: titleOf(name, schema),
          kind: "records",
          required: false,
          ...description(schema),
          fields
        };
  }
  return undefined;
}

/**
 * The fields of an answer's schema, or nothing where the schema is outside the subset the form
 * edits. No schema is an answer of no fields yet.
 */
export function schemaFields(schema: unknown): FieldListItem[] | undefined {
  if (schema === undefined) return [];
  return isRecord(schema) ? fieldsOf(schema, "", outerField) : undefined;
}

/** Why one field cannot be saved yet: it has no title, its key is taken twice, or no choice. */
type FieldProblem = { title?: "missing"; name?: "taken"; choices?: "missing" };

/** Why a list of fields cannot be saved yet, by field id: a title missing or a key twice. */
export function fieldListProblems(items: readonly FieldListItem[]): Record<string, FieldProblem> {
  const problems: Record<string, FieldProblem> = {};
  const visit = (list: readonly FieldListItem[]) => {
    const seen = new Set<string>();
    for (const item of list) {
      const name = item.name.trim();
      const problem: FieldProblem = {};
      if ((item.title ?? "").trim() === "") problem.title = "missing";
      else if (seen.has(name)) problem.name = "taken";
      seen.add(name);
      if (
        item.kind === "choice" &&
        (item.choices ?? []).filter((choice) => choice.trim() !== "").length === 0
      ) {
        problem.choices = "missing";
      }
      if (Object.keys(problem).length > 0) problems[item.id] = problem;
      if (item.fields !== undefined) visit(item.fields);
    }
  };
  visit(items);
  return problems;
}

/**
 * The title a field's schema holds: the one a person gave, but not a title that only repeats
 * the key of a field that had none, so a schema the agent wrote without titles stays so.
 */
function titleSchema(item: FieldListItem, previous: unknown): Schema {
  const title = (item.title ?? "").trim();
  const before = previousField(previous, item.name);
  const had = isRecord(before) && typeof before.title === "string";
  return title === "" || (title === item.name.trim() && !had) ? {} : { title };
}

function fieldSchema(item: FieldListItem, previous: unknown): Schema {
  const said = item.description?.trim() ? { description: item.description.trim() } : {};
  const head = { ...titleSchema(item, previous), ...said };
  switch (item.kind) {
    case "choice":
      return {
        type: "string",
        ...head,
        enum: (item.choices ?? []).map((choice) => choice.trim()).filter((choice) => choice !== "")
      };
    case "list":
      return { type: "array", ...head, items: { type: "string" } };
    case "record":
      return { ...objectOf(item.fields ?? [], previousField(previous, item.name)), ...head };
    case "records": {
      const before = previousField(previous, item.name);
      return {
        type: "array",
        ...head,
        items: objectOf(item.fields ?? [], isRecord(before) ? before.items : undefined)
      };
    }
    case "number":
    case "integer":
    case "boolean":
      return { type: item.kind, ...head };
    default:
      return { type: "string", ...head };
  }
}

function previousField(previous: unknown, name: string): unknown {
  const properties = isRecord(previous) ? previous.properties : undefined;
  return isRecord(properties) ? properties[name.trim()] : undefined;
}

function objectOf(items: readonly FieldListItem[], previous: unknown): Schema {
  const named = items.filter((item) => item.name.trim() !== "");
  const required = named.filter((item) => item.required).map((item) => item.name.trim());
  return {
    type: "object",
    properties: Object.fromEntries(
      named.map((item) => [item.name.trim(), fieldSchema(item, previous)])
    ),
    ...(required.length === 0 ? {} : { required }),
    ...(isRecord(previous) && previous.additionalProperties !== undefined
      ? { additionalProperties: previous.additionalProperties }
      : {})
  };
}

/** The schema of a record's fields, or of the records of a list, in a field's schema. */
function innerSchema(field: unknown): unknown {
  if (!isRecord(field)) return undefined;
  return field.type === "array" ? field.items : field;
}

/** The keys an object schema holds. */
function keysOf(schema: unknown): ReadonlySet<string> {
  const properties = isRecord(schema) ? schema.properties : undefined;
  return new Set(isRecord(properties) ? Object.keys(properties) : []);
}

/**
 * The fields with their keys (WF-EDIT-5c): a field the saved schema holds keeps its key, as
 * later steps and the start form name it by that key; a new field's key comes from its title,
 * as a new step's id comes from its name, and follows the title until the field is saved.
 */
export function withKeys(items: readonly FieldListItem[], saved: unknown): FieldListItem[] {
  const savedKeys = keysOf(saved);
  const kept = new Set(items.filter((item) => savedKeys.has(item.name)).map((item) => item.name));
  const taken = new Set(kept);
  return items.map((item) => {
    const fixed = kept.has(item.name);
    const title = (item.title ?? "").trim();
    // A new field without a title has no key yet: it is not written, and its save is held.
    const name = fixed
      ? item.name
      : title === ""
        ? ""
        : keyFrom(title, taken, { fallback: "field", hyphen: false });
    if (name !== "") taken.add(name);
    const savedField =
      fixed && isRecord(saved) && isRecord(saved.properties) ? saved.properties[name] : undefined;
    return {
      ...item,
      name,
      ...(item.fields === undefined
        ? {}
        : { fields: withKeys(item.fields, innerSchema(savedField)) })
    };
  });
}

/**
 * The schema of an answer of these fields. `previous` is the schema they were read from: whether
 * a record takes more fields stays as it said. A field with no
 * name is left out; `fieldListProblems` holds the save back until it has one.
 */
export function fieldsSchema(items: readonly FieldListItem[], previous?: unknown): Schema {
  const said = isRecord(previous)
    ? Object.fromEntries(
        (["title", "description"] as const).flatMap((key) =>
          typeof previous[key] === "string" ? [[key, previous[key]]] : []
        )
      )
    : {};
  return { ...objectOf(items, previous), ...said };
}
