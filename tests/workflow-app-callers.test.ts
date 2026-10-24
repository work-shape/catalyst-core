import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { assetSchema, assetSummarySchema } from "@work-shape/catalyst-api-contract";
import type { CollaborationWorkspaceId, JsonObject } from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { readyWorkflows } from "./support/workflow-runs";
import type { WorkflowFixture } from "./support/workflow-instance";

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});

const target = "notify-clients";

const workflowConfig = (id: string): JsonObject => ({
  name: id,
  manifest: { id, name: id, inputs: { type: "object" }, outputs: { type: "object" }, steps: [] }
});

/** An App whose build compiled one action per Workflow it starts. */
const appConfig = (name: string, title: string, starts: readonly string[]): JsonObject => ({
  name,
  title,
  manifest: {
    name: title,
    actions: [
      ...starts.map((workflow, index) => ({
        name: `start-${index}`,
        file: "index.html",
        description: "Starts a run",
        kind: "workflow",
        effect: "changing",
        workflow,
        input: { schema: { type: "object", properties: {} }, mapping: {} }
      })),
      // An action of another kind starts no Workflow, even under the same name.
      {
        name: "read-crm",
        file: "index.html",
        description: "Reads",
        kind: "connection",
        effect: "reading",
        connection: target,
        operation: "echo",
        input: { schema: { type: "object", properties: {} }, mapping: {} }
      }
    ]
  }
});

async function storeWorkflow(t: WorkflowFixture, name: string) {
  await applyAtCurrentRevisions(t.stores.configAssets, {
    clientInstanceId,
    mutations: [
      { type: "upsert", kind: "workflow", name, config: workflowConfig(name), draft: true }
    ]
  });
  await publish(t, "workflow", name);
}

async function storeApp(
  t: WorkflowFixture,
  workspaceId: CollaborationWorkspaceId,
  name: string,
  title: string,
  starts: readonly string[],
  published = false
) {
  await applyAtCurrentRevisions(t.stores.configAssets, {
    clientInstanceId,
    mutations: [
      {
        type: "upsert",
        kind: "app",
        name,
        config: appConfig(name, title, starts),
        scope: { kind: "workspace", workspaceId },
        draft: true
      }
    ]
  });
  if (published) await publish(t, "app", name);
}

async function publish(t: WorkflowFixture, kind: string, name: string) {
  const asset = await t.stores.configAssets.getConfigAsset({ clientInstanceId, kind, name });
  if (!asset) throw new Error(`Missing test ${kind}`);
  await t.stores.configAssets.publishConfigAssetRevision({
    clientInstanceId,
    kind,
    name,
    assetId: asset.id,
    revision: asset.revision,
    revisionId: asset.activeRevisionId
  });
}

async function appCallers(t: WorkflowFixture, userId = t.root.id, workflow = target) {
  return assetSchema.parse(
    (
      await t.expectOk(userId, "assets.get", { params: { kind: "workflow", name: workflow } })
    ).json()
  ).appCallers;
}

async function listed(t: WorkflowFixture, userId = t.root.id) {
  const items = z
    .object({ items: z.array(assetSummarySchema) })
    .parse(
      (await t.expectOk(userId, "assets.list", { params: { kind: "workflow" } })).json()
    ).items;
  return Object.fromEntries(items.map((item) => [item.name, item.appCallers]));
}

describe("Apps that start a Workflow", () => {
  it("names each App that starts it once, by title, on its read and on its row", async () => {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: "assets", apps: true }
    );
    await storeWorkflow(t, target);
    await storeWorkflow(t, "unstarted");
    const workspaceId = await t.sharedWorkspace("Apps");
    await storeApp(t, workspaceId, "orders", "Orders", [target, target], true);
    await storeApp(t, workspaceId, "drafted", "Client intake", [target]);
    await storeApp(t, workspaceId, "other", "Other", ["unstarted-elsewhere"], true);
    const scope = { kind: "workspace", workspaceId };
    const expected = [
      { name: "drafted", title: "Client intake", scope },
      { name: "orders", title: "Orders", scope }
    ];
    expect(await appCallers(t)).toEqual(expected);
    expect(await appCallers(t, t.root.id, "unstarted")).toEqual([]);
    const rows = await listed(t);
    expect(rows[target]).toEqual(expected);
    // A Workflow no App starts carries no list at all on its row.
    expect(rows.unstarted).toBeUndefined();
  });

  it("leaves out an App the reader may not open", async () => {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: "assets", apps: true }
    );
    await storeWorkflow(t, target);
    const workspaceId = await t.sharedWorkspace("Apps");
    await storeApp(t, workspaceId, "orders", "Orders", [target], true);
    await t.allow({ kind: "user", id: t.kai.id }, "workflow.read");
    expect(await appCallers(t, t.kai.id)).toEqual([]);
    expect((await listed(t, t.kai.id))[target]).toBeUndefined();
  });
});
