import type { ConnectionDiscoveredTool } from "@work-shape/catalyst-api-client";
import { readYamlData } from "@work-shape/catalyst-core";
import type { ApprovedOperation } from "./connection-form-model";

// The list a person approves the tools of a Connection in, at once: the tools an MCP server
// named, or the operations of a REST API pasted as YAML. Pure: the dialog and the page hold
// the selection, these functions read and make it.

/** The surfaces the one "may use" row opens the approved tools to. `outside` is set on the page. */
export const APPROVAL_SURFACES = ["agent", "bridge", "workflow"] as const;
export type ApprovalSurface = (typeof APPROVAL_SURFACES)[number];

/** Agents may use what is approved, unless the person says otherwise. */
export const DEFAULT_APPROVAL_SURFACES: readonly ApprovalSurface[] = ["agent"];

/** One row of the list: a tool to approve, as the person reads it. */
export interface ApprovalCandidate extends ApprovedOperation {
  /** The name in words. */
  title: string;
  /** As the outside system or the declaration describes it. Untrusted text, shown as text. */
  description?: string;
  /** For a declared operation: its method and path, as the row shows them. */
  request?: { method: string; path: string };
}

/** Every enum in a path or query parameter's schema, including nested schema branches. */
export function parameterEnums(declaration: Record<string, unknown> | undefined) {
  const enums: { location: "pathParams" | "query"; name: string; path: string; values: string }[] =
    [];
  for (const location of ["pathParams", "query"] as const) {
    for (const [name, parameter] of Object.entries(recordOf(declaration?.[location]) ?? {})) {
      const visit = (value: unknown, path: string) => {
        if (Array.isArray(value)) {
          value.forEach((item, index) => visit(item, `${path}[${index}]`));
          return;
        }
        const schema = recordOf(value);
        if (!schema) return;
        for (const [key, child] of Object.entries(schema)) {
          if (key === "enum" && Array.isArray(child)) {
            enums.push({
              location,
              name,
              path,
              values: child
                .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
                .join("\n")
            });
          } else {
            // Walk every branch rather than choosing one anyOf/oneOf alternative. Enum
            // values themselves are data, so their objects are never treated as schemas.
            visit(child, path ? `${path}.${key}` : key);
          }
        }
      };
      visit(recordOf(parameter)?.schema, "");
    }
  }
  return enums;
}

/**
 * An operation as a person reads it: its name in sentence case, such as "List customers" for
 * `list_customers`. The outside system names operations; it gives them no title for people.
 */
export function operationTitle(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[_.-]+/gu, " ")
    .trim()
    .toLowerCase();
  return words === "" ? name : `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`;
}

/** The rows of the tools a discovery read: each with the effect its hint proposes. */
export function discoveredCandidates(
  tools: readonly ConnectionDiscoveredTool[]
): ApprovalCandidate[] {
  return tools.map((tool) => ({
    name: tool.name,
    title: operationTitle(tool.name),
    ...(tool.description === undefined ? {} : { description: tool.description }),
    effect: tool.proposedEffect,
    schemaFingerprint: tool.fingerprint
  }));
}

/**
 * What the list starts with ticked: the tools that only read. For a custom MCP server that is
 * a tool whose `readOnlyHint` is true; the hint is trusted only at this one confirmation.
 */
export function readingNames(candidates: readonly ApprovalCandidate[]): string[] {
  return candidates
    .filter((candidate) => candidate.effect === "reading")
    .map((candidate) => candidate.name);
}

/** The rows the person ticked, in the list's order. */
export function selectedCandidates(
  candidates: readonly ApprovalCandidate[],
  selected: ReadonlySet<string>
): ApprovalCandidate[] {
  return candidates.filter((candidate) => selected.has(candidate.name));
}

/** What a pasted text is, where it is not a list of operations. */
export type PasteIssue =
  /** The text is not YAML: the parser's sentence, with the line where it stopped. */
  | { kind: "yaml"; message: string; line?: number }
  /** The YAML is no list of operations. */
  | { kind: "shape" }
  /** The entry at this place of the list names no operation. */
  | { kind: "unnamed"; index: number }
  /** Two entries name the same operation. */
  | { kind: "duplicate"; name: string }
  | { kind: "empty" };

export type PasteResult =
  { ok: true; candidates: ApprovalCandidate[] } | { ok: false; issue: PasteIssue };

export function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

export function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** What the row and the approval set: a pasted value for them is not taken as written. */
const SET_BY_APPROVAL = new Set(["name", "effect", "exposure", "enabled", "schemaFingerprint"]);

/**
 * The operations of a REST API, pasted as YAML: a list, or a definition's `operations`. Each
 * keeps its declaration as written, and reads GET and `reading` where it names neither, the
 * only method and effect of the first cut. The instance checks every declaration when the
 * approval saves it; this reads only what the list needs to show.
 */
export function pastedCandidates(text: string): PasteResult {
  const read = readYamlData(text, "operations.yaml");
  if (!read.ok) {
    return {
      ok: false,
      issue: {
        kind: "yaml",
        message: read.issue.message,
        ...(read.issue.line === undefined ? {} : { line: read.issue.line })
      }
    };
  }
  const value = read.value;
  if (value === null || value === undefined) return { ok: false, issue: { kind: "empty" } };
  const list = Array.isArray(value) ? value : recordOf(value)?.operations;
  if (!Array.isArray(list)) return { ok: false, issue: { kind: "shape" } };
  if (list.length === 0) return { ok: false, issue: { kind: "empty" } };
  const candidates: ApprovalCandidate[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of list.entries()) {
    const operation = recordOf(entry);
    const name = textOf(operation?.name);
    if (operation === undefined || name === undefined) {
      return { ok: false, issue: { kind: "unnamed", index: index + 1 } };
    }
    if (seen.has(name)) return { ok: false, issue: { kind: "duplicate", name } };
    seen.add(name);
    candidates.push(declaredCandidate(operation, name));
  }
  return { ok: true, candidates };
}

/**
 * The row of one declared operation, pasted or drafted by the agent: its declaration as
 * written, read as GET and `reading` where it names neither, the only method and effect of
 * the first cut. What the row and the approval set is not taken from it.
 */
export function declaredCandidate(
  operation: Record<string, unknown>,
  name: string
): ApprovalCandidate {
  const declaration = Object.fromEntries(
    Object.entries(operation).filter(([key]) => !SET_BY_APPROVAL.has(key))
  );
  const method = textOf(operation.method) ?? "GET";
  const path = textOf(operation.path) ?? "";
  const description = textOf(operation.description);
  return {
    name,
    title: textOf(operation.title) ?? operationTitle(name),
    ...(description === undefined ? {} : { description }),
    effect: operation.effect === "changing" ? "changing" : "reading",
    request: { method, path },
    declaration: { ...declaration, method }
  };
}
