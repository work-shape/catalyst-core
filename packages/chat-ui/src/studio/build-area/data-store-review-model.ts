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

/** A value as the page shows it: text as it is, anything else as its JSON. */
export function reviewValueText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * The value a person typed, of the kind the candidate holds: a number where the candidate is
 * one, read with a decimal comma too, yes or no where it is one, and text otherwise. Nothing
 * where the text is not of that kind.
 */
export function reviewValueOf(
  text: string,
  like: unknown
): { value: JsonValue } | { invalid: "number" | "boolean" | "empty" } {
  const trimmed = text.trim();
  if (trimmed === "") return { invalid: "empty" };
  if (typeof like === "number") {
    const compact = trimmed.replace(/\s/gu, "");
    // "1.234,5" as German writes it, and "1234.5" as JSON does.
    const number = Number(
      compact.includes(",") ? compact.replace(/\./gu, "").replace(",", ".") : compact
    );
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
