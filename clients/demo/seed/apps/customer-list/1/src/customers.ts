// What the tile reads of the answer of `list_customers`. The answer comes from outside, so
// every field is checked before it is shown.
export type Segment = "retail" | "hospitality" | "office";

export interface Customer {
  id: string;
  name: string;
  segment: Segment;
  city: string;
}

export interface CustomerPage {
  rows: Customer[];
  total: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSegment(value: unknown): value is Segment {
  return value === "retail" || value === "hospitality" || value === "office";
}

function readCustomer(value: unknown): Customer | undefined {
  if (!isRecord(value)) return undefined;
  const { id, name, segment, city } = value;
  return typeof id === "string" &&
    typeof name === "string" &&
    isSegment(segment) &&
    typeof city === "string"
    ? { id, name, segment, city }
    : undefined;
}

/**
 * The page of customers in the result of the action, or nothing when it is no such answer. An
 * MCP Connection answers `{ content, structuredContent }`; the page is the `structuredContent`.
 */
export function readCustomerPage(result: unknown): CustomerPage | undefined {
  const value = isRecord(result) ? result.structuredContent : undefined;
  if (!isRecord(value) || !Array.isArray(value.rows) || typeof value.total !== "number") {
    return undefined;
  }
  const rows: Customer[] = [];
  for (const row of value.rows) {
    const customer = readCustomer(row);
    if (!customer) return undefined;
    rows.push(customer);
  }
  return { rows, total: value.total };
}
