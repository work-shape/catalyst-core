import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  createPlatformId,
  type CollaborationWorkspaceStore,
  type ConfigAssetStore,
  type UserStore
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import { PostgresPlatformStore } from "@vivd-catalyst/postgres-store";

interface ConfigAssetStoreFixture extends ConfigAssetStore, CollaborationWorkspaceStore, UserStore {
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

    it("leaves unlisted assets active and increments once for a merge-style upsert", async () => {
      const clientInstanceId = createClientInstanceId();
      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [
          { type: "upsert", kind: "agent", name: "assistant", config: agentConfig("v1") },
          { type: "upsert", kind: "skill", name: "research", config: skillConfig("v1") }
        ]
      });

      const result = await store.applyConfigAssetMutations({
        clientInstanceId,
        baseVersion: 1,
        mutations: [{ type: "upsert", kind: "agent", name: "assistant", config: agentConfig("v2") }]
      });

      expect(result).toEqual({ version: 2 });
      await expect(store.listActiveConfigAssets({ clientInstanceId })).resolves.toMatchObject([
        { kind: "agent", name: "assistant", config: agentConfig("v2") },
        { kind: "skill", name: "research", config: skillConfig("v1") }
      ]);
    });

    it("rejects a stale base version without committing mutations", async () => {
      const clientInstanceId = createClientInstanceId();
      await store.applyConfigAssetMutations({
        clientInstanceId,
        baseVersion: 0,
        mutations: [{ type: "upsert", kind: "agent", name: "assistant", config: agentConfig("v1") }]
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

    it.each(["update", "delete", "create"] as const)(
      "rejects a remote %s atomically with revision provenance",
      async (operation) => {
        const clientInstanceId = createClientInstanceId();
        if (operation !== "create") {
          await store.applyConfigAssetMutations({
            clientInstanceId,
            mutations: [
              { type: "upsert", kind: "skill", name: "research", config: skillConfig("baseline") }
            ]
          });
        }
        await store.applyConfigAssetMutations({
          clientInstanceId,
          actor: { displayLabel: "Remote editor", roles: ["admin"] },
          mutations:
            operation === "delete"
              ? [{ type: "delete", kind: "skill", name: "research" }]
              : [{ type: "upsert", kind: "skill", name: "research", config: skillConfig("remote") }]
        });
        const before = await store.getConfigAssetState({ clientInstanceId });
        await expect(
          store.applyConfigAssetMutations({
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
          code: "CONFLICT",
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
        expect(await store.getConfigAssetState({ clientInstanceId })).toEqual(before);
        expect(
          await store.getConfigAsset({ clientInstanceId, kind: "skill", name: "other" })
        ).toBeUndefined();
      }
    );

    it("lists every conflicting asset before applying any mutation", async () => {
      const clientInstanceId = createClientInstanceId();
      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [
          { type: "upsert", kind: "agent", name: "assistant", config: agentConfig("remote") },
          { type: "upsert", kind: "skill", name: "research", config: skillConfig("remote") }
        ]
      });
      await expect(
        store.applyConfigAssetMutations({
          clientInstanceId,
          baseRevisions: { "agent:assistant": null, "skill:research": null },
          mutations: [
            { type: "upsert", kind: "agent", name: "assistant", config: agentConfig("local") },
            { type: "delete", kind: "skill", name: "research" }
          ]
        })
      ).rejects.toMatchObject({
        code: "CONFLICT",
        details: {
          conflicts: [
            { kind: "agent", name: "assistant", currentRevision: 1, operation: "create" },
            { kind: "skill", name: "research", currentRevision: 1, operation: "create" }
          ]
        }
      });
      expect(await store.getConfigAssetState({ clientInstanceId })).toEqual({ version: 1 });
    });

    it("ignores untouched remote changes and guards explicit deletions", async () => {
      const clientInstanceId = createClientInstanceId();
      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [
          { type: "upsert", kind: "skill", name: "research", config: skillConfig("baseline") },
          {
            type: "upsert",
            kind: "skill",
            name: "other",
            config: { name: "other", content: "baseline" }
          }
        ]
      });
      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [
          { type: "upsert", kind: "skill", name: "research", config: skillConfig("remote") }
        ]
      });
      await expect(
        store.applyConfigAssetMutations({
          clientInstanceId,
          baseVersion: 0,
          baseRevisions: { "skill:other": 1 },
          mutations: [{ type: "delete", kind: "skill", name: "other" }]
        })
      ).resolves.toEqual({ version: 3 });
      expect(
        await store.getConfigAsset({ clientInstanceId, kind: "skill", name: "research" })
      ).toMatchObject({ revision: 2, config: skillConfig("remote") });
      await expect(
        store.applyConfigAssetMutations({
          clientInstanceId,
          baseRevisions: { "skill:research": 1 },
          mutations: [{ type: "delete", kind: "skill", name: "research" }]
        })
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("guards the default pointer only when changed and requires every touched baseline", async () => {
      const clientInstanceId = createClientInstanceId();
      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [
          { type: "upsert", kind: "agent", name: "assistant", config: agentConfig("baseline") },
          { type: "setDefaultAgent", agentName: "assistant" }
        ]
      });
      await expect(
        store.applyConfigAssetMutations({
          clientInstanceId,
          baseRevisions: {},
          baseDefaultAgentName: null,
          mutations: [{ type: "setDefaultAgent", agentName: undefined }]
        })
      ).rejects.toMatchObject({
        code: "CONFLICT",
        details: { defaultAgentConflict: { currentAgentName: "assistant" } }
      });
      await expect(
        store.applyConfigAssetMutations({
          clientInstanceId,
          baseRevisions: {},
          mutations: [
            { type: "upsert", kind: "agent", name: "assistant", config: agentConfig("local") }
          ]
        })
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await expect(
        store.applyConfigAssetMutations({
          clientInstanceId,
          baseRevisions: { "agent:assistant": 1 },
          baseDefaultAgentName: null,
          mutations: [
            { type: "upsert", kind: "agent", name: "assistant", config: agentConfig("local") }
          ]
        })
      ).resolves.toEqual({ version: 2 });
      await expect(
        store.applyConfigAssetMutations({
          clientInstanceId,
          baseRevisions: {},
          baseDefaultAgentName: "assistant",
          mutations: [{ type: "setDefaultAgent", agentName: undefined }]
        })
      ).resolves.toEqual({ version: 3 });
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
        mutations: [{ type: "upsert", kind: "agent", name: "assistant", config: agentConfig("v2") }]
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
        mutations: [{ type: "upsert", kind: "skill", name: "research", config: skillConfig("v1") }]
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
        mutations: [{ type: "upsert", kind: "skill", name: "research", config: skillConfig("v1") }]
      });
      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [{ type: "delete", kind: "skill", name: "research" }]
      });
      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [{ type: "upsert", kind: "skill", name: "research", config: skillConfig("v2") }]
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
        mutations: [{ type: "upsert", kind: "agent", name: "assistant", config: agentConfig("v1") }]
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

    it("gives new agents an availability record and removes it with the agent", async () => {
      const clientInstanceId = createClientInstanceId();
      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [
          { type: "upsert", kind: "agent", name: "assistant", config: agentConfig("v1") },
          { type: "upsert", kind: "skill", name: "research", config: skillConfig("v1") }
        ]
      });
      const everywhere = {
        mode: "all" as const,
        personalWorkspaces: false,
        collaborationWorkspaceIds: []
      };
      expect([...(await store.listAgentAvailability({ clientInstanceId }))]).toEqual([
        ["assistant", everywhere]
      ]);

      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [{ type: "upsert", kind: "agent", name: "assistant", config: agentConfig("v2") }]
      });
      await store.setAgentAvailability({
        clientInstanceId,
        agentName: "assistant",
        availability: { mode: "selected", personalWorkspaces: true, collaborationWorkspaceIds: [] }
      });
      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [{ type: "upsert", kind: "agent", name: "assistant", config: agentConfig("v3") }]
      });
      // An update never widens what an admin restricted.
      expect([...(await store.listAgentAvailability({ clientInstanceId }))]).toEqual([
        ["assistant", { mode: "selected", personalWorkspaces: true, collaborationWorkspaceIds: [] }]
      ]);

      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [{ type: "delete", kind: "agent", name: "assistant" }]
      });
      expect((await store.listAgentAvailability({ clientInstanceId })).size).toBe(0);
      await expect(
        store.setAgentAvailability({
          clientInstanceId,
          agentName: "assistant",
          availability: everywhere
        })
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      // A revived agent starts from the initial availability, not from its old record.
      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [{ type: "upsert", kind: "agent", name: "assistant", config: agentConfig("v4") }]
      });
      expect([...(await store.listAgentAvailability({ clientInstanceId }))]).toEqual([
        ["assistant", everywhere]
      ]);
      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [{ type: "delete", kind: "agent", name: "assistant" }]
      });
      await store.applyConfigAssetMutations({
        clientInstanceId,
        initialAgentAvailability: "selected",
        mutations: [
          { type: "upsert", kind: "agent", name: "assistant", config: agentConfig("v5") },
          { type: "upsert", kind: "agent", name: "second", config: agentConfig("v1") }
        ]
      });
      const hidden = { mode: "selected", personalWorkspaces: false, collaborationWorkspaceIds: [] };
      expect([...(await store.listAgentAvailability({ clientInstanceId }))].sort()).toEqual([
        ["assistant", hidden],
        ["second", hidden]
      ]);
    });

    it("starts agents hidden when the same batch deletes a selected agent", async () => {
      const clientInstanceId = createClientInstanceId();
      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [
          { type: "upsert", kind: "agent", name: "open", config: agentConfig("v1") },
          { type: "upsert", kind: "agent", name: "restricted", config: agentConfig("v1") }
        ]
      });
      await store.setAgentAvailability({
        clientInstanceId,
        agentName: "restricted",
        availability: { mode: "selected", personalWorkspaces: true, collaborationWorkspaceIds: [] }
      });

      // Replacing an unrestricted agent keeps the default.
      await store.applyConfigAssetMutations({
        clientInstanceId,
        initialAgentAvailability: "selected_when_replacing_selected",
        mutations: [
          { type: "delete", kind: "agent", name: "open" },
          { type: "upsert", kind: "agent", name: "open-renamed", config: agentConfig("v1") }
        ]
      });
      expect((await store.listAgentAvailability({ clientInstanceId })).get("open-renamed")).toEqual(
        { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] }
      );

      // The rule applies regardless of mutation order and leaves existing agents alone.
      await store.applyConfigAssetMutations({
        clientInstanceId,
        initialAgentAvailability: "selected_when_replacing_selected",
        mutations: [
          { type: "upsert", kind: "agent", name: "restricted-renamed", config: agentConfig("v1") },
          { type: "delete", kind: "agent", name: "restricted" }
        ]
      });
      const availability = await store.listAgentAvailability({ clientInstanceId });
      expect(availability.has("restricted")).toBe(false);
      expect(availability.get("restricted-renamed")).toEqual({
        mode: "selected",
        personalWorkspaces: false,
        collaborationWorkspaceIds: []
      });
      expect(availability.get("open-renamed")?.mode).toBe("all");

      // Without the push rule, a batch that deletes a restricted agent still creates `all`.
      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [
          { type: "delete", kind: "agent", name: "restricted-renamed" },
          { type: "upsert", kind: "agent", name: "interactive", config: agentConfig("v1") }
        ]
      });
      expect(
        (await store.listAgentAvailability({ clientInstanceId })).get("interactive")?.mode
      ).toBe("all");
    });

    it("keeps the default agent available everywhere", async () => {
      const clientInstanceId = createClientInstanceId();
      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [
          { type: "upsert", kind: "agent", name: "assistant", config: agentConfig("v1") },
          { type: "upsert", kind: "agent", name: "restricted", config: agentConfig("v1") },
          { type: "setDefaultAgent", agentName: "assistant" }
        ]
      });
      const restricted = {
        mode: "selected" as const,
        personalWorkspaces: true,
        collaborationWorkspaceIds: []
      };
      await expect(
        store.setAgentAvailability({
          clientInstanceId,
          agentName: "assistant",
          availability: restricted
        })
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      expect((await store.listAgentAvailability({ clientInstanceId })).get("assistant")?.mode).toBe(
        "all"
      );

      await store.setAgentAvailability({
        clientInstanceId,
        agentName: "restricted",
        availability: restricted
      });
      await expect(
        store.applyConfigAssetMutations({
          clientInstanceId,
          mutations: [{ type: "setDefaultAgent", agentName: "restricted" }]
        })
      ).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        message: "Default agent 'restricted' must be available in all workspaces"
      });
      await expect(store.getConfigAssetState({ clientInstanceId })).resolves.toEqual({
        version: 1,
        defaultAgentName: "assistant"
      });
    });

    it("stores selected workspaces and drops them with the workspace", async () => {
      const clientInstanceId = createClientInstanceId();
      const owner = await store.createUser({ clientInstanceId, displayLabel: "Owner" });
      const [kept, removed] = await Promise.all(
        ["Kept", "Removed"].map((name) =>
          store.createWorkspace({
            clientInstanceId,
            kind: "shared",
            name,
            creatorUserId: owner.id
          })
        )
      );
      await store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [{ type: "upsert", kind: "agent", name: "assistant", config: agentConfig("v1") }]
      });
      await expect(
        store.setAgentAvailability({
          clientInstanceId,
          agentName: "assistant",
          availability: {
            mode: "selected",
            personalWorkspaces: false,
            collaborationWorkspaceIds: [kept!.id, removed!.id, kept!.id]
          }
        })
      ).resolves.toEqual({
        mode: "selected",
        personalWorkspaces: false,
        collaborationWorkspaceIds: [kept!.id, removed!.id].sort()
      });

      await store.deleteWorkspace({ clientInstanceId, collaborationWorkspaceId: removed!.id });
      expect((await store.listAgentAvailability({ clientInstanceId })).get("assistant")).toEqual({
        mode: "selected",
        personalWorkspaces: false,
        collaborationWorkspaceIds: [kept!.id]
      });

      // Replacing the selection removes workspaces that are no longer listed.
      await store.setAgentAvailability({
        clientInstanceId,
        agentName: "assistant",
        availability: { mode: "selected", personalWorkspaces: true, collaborationWorkspaceIds: [] }
      });
      expect((await store.listAgentAvailability({ clientInstanceId })).get("assistant")).toEqual({
        mode: "selected",
        personalWorkspaces: true,
        collaborationWorkspaceIds: []
      });
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
