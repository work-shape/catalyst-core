import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  createPlatformId,
  type ConfigAssetStore
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import { PostgresPlatformStore } from "@vivd-catalyst/postgres-store";

interface ConfigAssetStoreFixture extends ConfigAssetStore {
  close?: () => Promise<void>;
}

runConfigAssetStoreSuite("In-memory config asset store", async () => new InMemoryPlatformStore());

const databaseUrl = process.env.POSTGRES_STORE_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
runConfigAssetStoreSuite(
  "Postgres config asset store",
  async () =>
    PostgresPlatformStore.connect({
      databaseUrl: databaseUrl!,
      runMigrations: true
    }),
  describePostgres
);

function runConfigAssetStoreSuite(
  label: string,
  createStore: () => Promise<ConfigAssetStoreFixture>,
  describeSuite: typeof describe = describe
): void {
  describeSuite(label, () => {
    let store: ConfigAssetStoreFixture;

    beforeAll(async () => {
      store = await createStore();
    });

    afterAll(async () => {
      await store?.close?.();
    });

    it("starts at version zero and increments once for a multi-asset upsert", async () => {
      const clientInstanceId = createClientInstanceId();
      await expect(store.getConfigAssetState({ clientInstanceId })).resolves.toEqual({
        version: 0
      });

      const result = await store.applyConfigAssetMutations({
        clientInstanceId,
        baseVersion: 0,
        mutations: [
          { type: "upsert", kind: "agent", name: "assistant", config: agentConfig("v1") },
          { type: "upsert", kind: "skill", name: "research", config: skillConfig("v1") }
        ]
      });

      expect(result).toEqual({ version: 1 });
      await expect(store.getConfigAssetState({ clientInstanceId })).resolves.toEqual({
        version: 1
      });
      const revisions = await store.listConfigAssetRevisions({
        clientInstanceId,
        kind: "agent",
        name: "assistant"
      });
      expect(revisions).toMatchObject([
        { revision: 1, operation: "create", globalVersion: 1, config: agentConfig("v1") }
      ]);
    });

    it("rejects a stale base version without committing mutations", async () => {
      const clientInstanceId = createClientInstanceId();
      await store.applyConfigAssetMutations({
        clientInstanceId,
        baseVersion: 0,
        mutations: [
          { type: "upsert", kind: "agent", name: "assistant", config: agentConfig("v1") }
        ]
      });

      await expect(
        store.applyConfigAssetMutations({
          clientInstanceId,
          baseVersion: 0,
          mutations: [
            { type: "upsert", kind: "agent", name: "assistant", config: agentConfig("v2") }
          ]
        })
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "Config version mismatch",
        details: { currentVersion: 1, baseVersion: 0 }
      });
      await expect(store.getConfigAssetState({ clientInstanceId })).resolves.toEqual({
        version: 1
      });
      await expect(
        store.listConfigAssetRevisions({ clientInstanceId, kind: "agent", name: "assistant" })
      ).resolves.toHaveLength(1);
    });

    it("numbers revisions independently per asset", async () => {
      const clientInstanceId = createClientInstanceId();
      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [
          { type: "upsert", kind: "agent", name: "assistant", config: agentConfig("v1") },
          { type: "upsert", kind: "skill", name: "research", config: skillConfig("v1") }
        ]
      });
      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [
          { type: "upsert", kind: "agent", name: "assistant", config: agentConfig("v2") }
        ]
      });

      const agentRevisions = await store.listConfigAssetRevisions({
        clientInstanceId,
        kind: "agent",
        name: "assistant"
      });
      const skillRevisions = await store.listConfigAssetRevisions({
        clientInstanceId,
        kind: "skill",
        name: "research"
      });
      expect(agentRevisions.map((revision) => revision.revision)).toEqual([1, 2]);
      expect(skillRevisions.map((revision) => revision.revision)).toEqual([1]);
      await expect(
        store.getConfigAsset({ clientInstanceId, kind: "agent", name: "assistant" })
      ).resolves.toMatchObject({ revision: 2, config: agentConfig("v2") });
    });

    it("writes one delete tombstone and treats repeated deletes as idempotent", async () => {
      const clientInstanceId = createClientInstanceId();
      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [
          { type: "upsert", kind: "skill", name: "research", config: skillConfig("v1") }
        ]
      });
      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [{ type: "delete", kind: "skill", name: "research" }]
      });
      const repeated = await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [{ type: "delete", kind: "skill", name: "research" }]
      });

      expect(repeated).toEqual({ version: 3 });
      await expect(
        store.getConfigAsset({ clientInstanceId, kind: "skill", name: "research" })
      ).resolves.toMatchObject({ status: "deleted", revision: 2, config: null });
      await expect(
        store.listConfigAssetRevisions({ clientInstanceId, kind: "skill", name: "research" })
      ).resolves.toMatchObject([
        { revision: 1, operation: "create", globalVersion: 1 },
        { revision: 2, operation: "delete", config: null, globalVersion: 2 }
      ]);
    });

    it("revives deleted assets with a create revision while preserving history", async () => {
      const clientInstanceId = createClientInstanceId();
      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [
          { type: "upsert", kind: "skill", name: "research", config: skillConfig("v1") }
        ]
      });
      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [{ type: "delete", kind: "skill", name: "research" }]
      });
      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [
          { type: "upsert", kind: "skill", name: "research", config: skillConfig("v2") }
        ]
      });

      await expect(
        store.listConfigAssetRevisions({ clientInstanceId, kind: "skill", name: "research" })
      ).resolves.toMatchObject([
        { revision: 1, operation: "create" },
        { revision: 2, operation: "delete" },
        { revision: 3, operation: "create", config: skillConfig("v2") }
      ]);
      await expect(
        store.getConfigAsset({ clientInstanceId, kind: "skill", name: "research" })
      ).resolves.toMatchObject({ status: "active", revision: 3, config: skillConfig("v2") });
    });

    it("records explicit revert operations and actors", async () => {
      const clientInstanceId = createClientInstanceId();
      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [
          { type: "upsert", kind: "agent", name: "assistant", config: agentConfig("v1") }
        ]
      });
      await store.applyConfigAssetMutations({
        clientInstanceId,
        actor: {
          userId: "user-1",
          externalUserId: "external-1",
          displayLabel: "Config Admin",
          roles: ["admin"]
        },
        mutations: [
          {
            type: "upsert",
            kind: "agent",
            name: "assistant",
            config: agentConfig("restored"),
            operation: "revert"
          }
        ]
      });

      const revisions = await store.listConfigAssetRevisions({
        clientInstanceId,
        kind: "agent",
        name: "assistant"
      });
      expect(revisions[1]).toMatchObject({
        revision: 2,
        operation: "revert",
        actor: { userId: "user-1", displayLabel: "Config Admin" }
      });
    });

    it("sets and clears the default agent and rolls back invalid references", async () => {
      const clientInstanceId = createClientInstanceId();
      await store.applyConfigAssetMutations({
        clientInstanceId,
        baseVersion: 0,
        mutations: [
          { type: "upsert", kind: "agent", name: "assistant", config: agentConfig("v1") },
          { type: "setDefaultAgent", agentName: "assistant" }
        ]
      });
      await expect(store.getConfigAssetState({ clientInstanceId })).resolves.toEqual({
        version: 1,
        defaultAgentName: "assistant"
      });

      await expect(
        store.applyConfigAssetMutations({
          clientInstanceId,
          baseVersion: 1,
          mutations: [{ type: "setDefaultAgent", agentName: "missing" }]
        })
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await expect(store.getConfigAssetState({ clientInstanceId })).resolves.toEqual({
        version: 1,
        defaultAgentName: "assistant"
      });

      await expect(
        store.applyConfigAssetMutations({
          clientInstanceId,
          baseVersion: 1,
          mutations: [{ type: "delete", kind: "agent", name: "assistant" }]
        })
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await expect(
        store.getConfigAsset({ clientInstanceId, kind: "agent", name: "assistant" })
      ).resolves.toMatchObject({ status: "active", revision: 1 });

      await store.applyConfigAssetMutations({
        clientInstanceId,
        baseVersion: 1,
        mutations: [{ type: "setDefaultAgent", agentName: undefined }]
      });
      await expect(store.getConfigAssetState({ clientInstanceId })).resolves.toEqual({
        version: 2
      });
    });

    it("lists only active assets with an optional kind filter", async () => {
      const clientInstanceId = createClientInstanceId();
      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [
          { type: "upsert", kind: "agent", name: "assistant", config: agentConfig("v1") },
          { type: "upsert", kind: "skill", name: "active", config: skillConfig("active") },
          { type: "upsert", kind: "skill", name: "deleted", config: skillConfig("deleted") }
        ]
      });
      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [{ type: "delete", kind: "skill", name: "deleted" }]
      });

      const all = await store.listActiveConfigAssets({ clientInstanceId });
      const skills = await store.listActiveConfigAssets({ clientInstanceId, kind: "skill" });
      expect(all.map((asset) => `${asset.kind}:${asset.name}`)).toEqual([
        "agent:assistant",
        "skill:active"
      ]);
      expect(skills.map((asset) => asset.name)).toEqual(["active"]);
    });
  });
}

function createClientInstanceId() {
  return asClientInstanceId(createPlatformId("config-test"));
}

function agentConfig(version: string) {
  return { name: "assistant", instructions: version };
}

function skillConfig(version: string) {
  return { name: "research", content: version };
}
