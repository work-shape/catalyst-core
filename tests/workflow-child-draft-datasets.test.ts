import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject, WorkflowManifest } from "@work-shape/catalyst-core";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { clientInstanceId } from "./support/access-instance";
import { echo, write } from "./support/connection-operations";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { children, ref } from "./support/workflow-children";
import { runSchema, type WorkflowFixture } from "./support/workflow-instance";
import { readyWorkflows } from "./support/workflow-runs";

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});
const empty: JsonObject = { type: "object" };
function definition(id: string): WorkflowManifest {
  return {
    id,
    name: id,
    runAs: "workflow-runner",
    inputs: empty,
    outputs: empty,
    steps: [
      {
        id: "start",
        name: "Start",
        type: "trigger",
        triggers: [{ kind: "manual" }, { kind: "parent" }]
      },
      { id: "result", name: "Result", type: "output", input: {} }
    ]
  };
}
async function store(t: WorkflowFixture, manifest: WorkflowManifest, published = false) {
  await applyAtCurrentRevisions(t.stores.configAssets, {
    clientInstanceId,
    mutations: [
      {
        type: "upsert",
        kind: "workflow",
        name: manifest.id,
        config: z.record(z.string(), z.json()).parse({ name: manifest.id, manifest }),
        draft: true
      }
    ]
  });
  const asset = await t.stores.configAssets.getConfigAsset({
    clientInstanceId,
    kind: "workflow",
    name: manifest.id
  });
  if (!asset) throw new Error("Missing Workflow");
  if (published)
    await t.stores.configAssets.publishConfigAssetRevision({
      clientInstanceId,
      kind: "workflow",
      name: manifest.id,
      assetId: asset.id,
      revision: asset.revision,
      revisionId: asset.activeRevisionId
    });
  return asset;
}

describe("DP-4b dataset inputs of a child draft", () => {
  it("checks against the child revision selected for the tester, keeping published checks for live and non-writers", async () => {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      {
        definitions: "assets",
        datasetObjects: new MemoryObjectStorage(),
        connectorCatalog: [
          {
            ...echo,
            outputSchema: {
              type: "object",
              properties: {
                clients: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { id: { type: "string" } },
                    required: ["id"]
                  }
                }
              }
            }
          },
          write
        ]
      }
    );
    await t.allow({ kind: "service_principal", id: t.principal.id }, "workflow.use");
    const producer = definition("producer");
    producer.outputs = { type: "object", properties: { rows: { type: "dataset", row: empty } } };
    producer.steps = [
      ...producer.steps.slice(0, 1),
      {
        id: "clients",
        name: "Clients",
        type: "operation",
        operation: "connection.crm.echo",
        input: { text: { value: "clients" } },
        dataset: { at: "clients" }
      },
      {
        id: "result",
        name: "Result",
        type: "output",
        input: { rows: ref("clients", "clients") }
      }
    ];
    await store(t, producer, true);
    const produced = runSchema.parse(
      (
        await t.expectOk(t.root.id, "workflows.start", {
          params: { workflow: "producer" },
          payload: { input: {} }
        })
      ).json()
    );
    const data = await t.finish(produced.id);
    expect(data, JSON.stringify(data.error)).toMatchObject({ status: "done" });
    const output: { rows: JsonObject } = JSON.parse(data.outputPreview?.text ?? "null");

    const child = definition("child");
    const inputs = (type: string): JsonObject => ({
      type: "object",
      properties: {
        rows: {
          type: "dataset",
          row: { type: "object", properties: { id: { type } }, required: ["id"] }
        }
      },
      required: ["rows"]
    });
    child.inputs = inputs("integer");
    await store(t, child, true);
    child.inputs = inputs("string");
    const childAsset = await store(t, child);
    const parent = definition("parent");
    // The parent's open input lets a runtime dataset supply its own stored row schema.
    parent.steps = [
      ...parent.steps.slice(0, 1),
      {
        id: "child",
        name: "Child",
        type: "workflow",
        workflow: "child",
        input: { rows: ref("start", "input.rows") }
      },
      ...parent.steps.slice(1)
    ];
    const parentAsset = await store(t, parent, true);

    const start = async (userId: string, test: boolean) =>
      runSchema.parse(
        (
          await t.expectOk(userId, test ? "workflows.test" : "workflows.start", {
            params: { workflow: "parent" },
            payload: { input: output }
          })
        ).json()
      );
    const tested = await start(t.root.id, true);
    const done = await t.finish(tested.id);
    expect(done, JSON.stringify(done.error)).toMatchObject({ status: "done" });
    expect((await children(t, tested.id))[0]).toMatchObject({
      mode: "test",
      definitionRevisionId: childAsset.activeRevisionId
    });

    for (const action of ["workflow.use", "workflow.read_run_data"])
      await t.allow({ kind: "user", id: t.kai.id }, action);
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.kai.id,
      action: "workflow.write",
      effect: "allow",
      scopeKind: "asset",
      scopeId: parentAsset.id,
      grantedBy: t.root.id
    });
    for (const run of [await start(t.kai.id, true), await start(t.root.id, false)]) {
      expect(await t.finish(run.id)).toMatchObject({
        status: "failed",
        error: { code: "dataset_schema_invalid" }
      });
      expect(await children(t, run.id)).toEqual([]);
    }
  });
});
