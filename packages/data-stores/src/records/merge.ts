import type {
  DataStoreRecordProposalItem,
  DataStoreRecordField,
  DataStoreRecordsRule,
  DataStoreColumn,
  JsonValue,
  RecordEvidenceResult
} from "@work-shape/catalyst-core";

export interface Candidate {
  value: JsonValue;
  kind: string;
  documentDate: string | null;
  state: DataStoreRecordField["state"];
  evidence: RecordEvidenceResult;
}

/** Capture a single path segment literally; a path prefix may precede a filename. */
export function recordKey(
  rule: DataStoreRecordsRule,
  item: DataStoreRecordProposalItem,
  column: DataStoreColumn
): string | number | boolean | null {
  let value: JsonValue | undefined;
  if ("fromPath" in rule.key && item.path) {
    const [before = "", after = ""] = rule.key.fromPath.split(`{${rule.key.column}}`);
    if (item.path.startsWith(before)) {
      const rest = item.path.slice(before.length);
      const end = after ? rest.indexOf(after) : rest.length;
      const captured = end < 0 ? "" : rest.slice(0, end);
      if (captured && !captured.includes("/")) value = captured;
    }
  } else if ("fromField" in rule.key) {
    const fromField = rule.key.fromField;
    value = item.fields.find((field) => field.name === fromField)?.value;
  }
  return coerceRecordKey(column, value);
}

/**
 * A key as the key column holds it, or null: a number or a boolean column also takes its text,
 * as a path segment and a person's assignment give it.
 */
export function coerceRecordKey(
  column: Pick<DataStoreColumn, "type">,
  value: JsonValue | undefined
): string | number | boolean | null {
  if (typeof value === "string" && value !== "") {
    if (column.type === "integer" || column.type === "number") {
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value)) return null;
      value = Number(value);
    } else if (column.type === "boolean") {
      if (value !== "true" && value !== "false") return null;
      value = value === "true";
    }
  }
  if (column.type === "integer")
    return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
  if (column.type === "number")
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  if (column.type === "boolean") return typeof value === "boolean" ? value : null;
  return typeof value === "string" && value !== "" ? value : null;
}

/** Equal rank/date disagreement has no winner, independently of arrival order. */
export function mergeField(
  rule: DataStoreRecordsRule,
  field: string,
  candidates: readonly Candidate[]
): { value: JsonValue; conflict: boolean } {
  const pinned = candidates.filter(
    (candidate) => candidate.state === "confirmed" || candidate.state === "corrected"
  );
  const eligible = pinned.length
    ? pinned
    : rule.review.always.includes(field)
      ? []
      : candidates.filter((candidate) => candidate.evidence.status === "passed");
  const rank = (candidate: Candidate) => {
    const index = rule.precedence.indexOf(candidate.kind);
    return index < 0 ? rule.precedence.length : index;
  };
  const ordered = [...eligible].sort(
    (left, right) =>
      rank(left) - rank(right) || (right.documentDate ?? "").localeCompare(left.documentDate ?? "")
  );
  const first = ordered[0];
  if (!first) return { value: null, conflict: false };
  const peers = pinned.length
    ? pinned
    : ordered.filter(
        (candidate) =>
          rank(candidate) === rank(first) && candidate.documentDate === first.documentDate
      );
  const conflict = peers.some(
    (candidate) => JSON.stringify(candidate.value) !== JSON.stringify(first.value)
  );
  return { value: conflict ? null : first.value, conflict };
}
