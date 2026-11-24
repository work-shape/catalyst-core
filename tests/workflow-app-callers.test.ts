import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { assetSchema, assetSummarySchema } from "@work-shape/catalyst-api-contract";
import {
  type CollaborationWorkspaceId,
  type JsonObject,
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND
} from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { notifyClients, readyWorkflows } from "./support/workflow-runs";
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
  it("names each App that starts it once, by title, on its read and on its row, to a reader who may open it", async () => {
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
    // A reader who may not open the App is not told of it.
    await t.allow({ kind: "user", id: t.kai.id }, "workflow.read");
    expect(await appCallers(t, t.kai.id)).toEqual([]);
    expect((await listed(t, t.kai.id))[target]).toBeUndefined();
  });
});

const WORKFLOW = "notify-clients";
const address = { kind: WORKFLOW_ASSET_KIND, name: WORKFLOW };

const readSchema = z.object({
  revision: z.number(),
  publishedRevision: z.number().optional(),
  config: z.object({ manifest: z.object({ name: z.string() }).loose() })
});

describe("a Workflow's draft and the member who only reads it", () => {
  // Moved down from the browser suite: a member with the read right on one Workflow is shown
  // what is published while the builder's draft is ahead, never the draft.
  it("shows a reader the published revision while a draft is ahead, and its writer the draft", async () => {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: "assets" }
    );
    const put = async (name: string, expectedRevision: number | null) =>
      z.object({ revision: z.number() }).parse(
        (
          await t.expectOk(t.admin.id, "assets.put", {
            params: address,
            payload: {
              config: { name: WORKFLOW, manifest: { ...notifyClients(), name } },
              expectedRevision
            }
          })
        ).json()
      ).revision;
    const first = await put("Published name", null);
    await t.expectOk(t.root.id, "assets.publish", {
      params: address,
      payload: { revision: first }
    });
    await put("Draft name", first);
    await t.grant(t.kai.id, WORKFLOW_ACTIONS.read, {
      assetId: await t.assetId(WORKFLOW_ASSET_KIND, WORKFLOW)
    });

    const read = async (userId: string) =>
      readSchema.parse((await t.expectOk(userId, "assets.get", { params: address })).json());
    const reader = await read(t.kai.id);
    expect(reader.config.manifest.name).toBe("Published name");
    expect(reader.revision).toBe(first);
    const writer = await read(t.admin.id);
    expect(writer.config.manifest.name).toBe("Draft name");
    expect(writer.publishedRevision).toBe(first);
  });
});
