import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  NoopAuditRecorder,
  asClientInstanceId,
  asUserId,
  createPlatformId,
  type AuthenticatedUser,
  type JsonObject
} from "@work-shape/catalyst-core";
import { accessOf } from "./support/access";
import { required } from "./support/assertions";
import { useDataStoreWorld } from "./support/data-store-world";

const admin: AuthenticatedUser = {
  id: "usr_store_agent_admin",
  externalUserId: "store-agent-admin",
  displayLabel: "Store agent admin",
  roles: ["admin"],
  permissionRefs: [],
  clientInstanceId: asClientInstanceId("data-store-test"),
  authSource: "test"
};

const answerSchema = z.object({
  agents: z
    .array(
      z.object({ name: z.string(), title: z.string(), reads: z.boolean(), writes: z.boolean() })
    )
    .optional(),
  hidden: z.object({ agents: z.number().optional() })
});

describe("agents carrying a Data Store's row tools", () => {
  const { db, published } = useDataStoreWorld("data_store_agent_use");

  it("uses published row tools, checks the complete store name and hides unreadable agents", async () => {
    const world = await published("agent_use");
    const config = (name: string, toolNames: string[]): JsonObject => ({
      name,
      displayName: { de: `Agent ${name}` },
      instructions: "Use the store.",
      toolNames
    });
    async function save(name: string, value: JsonObject, publish: boolean) {
      const key = `agent:${name}`;
      const current = await db.store.configAssets.getConfigAsset({
        clientInstanceId: world.clientInstanceId,
        kind: "agent",
        name
      });
      const result = await db.store.configAssets.applyConfigAssetMutations({
        clientInstanceId: world.clientInstanceId,
        baseRevisions: { [key]: current?.revision ?? null },
        mutations: [{ type: "upsert", kind: "agent", name, config: value, draft: true }]
      });
      if (publish) {
        const revision = required(result.revisions[key]);
        const stored = required(
          await db.store.configAssets.getConfigAssetRevision({
            clientInstanceId: world.clientInstanceId,
            kind: "agent",
            name,
            revision
          })
        );
        await db.store.configAssets.publishConfigAssetRevision({
          clientInstanceId: world.clientInstanceId,
          kind: "agent",
          name,
          assetId: required(result.assetIds[key]),
          revision,
          revisionId: stored.id
        });
      }
    }
    await save("reader", config("reader", ["data_store.findings.query"]), true);
    await save(
      "writer",
      config("writer", ["data_store.findings.insert", "data_store.findings.update"]),
      true
    );
    await save(
      "near",
      config("near", [
        "data_store.findings2.query",
        "data_store.findings.used_by",
        "data_store.findings.unknown"
      ]),
      true
    );
    await save("draft", config("draft", ["data_store.findings.query"]), false);
    await save("reader", config("reader", []), false);
    await save("malformed", { toolNames: "data_store.findings.query" }, true);

    const operation = required(
      await world.dataStores.operationSource.resolve("data_store.findings.used_by")
    );
    const read = async (actor: AuthenticatedUser) =>
      answerSchema.parse(
        await operation.execute(
          {},
          {
            runId: createPlatformId<"OperationRunId">("opr"),
            actor,
            origin: { kind: "user" },
            correlationId: "store-agent-use",
            runtime: {},
            access: accessOf(actor),
            audit: new NoopAuditRecorder()
          }
        )
      );
    expect((await read(admin)).agents).toEqual([
      { name: "reader", title: "Agent reader", reads: true, writes: false },
      { name: "writer", title: "Agent writer", reads: false, writes: true }
    ]);
    const member = { ...admin, id: "usr_store_agent_member", roles: ["user"] };
    const hidden = await read(member);
    expect(hidden.agents ?? []).toEqual([]);
    expect(hidden.hidden.agents).toBe(2);
    expect(JSON.stringify(hidden)).not.toContain("reader");
    expect(JSON.stringify(hidden)).not.toContain("writer");
  });

  it("lists only published Apps the reader may see in the store list", async () => {
    const world = await published("listed_apps");
    const save = async (name: string, store: string, publish: boolean) => {
      const key = `app:${name}`;
      const written = await db.store.configAssets.applyConfigAssetMutations({
        clientInstanceId: world.clientInstanceId,
        baseRevisions: { [key]: null },
        mutations: [
          {
            type: "upsert",
            kind: "app",
            name,
            draft: true,
            config: {
              title: `App ${name}`,
              manifest: {
                actions: [{ name: "rows", kind: "sql", dataStore: store, effect: "reading" }]
              }
            }
          }
        ]
      });
      if (!publish) return;
      const revision = required(written.revisions[key]);
      const stored = required(
        await db.store.configAssets.getConfigAssetRevision({
          clientInstanceId: world.clientInstanceId,
          kind: "app",
          name,
          revision
        })
      );
      await db.store.configAssets.publishConfigAssetRevision({
        clientInstanceId: world.clientInstanceId,
        kind: "app",
        name,
        assetId: required(written.assetIds[key]),
        revision,
        revisionId: stored.id
      });
    };
    await save("board", "findings", true);
    await save("draft_board", "findings", false);
    await save("other_board", "findings2", true);
    const listed = await world.dataStores.list(accessOf(admin));
    expect(listed.items[0]?.apps).toEqual([{ name: "board", title: "App board" }]);
    const member: AuthenticatedUser = { ...admin, id: "usr_store_list_member", clientInstanceId: world.clientInstanceId, roles: ["user"] };
    const hidden = await world.dataStores.list(
      accessOf(member, {
        grants: [
          {
            id: "grant_store_list",
            clientInstanceId: world.clientInstanceId,
            holderKind: "user",
            holderId: member.id,
            action: "data_store.read",
            effect: "allow",
            scopeKind: "asset",
            scopeId: world.id,
            grantedBy: asUserId(admin.id),
            createdAt: new Date().toISOString()
          }
        ]
      })
    );
    expect(hidden.items).toHaveLength(1);
    expect(hidden.items[0]?.apps ?? []).toEqual([]);
    expect(JSON.stringify(hidden)).not.toContain("board");
  });
});
