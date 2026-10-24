import type { JsonValue } from "@work-shape/catalyst-core";
import type { DataStoreFlaggedItem } from "./data-store-source";

/** What `JSON.parse` answered, as the JSON value it is. */
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && Object.values(value).every(isJsonValue);
}

// "Prüfen" groups the candidates the instance lists one by one: each object with its flagged
// fields, each field with its candidates side by side, and apart the documents whose object is
// not known, each with the fields it would write.

type Reason = DataStoreFlaggedItem["reason"];
export type FieldReason = Exclude<Reason, "key_unresolved">;

/** One flagged field of one object, with every candidate the page holds for it. */
export interface ReviewField {
  name: string;
  reason: FieldReason;
  candidates: DataStoreFlaggedItem[];
}

/** One object, by its table and key, with its flagged fields. */
export interface ReviewObject {
  table: string;
  key: string | number | boolean;
  fields: ReviewField[];
}

/** One document whose object is not known, with the fields it would write into one. */
export interface ReviewDocument {
  table: string;
  knowledgeBaseId: string;
  documentId: string;
  fileName: string | undefined;
  fields: DataStoreFlaggedItem[];
}

export interface ReviewGroups {
  objects: ReviewObject[];
  documents: ReviewDocument[];
  /** How many fields wait: each flagged field of an object, and each field of a document. */
  fieldCount: number;
}

/** The candidates in the instance's order, grouped by object and field, and by document. */
export function groupFlagged(items: readonly DataStoreFlaggedItem[]): ReviewGroups {
  const objects = new Map<string, ReviewObject>();
  const fields = new Map<string, ReviewField>();
  const documents = new Map<string, ReviewDocument>();
  for (const item of items) {
    if (item.reason === "key_unresolved" || item.key === null) {
      const id = JSON.stringify([item.table, item.knowledgeBaseId, item.documentId]);
      const document = documents.get(id) ?? {
        table: item.table,
        knowledgeBaseId: item.knowledgeBaseId,
        documentId: item.documentId,
        fileName: item.document?.fileName,
        fields: []
      };
      document.fields.push(item);
      documents.set(id, document);
      continue;
    }
    const objectId = JSON.stringify([item.table, item.key]);
    const object = objects.get(objectId) ?? { table: item.table, key: item.key, fields: [] };
    objects.set(objectId, object);
    const fieldId = JSON.stringify([item.table, item.key, item.name]);
    let field = fields.get(fieldId);
    if (!field) {
      field = { name: item.name, reason: item.reason, candidates: [] };
      fields.set(fieldId, field);
      object.fields.push(field);
    }
    field.candidates.push(item);
  }
  const documentList = [...documents.values()];
  return {
    objects: [...objects.values()],
    documents: documentList,
    fieldCount:
      fields.size + documentList.reduce((count, document) => count + document.fields.length, 0)
  };
}

/**
 * A value as the page shows it: a number the way the reader's language writes it, text as it
 * is, anything else as its JSON. `grouping: false` writes a number without thousands
 * separators, as a field to edit holds it.
 */
export function reviewValueText(
  value: unknown,
  locale?: string,
  options: { grouping?: boolean } = {}
): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && locale !== undefined)
    return new Intl.NumberFormat(locale, {
      maximumFractionDigits: 20,
      // Four digits stay whole, so a year reads 1987 and not 1.987.
      useGrouping: options.grouping === false ? false : "min2"
    }).format(value);
  return JSON.stringify(value);
}

/** A number as a person writes it in their language: "1.234,5" in German, "1,234.5" in English. */
function numberOf(text: string, locale: string): number {
  const compact = text.replace(/\s/gu, "");
  const german = locale.startsWith("de");
  const group = german ? "." : ",";
  const grouped = (german ? /^-?\d{1,3}(\.\d{3})+(,\d+)?$/u : /^-?\d{1,3}(,\d{3})+(\.\d+)?$/u).test(
    compact
  );
  const plain = grouped ? compact.replaceAll(group, "") : compact;
  // A decimal comma is read in either language where no group separator stands.
  return Number(plain.replace(",", "."));
}

/**
 * The value a person typed, of the kind the candidate holds: a number where the candidate is
 * one, written as their language writes it, yes or no where it is one, and text otherwise.
 * Nothing where the text is not of that kind.
 */
export function reviewValueOf(
  text: string,
  like: unknown,
  locale = "en"
): { value: JsonValue } | { invalid: "number" | "boolean" | "empty" } {
  const trimmed = text.trim();
  if (trimmed === "") return { invalid: "empty" };
  if (typeof like === "number") {
    const number = numberOf(trimmed, locale);
    return Number.isFinite(number) ? { value: number } : { invalid: "number" };
  }
  if (typeof like === "boolean") {
    const lower = trimmed.toLowerCase();
    if (["true", "yes", "ja"].includes(lower)) return { value: true };
    if (["false", "no", "nein"].includes(lower)) return { value: false };
    return { invalid: "boolean" };
  }
  if (typeof like === "string" || like === null) return { value: text };
  // A list or an object is typed as its JSON; anything that is not JSON stays text.
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return { value: isJsonValue(parsed) ? parsed : text };
  } catch {
    return { value: text };
  }
}
