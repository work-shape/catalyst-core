import type { JsonObject } from "@work-shape/catalyst-core";
import { parseWorkflowManifest } from "@work-shape/catalyst-workflows";

/** Real manifest shapes for provenance tests, which persist revisions without executing them. */
export function dataFlowManifest(
  name: string,
  operations: readonly string[],
  options: { kind?: "process" | "data"; nested?: boolean } = {}
): JsonObject {
  const calls = operations.map((operation, index) => ({
    id: `call${index}`,
    name: `Call ${index}`,
    type: "operation",
    operation,
    input: {}
  }));
  const manifest: JsonObject = {
    id: name,
    name: `Title ${name}`,
    kind: options.kind ?? "data",
    runAs: "flow-runner",
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      ...(options.nested
        ? [
            {
              id: "listing",
              name: "List",
              type: "operation",
              operation: "connection.source.list",
              input: {}
            },
            {
              id: "each",
              name: "Each",
              type: "loop",
              items: { step: "listing", path: "items" },
              steps: calls
            }
          ]
        : calls),
      { id: "result", name: "Result", type: "output", input: {} }
    ]
  };
  const parsed = parseWorkflowManifest(manifest);
  if (!parsed.ok) throw new Error(`Invalid data-flow fixture: ${JSON.stringify(parsed.issues)}`);
  return manifest;
}
