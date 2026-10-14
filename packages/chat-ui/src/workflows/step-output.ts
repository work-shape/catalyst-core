import type { WorkflowOutputPreview } from "./workflow-views";

/** How many rows of a step's output the panel shows. */
const OUTPUT_ROWS = 8;
/** How many columns: the panel is narrow, and the rest is in the technical details. */
const OUTPUT_COLUMNS = 3;

/** The start of a step's output as rows, where the output is a list of records. */
export interface StepOutputRows {
  columns: readonly string[];
  rows: readonly (readonly string[])[];
  /**
   * How many rows the output has. Absent where the preview was cut: a step run carries the
   * start of its output and no count, so the number of a long list is not known here.
   */
  total: number | undefined;
}

type Row = Record<string, unknown>;

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsed(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

/**
 * A preview is the first characters of the output, so a long list ends in the middle of a
 * record. Its whole records are what stands before the last closing brace.
 */
function wholeRecords(text: string): unknown {
  for (let end = text.lastIndexOf("}"); end > 0; end = text.lastIndexOf("}", end - 1)) {
    const start = text.slice(0, end + 1);
    const value = parsed(`${start}]`) ?? parsed(`${start}]}`);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/** The list of an output: the output itself, or the one list an object holds. */
function listOf(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const lists = Object.values(value).filter((field) => Array.isArray(field));
  return lists.length === 1 ? lists[0] : undefined;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** A field's name as a column head: `client_since` and `clientSince` read "Client since". */
function columnName(field: string): string {
  const words = field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The rows the panel shows of what a step returned. A step run carries the start of its output
 * as text (`outputPreview`); where that is a list of records the reader sees a table instead of
 * JSON. Anything else, such as one record or a sentence, has no rows.
 */
export function stepOutputRows(output: WorkflowOutputPreview): StepOutputRows | undefined {
  const whole = parsed(output.text);
  const list = listOf(whole ?? (output.truncated ? wholeRecords(output.text) : undefined));
  if (list === undefined || list.length === 0 || !list.every(isRecord)) {
    return undefined;
  }
  const records = list.filter(isRecord);
  const fields = Object.keys(records[0] ?? {}).slice(0, OUTPUT_COLUMNS);
  if (fields.length === 0) {
    return undefined;
  }
  return {
    columns: fields.map(columnName),
    rows: records.slice(0, OUTPUT_ROWS).map((record) => fields.map((field) => cell(record[field]))),
    total: output.truncated || whole === undefined ? undefined : records.length
  };
}

/** What a simulated step of a test run would have done, as the panel says it in sentences. */
export interface SimulatedCall {
  operation: string;
  /** The values it would have sent, by the operation's own field names, as text. */
  values: readonly (readonly [string, string])[];
  /** Whether the live call would have waited for a confirmation or for an approval. */
  wouldAsk?: "confirmation" | "approval";
}

/**
 * The call a simulated step would have made, read from its output: the engine answers it as
 * `{ wouldHaveDone: { operation, input?, wouldAsk? } }`. Nothing where the preview was cut
 * before it could be read whole, or where the output is of another shape.
 */
export function simulatedCall(
  output: WorkflowOutputPreview | undefined
): SimulatedCall | undefined {
  if (output === undefined || output.truncated) {
    return undefined;
  }
  const value = parsed(output.text);
  const done = isRecord(value) ? value.wouldHaveDone : undefined;
  if (!isRecord(done) || typeof done.operation !== "string") {
    return undefined;
  }
  const input = isRecord(done.input) ? done.input : {};
  const wouldAsk =
    done.wouldAsk === "approval" || done.wouldAsk === "confirmation" ? done.wouldAsk : undefined;
  return {
    operation: done.operation,
    values: Object.entries(input).map(
      ([name, item]) => [name, typeof item === "string" ? item : JSON.stringify(item)] as const
    ),
    ...(wouldAsk === undefined ? {} : { wouldAsk })
  };
}
