import { beforeAllWithPostgres as beforeAll } from "./support/postgres-hooks";
import type { PlatformStores } from "@vivd-catalyst/core";
import { createTestInstance } from "./support/test-instance";
import { afterAll, describe, expect, it } from "vitest";
import { asClientInstanceId, createPlatformId } from "@vivd-catalyst/core";
import { applyAtCurrentRevisions } from "./support/asset-revisions";

// The revision a write of the store is made against: every asset it writes names one, and a
// deleted name keeps the revision of its delete.

describe("the base revision of a store write", () => {
  let store: Pick<PlatformStores, "configAssets"> & { close?: () => Promise<void> };

  beforeAll(async () => {
    store = (await createTestInstance({ postgres: {} })).stores;
  });

  afterAll(async () => {
    await store?.close?.();
  });

  // Fails without the change: a write without a base was taken as leave to overwrite.
  // Fails without the change: a batch without bases was written over whatever was stored.
  it("refuses a write that names no base revision for an asset, and writes nothing", async () => {
    const clientInstanceId = createClientInstanceId();
    await applyAtCurrentRevisions(store.configAssets, {
      clientInstanceId,
      mutations: [{ type: "upsert", kind: "agent", name: "assistant", config: agentConfig("v1") }]
    });

    await expect(
      store.configAssets.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: {},
        mutations: [{ type: "upsert", kind: "agent", name: "assistant", config: agentConfig("v2") }]
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_REQUIRED",
      statusCode: 428,
      details: {
        reason: "precondition_required",
        assets: [{ kind: "agent", name: "assistant" }]
      }
    });
    await expect(store.configAssets.getConfigAssetState({ clientInstanceId })).resolves.toEqual({
      version: 1
    });
    await expect(
      store.configAssets.listConfigAssetRevisions({
        clientInstanceId,
        kind: "agent",
        name: "assistant"
      })
    ).resolves.toHaveLength(1);
  });

  // Fails without the change: `null` matched a deleted asset and brought it back.
  it("creates a deleted name again only for a write that names the revision of its delete", async () => {
    const clientInstanceId = createClientInstanceId();
    const put = (base: number | null, text: string) =>
      store.configAssets.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { "skill:guide": base },
        mutations: [
          { type: "upsert", kind: "skill", name: "guide", config: { name: "guide", text } }
        ]
      });
    await put(null, "first");
    await store.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "skill:guide": 1 },
      mutations: [{ type: "delete", kind: "skill", name: "guide" }]
    });

    await expect(put(null, "blind")).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
      statusCode: 412,
      details: {
        conflicts: [{ kind: "skill", name: "guide", currentRevision: 2, deleted: true }]
      }
    });
    await expect(put(1, "stale")).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await put(2, "reviewed");
    const asset = await store.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "skill",
      name: "guide"
    });
    expect(asset).toMatchObject({ status: "active", revision: 3 });
    // A delete of what is not there writes nothing, whether it was deleted or never stored.
    await store.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "skill:never": null },
      mutations: [{ type: "delete", kind: "skill", name: "never" }]
    });
  });

  it.each(["update", "delete", "create"] as const)(
    "rejects a remote %s atomically with revision provenance",
    async (operation) => {
      const clientInstanceId = createClientInstanceId();
      if (operation !== "create") {
        await applyAtCurrentRevisions(store.configAssets, {
          clientInstanceId,
          mutations: [
            { type: "upsert", kind: "skill", name: "research", config: skillConfig("baseline") }
          ]
        });
      }
      await applyAtCurrentRevisions(store.configAssets, {
        clientInstanceId,
        actor: { displayLabel: "Remote editor", roles: ["admin"] },
        mutations:
          operation === "delete"
            ? [{ type: "delete", kind: "skill", name: "research" }]
            : [{ type: "upsert", kind: "skill", name: "research", config: skillConfig("remote") }]
      });
      const before = await store.configAssets.getConfigAssetState({ clientInstanceId });
      await expect(
        applyAtCurrentRevisions(store.configAssets, {
          clientInstanceId,
          baseRevisions: {
            "skill:research": operation === "create" ? null : 1,
            "skill:other": null
          },
          mutations: [
            {
              type: "upsert",
              kind: "skill",
              name: "other",
              config: { name: "other", content: "new" }
            },
            { type: "upsert", kind: "skill", name: "research", config: skillConfig("local") }
          ]
        })
      ).rejects.toMatchObject({
        code: "REVISION_CONFLICT",
        details: {
          conflicts: [
            {
              kind: "skill",
              name: "research",
              currentRevision: operation === "create" ? 1 : 2,
              actorLabel: "Remote editor",
              timestamp: expect.any(String),
              operation
            }
          ]
        }
      });
      expect(await store.configAssets.getConfigAssetState({ clientInstanceId })).toEqual(before);
      expect(
        await store.configAssets.getConfigAsset({
          clientInstanceId,
          kind: "skill",
          name: "other"
        })
      ).toBeUndefined();
    }
  );
});

function createClientInstanceId() {
  return asClientInstanceId(createPlatformId("config-test"));
}

function agentConfig(version: string) {
  return { name: "assistant", instructions: version };
}

function skillConfig(version: string) {
  return { name: "research", content: version };
}
