import {
  WORKFLOW_MARKDOWN_MAX_COLUMNS,
  WORKFLOW_MARKDOWN_MAX_ROWS,
  WORKFLOW_TEXT_FORMAT_MARKDOWN,
  type JsonObject,
  type JsonValue,
  type WorkflowInputText,
  type WorkflowInputValue,
  type WorkflowReference
} from "@work-shape/catalyst-core";
import { jsonObjectSchema } from "./json";
import { WorkflowStepFailure } from "./step-failure";

// Text joined from parts (EW-TEXT): `{ text: [...] }` in a step's input mapping. The parts are
// literal strings and references, joined in order. In a field whose schema declares
// `format: markdown` a referenced list of strings joins as a bulleted list, a list of flat
// records as a table, and every referenced value is escaped, so a value cannot add a link, an
// image or formatting. Spec: events-workflows-and-guardrails.md, Step inputs, outputs and
// references.

/** The code of a step whose joined text does not fit its field. */
export const WORKFLOW_TEXT_INPUT_INVALID = "input_invalid";

/** The reason a save or publish refuses a text mapping with, naming the step, field and part. */
export const WORKFLOW_TEXT_PART_INVALID = "text_part_invalid";

export function isTextValue(source: WorkflowInputValue): source is WorkflowInputText {
  return source.text !== undefined;
}

/** The references of a mapped value; for a text, each with the number of its part from 1. */
export function sourceReferences(
  source: WorkflowInputValue
): { ref: WorkflowReference; part?: number }[] {
  if (source.ref) return [{ ref: source.ref }];
  if (!isTextValue(source)) return [];
  return source.text.flatMap((part, position) =>
    typeof part === "string" ? [] : [{ ref: part.ref, part: position + 1 }]
  );
}

/** Whether a field's schema takes Markdown, such as the body of `mail.send`. */
export function isMarkdownField(schema: JsonObject | undefined): boolean {
  return schema?.format === WORKFLOW_TEXT_FORMAT_MARKDOWN;
}

// Every ASCII punctuation character, which CommonMark lets a backslash make literal.
const MARKDOWN_PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/gu;
const LINE_BREAK = /\r\n|\r|\n/gu;
const LEADING_SPACE = /^[ \t]+/u;

/**
 * A value as Markdown text: each punctuation character escaped, leading spaces as character
 * references so they indent nothing. A line break is a hard break inside a paragraph, so no
 * blank line starts a block; in a table cell or a list item it is a space.
 */
export function escapeMarkdownText(value: string, within: "text" | "cell" = "text"): string {
  const escaped = value
    .replace(MARKDOWN_PUNCTUATION, (character) => `\\${character}`)
    .replace(LEADING_SPACE, (space) =>
      [...space].map((character) => (character === "\t" ? "&#9;" : "&#32;")).join("")
    );
  return escaped.replace(LINE_BREAK, within === "cell" ? " " : "\\\n");
}

type Scalar = string | number | boolean | null;

function isScalar(value: JsonValue): value is Scalar {
  return value === null || typeof value !== "object";
}

function scalarText(value: Scalar): string {
  return value === null ? "" : String(value);
}

function isDatasetReference(value: JsonValue): boolean {
  return (
    value !== null && typeof value === "object" && !Array.isArray(value) && "$dataset" in value
  );
}

function typesOf(schema: JsonObject): string[] {
  const { type } = schema;
  if (typeof type === "string") return [type];
  return Array.isArray(type)
    ? type.filter((entry): entry is string => typeof entry === "string")
    : [];
}

const SCALAR_TYPES = ["string", "number", "integer", "boolean", "null"];

/** The properties of a record schema, in their order; undefined where it declares none. */
function columnsOf(schema: JsonObject | undefined): { key: string; title: string }[] | undefined {
  const properties = jsonObjectSchema.safeParse(schema?.properties).data;
  if (!properties) return undefined;
  return Object.entries(properties).map(([key, property]) => {
    const title = jsonObjectSchema.safeParse(property).data?.title;
    return { key, title: typeof title === "string" && title.trim() !== "" ? title : key };
  });
}

/**
 * Why a referenced part does not fit a text, by the schema of what it names; undefined where
 * it fits or the schema says nothing. A Markdown field also takes a list of scalars and a list
 * of flat records of at most `WORKFLOW_MARKDOWN_MAX_COLUMNS` fields.
 */
export function textPartSchemaIssue(
  schema: JsonObject | undefined,
  markdown: boolean
): string | undefined {
  if (!schema) return undefined;
  const types = typesOf(schema);
  if (types.includes("dataset"))
    return markdown
      ? "references a dataset, which a Markdown field does not take; a code step makes a table of it"
      : "references a dataset, which is no text";
  if (types.includes("object")) return "references an object, which is no text";
  if (!types.includes("array")) return undefined;
  if (!markdown) return "references a list, which only a Markdown field joins";
  const items = jsonObjectSchema.safeParse(schema.items).data;
  const itemTypes = items ? typesOf(items) : [];
  if (itemTypes.includes("array") || itemTypes.includes("dataset"))
    return "references a list of lists, which joins as no list and no table";
  if (!itemTypes.includes("object")) return undefined;
  const columns = columnsOf(items) ?? [];
  if (columns.length > WORKFLOW_MARKDOWN_MAX_COLUMNS)
    return `references records of ${columns.length} fields; a table has at most ${WORKFLOW_MARKDOWN_MAX_COLUMNS} columns`;
  const properties = jsonObjectSchema.safeParse(items?.properties).data ?? {};
  for (const property of Object.values(properties)) {
    const fieldTypes = typesOf(jsonObjectSchema.safeParse(property).data ?? {});
    if (fieldTypes.some((type) => !SCALAR_TYPES.includes(type)))
      return "references records whose fields are not all flat, which join as no table";
  }
  return undefined;
}

