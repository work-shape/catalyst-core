import type { WorkflowManifest } from "@work-shape/catalyst-core";
import { clientInstanceId } from "./access-instance";
import { runSchema, type WorkflowFixture } from "./workflow-instance";

export const ref = (step: string, path: string) => ({ ref: { step, path } });
export function child(id = "child", runAs = "workflow-runner"): WorkflowManifest {
  return {
    id,
    name: id,
    runAs,
    inputs: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false
    },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Parent", type: "trigger", triggers: [{ kind: "parent" }] },
      {
        id: "read",
        name: "Read",
        type: "operation",
        operation: "connection.crm.echo",
        input: { text: ref("start", "input.value") }
      },
      { id: "result", name: "Result", type: "output", input: { value: ref("read", "value") } }
    ]
  };
}
export function parent(target = "child", items?: number): WorkflowManifest {
  const call = {
    id: "child",
    name: "Child",
    type: "workflow" as const,
    workflow: target,
    input: { value: items === undefined ? { value: "7" } : ref("each", "") }
  };
  return {
    id: "parent",
    name: "Parent",
    runAs: "workflow-runner",
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      {
        id: "start",
        name: "Start",
        type: "trigger",
        triggers: [{ kind: "manual" }, { kind: "parent" }]
      },
      ...(items === undefined
        ? [call]
        : [
            {
              id: "items",
              name: "Items",
              type: "operation" as const,
              operation: "connection.crm.echo",
              input: { text: { value: "items" } }
            },
            {
              id: "each",
              name: "Each",
              type: "loop" as const,
              items: { step: "items", path: "items" },
              concurrency: 4,
              onItemFailure: "continue" as const,
              steps: [call]
            }
          ]),
      {
        id: "result",
        name: "Result",
        type: "output",
        input: { result: ref(items === undefined ? "child" : "each", "") }
      }
    ]
  };
}
export const start = async (t: WorkflowFixture, workflow = "parent") =>
  runSchema.parse(
    (
      await t.expectOk(t.root.id, "workflows.start", {
        params: { workflow },
        payload: { input: {} }
      })
    ).json()
  );
export async function children(t: WorkflowFixture, runId: string) {
  const run = await t.stores.workflowRuns.readRun({ clientInstanceId, id: runId });
  if (!run) throw new Error("Missing run");
  return t.stores.workflowRuns.listChildRuns({ clientInstanceId, id: run.id });
}
