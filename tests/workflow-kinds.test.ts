import { describe, expect, it } from "vitest";
import type { WorkflowManifest } from "@work-shape/catalyst-core";
import { dataFlowManifest } from "./support/workflow-data-flows";
import { parseWorkflowManifest, workflowKindIssues } from "@work-shape/catalyst-workflows";

function definition(operation: string, kind?: "process" | "data"): WorkflowManifest {
  return {
    id: "flow",
    name: "Flow",
    runAs: "flow-runner",
    ...(kind ? { kind } : {}),
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      { id: "write", name: "Write", type: "operation", operation, input: {} },
      { id: "end", name: "End", type: "output", input: {} }
    ]
  };
}

describe("Workflow kind at publish", () => {
  it.each([
    "knowledge.docs.ingest",
    "knowledge.docs.withdraw",
    "knowledge.docs.put_processed",
    "data_store.rows.records.propose"
  ])("refuses %s in an implicit or explicit process", (operation) => {
    for (const kind of [undefined, "process"] as const) {
      const manifest = definition(operation, kind);
      const parsed = parseWorkflowManifest(manifest);
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
      expect(workflowKindIssues(manifest)).toMatchObject([
        {
          code: "process_workflow_write_operation",
          message: expect.stringContaining("kind: data")
        }
      ]);
    }
    expect(workflowKindIssues(definition(operation, "data"))).toEqual([]);
  });

  it("walks nested blocks and declared agent tools", () => {
    const parsed = parseWorkflowManifest(
      dataFlowManifest("nested-flow", ["knowledge.docs.ingest"], { kind: "process", nested: true })
    );
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    expect(workflowKindIssues(parsed.manifest)).toHaveLength(1);
    expect(
      workflowKindIssues({
        ...definition("connection.crm.read"),
        steps: [
          {
            id: "agent",
            name: "Agent",
            type: "agent",
            instructions: "steps/agent.md",
            input: {},
            inputSchema: { type: "object" },
            outputSchema: { type: "object" }
          }
        ],
        tools: ["data_store.rows.records.propose"]
      })
    ).toHaveLength(1);
  });

  it.each([
    "knowledge.docs.pending",
    "knowledge.docs.extract_fields",
    "knowledge.docs.search",
    "knowledge.docs.ingest_more",
    "connection.docs.ingest",
    "data_store.rows.insert"
  ])("keeps %s callable by process Workflows", (operation) => {
    expect(workflowKindIssues(definition(operation))).toEqual([]);
  });

  it("refuses malformed definitions through the existing parser", () => {
    expect(
      parseWorkflowManifest({ ...definition("knowledge.docs.ingest"), kind: "unknown" }).ok
    ).toBe(false);
    expect(parseWorkflowManifest({ kind: "data", steps: "not steps" }).ok).toBe(false);
  });
});