/** One part of a text to join: a literal, or what a reference named with its schema. */
export type TextPartValue =
  { literal: string } | { value: JsonValue; part: number; schema?: JsonObject };

/** What the joined text goes into: its field's name, whether it is Markdown, and its limit. */
export interface TextField {
  name: string;
  schema?: JsonObject;
}

function refuse(field: string, part: number, why: string): never {
  throw new WorkflowStepFailure(WORKFLOW_TEXT_INPUT_INVALID, `Part ${part} of '${field}' ${why}`);
}

function bulletList(items: readonly Scalar[]): string {
  return items.map((item) => `- ${escapeMarkdownText(scalarText(item), "cell")}`).join("\n");
}

function table(
  field: string,
  part: number,
  rows: readonly JsonValue[],
  schema: JsonObject | undefined
): string {
  const records = rows.map((row) => {
    if (row === null || typeof row !== "object" || Array.isArray(row) || isDatasetReference(row))
      refuse(field, part, "is a list that mixes records with other values");
    return row;
  });
  const declared = columnsOf(jsonObjectSchema.safeParse(schema?.items).data);
  // A stored output keeps no order of its keys, so without a row schema the order is by name.
  const columns =
    declared ??
    [...new Set(records.flatMap((record) => Object.keys(record)))]
      .sort()
      .map((key) => ({ key, title: key }));
  if (columns.length > WORKFLOW_MARKDOWN_MAX_COLUMNS)
    refuse(
      field,
      part,
      `is a list of records of ${columns.length} fields; a table has at most ${WORKFLOW_MARKDOWN_MAX_COLUMNS} columns`
    );
  if (columns.length === 0) return "";
  const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  const body = records.map((record) =>
    line(
      columns.map(({ key }) => {
        const cell = Object.hasOwn(record, key) ? record[key] : null;
        if (cell === undefined || !isScalar(cell))
          refuse(field, part, "is a list of records whose fields are not all flat");
        return escapeMarkdownText(scalarText(cell), "cell");
      })
    )
  );
  return [
    line(columns.map(({ title }) => escapeMarkdownText(title, "cell"))),
    line(columns.map(() => "---")),
    ...body
  ].join("\n");
}

/** A referenced list in a Markdown field: a bulleted list, or a table of flat records. */
function markdownBlock(
  field: string,
  part: number,
  items: readonly JsonValue[],
  schema: JsonObject | undefined
): string {
  if (items.length > WORKFLOW_MARKDOWN_MAX_ROWS)
    refuse(field, part, `is a list of more than ${WORKFLOW_MARKDOWN_MAX_ROWS} rows`);
  if (items.length === 0) return "";
  if (items.every(isScalar)) return bulletList(items);
  return table(field, part, items, schema);
}

/**
 * The text a `{ text }` mapping joins to. A referenced part is a string, a number or a
 * yes-or-no value, and `null` joins as empty text; in a Markdown field it is escaped, and a
 * list joins as a block of its own. A joined text longer than the field's `maxLength` fails the
 * step with `input_invalid`. No message holds a value.
 */
export function joinText(field: TextField, parts: readonly TextPartValue[]): string {
  const markdown = isMarkdownField(field.schema);
  let joined = "";
  let afterBlock = false;
  for (const part of parts) {
    let piece: string;
    let block = false;
    if ("literal" in part) piece = part.literal;
    else if (isScalar(part.value))
      piece = markdown ? escapeMarkdownText(scalarText(part.value)) : scalarText(part.value);
    else if (isDatasetReference(part.value))
      refuse(
        field.name,
        part.part,
        markdown
          ? "is a dataset, which a Markdown field does not take; a code step makes a table of it"
          : "is a dataset, which is no text"
      );
    else if (Array.isArray(part.value)) {
      if (!markdown) refuse(field.name, part.part, "is a list, which only a Markdown field joins");
      piece = markdownBlock(field.name, part.part, part.value, part.schema);
      block = piece !== "";
    } else refuse(field.name, part.part, "is an object, which is no text");
    if (piece === "") continue;
    // A list or a table stands apart from the text around it by a blank line.
    if ((block || afterBlock) && joined !== "" && !joined.endsWith("\n\n"))
      joined += joined.endsWith("\n") ? "\n" : "\n\n";
    joined += afterBlock && !block ? piece.replace(/^\n+/u, "") : piece;
    afterBlock = block;
  }
  const { maxLength } = field.schema ?? {};
  if (typeof maxLength === "number" && [...joined].length > maxLength)
    throw new WorkflowStepFailure(
      WORKFLOW_TEXT_INPUT_INVALID,
      `The text joined for '${field.name}' is longer than the ${maxLength} characters the field allows`
    );
  return joined;
}
