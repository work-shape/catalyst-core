import { MemoryObjectStorage } from "./support/memory-object-storage";
import { afterEach, expect, it } from "vitest";
import { clientInstanceId } from "./support/access-instance";
import { runSchema, type WorkflowFixture } from "./support/workflow-instance";
import {
  notifyClients,
  readyWorkflows,
  start,
  stepRunsOf,
  writesOf
} from "./support/workflow-runs";
import { listenTestInstance } from "./support/test-instance";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import type { JsonValue } from "@work-shape/catalyst-core";

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});

const SECRETS = [{ id: "SECRET-A" }, { id: "SECRET-B" }];

async function save(t: WorkflowFixture, manifest: { id: string; [key: string]: unknown }) {
  const address = { kind: "workflow", name: manifest.id };
  await t.expectOk(t.root.id, "assets.put", {
    params: address,
    payload: { config: { name: manifest.id, manifest }, expectedRevision: null }
  });
  await t.expectOk(t.root.id, "assets.publish", { params: address, payload: { revision: 1 } });
}

it.each([
  "child-output",
  "child-output-typed",
  "operation-reference",
  "loop-reference",
  "loop-item",
  "root-input",
  "root-input-free",
  "root-output",
  "root-output-typed"
])("refuses another run's dataset through %s after an HTTP start", async (surface) => {
  const base = notifyClients();
  const datasetType = { type: "dataset", row: { type: "object" } };
  const t = await readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    { definitions: "assets", datasetObjects: new MemoryObjectStorage() }
  );
  t.setBehaviour((operation, input) =>
    Promise.resolve<JsonValue>(operation === "echo" ? { clients: SECRETS } : { received: input })
  );
  // The victim: a Workflow whose run keeps a dataset of its output for 7 days.
  await save(t, {
    ...base,
    id: "source-data",
    outputs: { type: "object", properties: { rows: datasetType }, required: ["rows"] },
    steps: [
      base.steps[0],
      {
        id: "rows",
        name: "Rows",
        type: "operation",
        operation: "connection.crm.echo",
        input: { text: { value: "read" } },
        dataset: { at: "clients" }
      },
      {
        id: "result",
        name: "Result",
        type: "output",
        input: { rows: { ref: { step: "rows", path: "clients" } } }
      }
    ]
  });
  const source = await t.finish((await start(t, t.root.id, "source-data")).id);
  expect(source.status).toBe("done");
  const sourceRun = await t.stores.workflowRuns.readRun({ clientInstanceId, id: source.id });
  if (!sourceRun) throw new Error("Missing victim run");
  const [record] = await t.stores.workflowRunDatasets.listForRun({
    clientInstanceId,
    runId: sourceRun.id,
    limit: 10
  });
  if (!record) throw new Error("Missing victim dataset");
  expect(writesOf(t)).toHaveLength(0);

  // The attacker knows the id (the run view shows it under workflow.read) and authors two
  // Workflows: a child that returns the id as a literal in a free-form output, and a parent.
  const forged = { $dataset: record.id, rowCount: record.rowCount, bytes: record.bytes };
  await save(t, {
    ...base,
    id: "forge-child",
    inputs: { type: "object" },
    outputs:
      surface === "child-output-typed"
        ? { type: "object", properties: { rows: datasetType }, required: ["rows"] }
        : { type: "object" },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "parent" }] },
      { id: "result", name: "Result", type: "output", input: { rows: { value: forged } } }
    ]
  });
  await t.allow({ kind: "service_principal", id: t.principal.id }, "workflow.use");
  if (surface.startsWith("child-output"))
    await save(t, {
      ...base,
      id: "forge-parent",
      outputs: { type: "object" },
      steps: [
        base.steps[0],
        { id: "child", name: "Child", type: "workflow", workflow: "forge-child", input: {} },
        {
          id: "each",
          name: "Each",
          type: "loop",
          items: { step: "child", path: "rows" },
          steps: [
            {
              id: "send",
              name: "Send",
              type: "operation",
              operation: "connection.crm.write",
              input: { client: { ref: { step: "each", path: "id" } } }
            }
          ]
        },
        { id: "result", name: "Result", type: "output", input: {} }
      ]
    });
  await t.allow({ kind: "user", id: t.kai.id }, "workflow.use");
  if (!surface.startsWith("child-output")) {
    await save(t, {
      ...base,
      id: "forge-parent",
      inputs:
        surface === "root-input"
          ? { type: "object", properties: { rows: datasetType }, required: ["rows"] }
          : { type: "object" },
      outputs:
        surface === "root-output-typed"
          ? { type: "object", properties: { rows: datasetType }, required: ["rows"] }
          : { type: "object" },
      steps: [
        base.steps[0],
        ...(surface.startsWith("root-")
          ? []
          : [
              {
                id: "foreign",
                name: "Foreign",
                type: "operation",
                operation: "connection.crm.echo",
                input: { text: { value: "forge" } },
                ...(surface === "operation-reference" ? { dataset: { at: "clients" } } : {})
              },
              {
                id: "each",
                name: "Each",
                type: "loop",
                items: { step: "foreign", path: "clients" },
                steps: [
                  {
                    id: "send",
                    name: "Send",
                    type: "operation",
                    operation: "connection.crm.write",
                    input: { client: { ref: { step: "each", path: "id" } } }
                  }
                ]
              }
            ]),
        {
          id: "result",
          name: "Result",
          type: "output",
          input: surface.startsWith("root-output") ? { rows: { value: forged } } : {}
        }
      ]
    });
    t.setBehaviour((operation, input) =>
      Promise.resolve<JsonValue>(
        operation === "echo"
          ? { clients: surface === "loop-item" ? [{ id: forged }] : forged }
          : { received: input }
      )
    );
  }
  const url = await listenTestInstance(t.instance);
  const response = await fetch(
    `${url}${apiOperations["workflows.start"].path.replace(":workflow", "forge-parent")}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": t.kai.id },
      body: JSON.stringify({
        input: surface.startsWith("root-input") ? { rows: forged } : { note: "x" }
      })
    }
  );
  if (surface.startsWith("root-input")) {
    expect(response.status).toBe(403);
    expect(writesOf(t)).toHaveLength(0);
    return;
  }
  expect(response.status).toBe(200);
  const run = await t.finish(runSchema.parse(await response.json()).id);
  // Secure behaviour: the run fails and no secret row reaches the outside system.
  expect(JSON.stringify(writesOf(t))).not.toContain("SECRET");
  expect(run.status).toBe("failed");
  if (surface === "operation-reference") {
    const steps = await stepRunsOf(t, run.id);
    expect(steps.find((step) => step.key === "foreign")).toMatchObject({
      status: "failed",
      error: { code: "dataset_path_invalid" }
    });
  } else if (!surface.startsWith("child-output")) {
    expect(run.error).toMatchObject({ code: "FORBIDDEN" });
  }
});
