import { afterEach, describe, expect, it } from "vitest";
import { assetSchema } from "@work-shape/catalyst-api-contract";
import type { JsonObject } from "@work-shape/catalyst-core";
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
const config = (id: string, calls: boolean, title = id): JsonObject => ({
  name: id,
  manifest: {
    id,
    name: title,
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: calls
      ? [
          {
            id: "loop",
            type: "loop",
            steps: [
              { id: "call", type: "workflow", workflow: target },
              { id: "again", type: "workflow", workflow: target }
            ]
          }
        ]
      : []
  }
});
async function store(
  t: WorkflowFixture,
  name: string,
  calls: boolean,
  published = false,
  title = name
) {
  await applyAtCurrentRevisions(t.stores.configAssets, {
    clientInstanceId,
    mutations: [
      { type: "upsert", kind: "workflow", name, config: config(name, calls, title), draft: true }
    ]
  });
  const asset = await t.stores.configAssets.getConfigAsset({
    clientInstanceId,
    kind: "workflow",
    name
  });
  if (!asset) throw new Error("Missing test Workflow");
  if (published)
    await t.stores.configAssets.publishConfigAssetRevision({
      clientInstanceId,
      kind: "workflow",
      name,
      assetId: asset.id,
      revision: asset.revision,
      revisionId: asset.activeRevisionId
    });
  return asset;
}
async function callers(t: WorkflowFixture, userId = t.root.id) {
  return assetSchema.parse(
    (
      await t.expectOk(userId, "assets.get", {
        params: { kind: "workflow", name: target }
      })
    ).json()
  ).workflowCallers;
}

describe("WF-EDIT-5b Workflow callers", () => {
  it("continues past a discovery page and returns the caller's owning workspace", async () => {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: "assets" }
    );
    await store(t, target, false, true);
    const workspaceId = await t.sharedWorkspace("Caller workspace");
    await applyAtCurrentRevisions(t.stores.configAssets, {
      clientInstanceId,
      mutations: [
        ...Array.from({ length: 205 }, (_, index) => {
          const name = `filler-${String(index).padStart(3, "0")}`;
          return {
            type: "upsert" as const,
            kind: "workflow",
            name,
            config: config(name, false),
            draft: true as const
          };
        }),
        {
          type: "upsert",
          kind: "workflow",
          name: "z-caller",
          config: config("z-caller", true, "Workspace caller"),
          scope: { kind: "workspace", workspaceId },
          draft: true
        }
      ]
    });
    expect(await callers(t)).toEqual([
      { name: "z-caller", title: "Workspace caller", scope: { kind: "workspace", workspaceId } }
    ]);
  });

  it("finds nested calls in drafts and published revisions once each and drops deleted callers", async () => {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: "assets" }
    );
    await store(t, target, false, true);
    await store(t, "draft-only", true, false, "Draft caller");
    await store(t, "published-only", true, true, "Published caller");
    await store(t, "published-only", false);
    await store(t, "both", true, true, "Both revisions");
    await store(t, "unrelated", false, true);
    await store(t, "deleted", true, true);
    await applyAtCurrentRevisions(t.stores.configAssets, {
      clientInstanceId,
      mutations: [{ type: "delete", kind: "workflow", name: "deleted" }]
    });
    expect(await callers(t)).toEqual([
      { name: "both", title: "Both revisions", scope: { kind: "instance" } },
      { name: "draft-only", title: "Draft caller", scope: { kind: "instance" } },
      { name: "published-only", title: "published-only", scope: { kind: "instance" } }
    ]);
  });

  it("shows a reader only published references, a builder visible drafts too, and never a denied caller", async () => {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: "assets" }
    );
    await store(t, target, false, true);
    await store(t, "draft-only", true);
    await store(t, "changed-draft", false, true, "Published title");
    await store(t, "changed-draft", true, false, "Secret draft title");
    await store(t, "published-only", true, true, "Visible title");
    await store(t, "published-only", false, false, "Private title");
    const hidden = await store(t, "hidden", true, true, "Hidden caller");
    await t.allow({ kind: "user", id: t.kai.id }, "workflow.read");
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.kai.id,
      action: "workflow.read",
      effect: "deny",
      scopeKind: "asset",
      scopeId: hidden.id,
      grantedBy: t.root.id
    });
    expect(await callers(t, t.kai.id)).toEqual([
      { name: "published-only", title: "Visible title", scope: { kind: "instance" } }
    ]);
    // A use holder sees published definitions through assets.get too, never their drafts.
    await t.allow({ kind: "user", id: t.lena.id }, "workflow.use");
    expect(await callers(t, t.lena.id)).toEqual([
      { name: "hidden", title: "Hidden caller", scope: { kind: "instance" } },
      { name: "published-only", title: "Visible title", scope: { kind: "instance" } }
    ]);
    // Publish alone opens drafts, but grants no read of a superseded published definition.
    await t.allow({ kind: "user", id: t.lena.id }, "workflow.publish");
    const grants = await t.stores.access.listGrants({
      clientInstanceId,
      holderKind: "user",
      holderId: t.lena.id,
      action: "workflow.use"
    });
    for (const grant of grants)
      await t.stores.access.deleteGrant({ clientInstanceId, grantId: grant.id });
    const publishedRead = await t.call(t.lena.id, "assets.get", {
      params: { kind: "workflow", name: "published-only" },
      query: { revision: "published" }
    });
    expect(publishedRead.statusCode).toBe(403);
    expect((await callers(t, t.lena.id))?.map((caller) => caller.name)).toEqual([
      "changed-draft",
      "draft-only",
      "hidden"
    ]);
    await t.allow({ kind: "user", id: t.kai.id }, "workflow.write");
    // A write right permits the hidden caller's draft, just as assets.get does.
    expect((await callers(t, t.kai.id))?.map((caller) => caller.name)).toEqual([
      "changed-draft",
      "draft-only",
      "hidden",
      "published-only"
    ]);
  });
});
