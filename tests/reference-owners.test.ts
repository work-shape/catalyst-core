import {
  createAppAssetKind,
  createConnectionAssetKind,
  createGuardrailAssetKind
} from "@work-shape/catalyst-server";
import { fixtureConnectorTypes } from "./support/connections";
import { dataFlowManifest } from "./support/workflow-data-flows";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { asUserId, type AssetScope, type JsonObject } from "@work-shape/catalyst-core";
import { agent, errorSchema } from "./support/access-instance";
import {
  clientInstanceId,
  useDataStoreInstance,
  type DataStoreInstance
} from "./support/data-store-instance";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { required } from "./support/assertions";
import { withTestSql } from "./support/test-sql";

const kb = (name: string, store?: string): JsonObject => ({
  name,
  title: name,
  description: "Reference ownership fixture",
  ...(store
    ? {
        methods: ["structured"],
        backend: { dataStore: store },
        tables: [{ name: "items", description: "Items" }]
      }
    : { methods: ["keyword"] })
});
const store = (name: string): JsonObject => ({ name, title: name, migrations: [] });
const names = z.object({ items: z.array(z.object({ name: z.string() })) });
const writerHeaders = { "x-dev-user-id": "writer" };
const auth = {
  enabled: true,
  users: [
    { id: "admin", roles: ["user", "admin", "superadmin"] },
    { id: "writer", roles: ["user"] }
  ].map((u) => ({ ...u, externalUserId: u.id, displayLabel: u.id, permissionRefs: [] }))
};

async function seed(
  world: DataStoreInstance,
  kind: string,
  config: JsonObject,
  scope: AssetScope = { kind: "instance" },
  published = false
) {
  const name = required(typeof config.name === "string" ? config.name : undefined);
  await applyAtCurrentRevisions(world.stores.configAssets, {
    clientInstanceId,
    mutations: [
      {
        type: "upsert",
        kind,
        name,
        config,
        scope,
        ...(kind === "agent" ? {} : { draft: true })
      }
    ]
  });
  const asset = required(
    await world.stores.configAssets.getConfigAsset({ clientInstanceId, kind, name })
  );
  if (published && kind !== "agent")
    await world.stores.configAssets.publishConfigAssetRevision({
      clientInstanceId,
      kind,
      name,
      assetId: asset.id,
      revision: asset.revision,
      revisionId: asset.activeRevisionId
    });
  return asset;
}

function put(
  world: DataStoreInstance,
  kind: string,
  config: JsonObject,
  workspaceId?: string,
  headers: Record<string, string> = {}
) {
  return world.api.call("assets.put", {
    params: { kind, name: required(typeof config.name === "string" ? config.name : undefined) },
    payload: {
      config,
      expectedRevision: null,
      ...(workspaceId ? { workspaceId } : {})
    },
    headers
  });
}

describe("asset reference owners through the assembled API", () => {
  const { start, person } = useDataStoreInstance();
  async function setup() {
    const world = await start(true, undefined, auth, undefined, true, true);
    const admin = await person(world, "admin", ["user", "admin", "superadmin"]);
    await seed(world, "agent", agent("default"));
    await applyAtCurrentRevisions(world.stores.configAssets, {
      clientInstanceId,
      mutations: [{ type: "setDefaultAgent", agentName: "default" }]
    });
    const workspace = await world.stores.workspaces.createWorkspace({
      clientInstanceId,
      name: "Reference team",
      kind: "shared",
      creatorUserId: asUserId(admin.id)
    });
    const other = await world.stores.workspaces.createWorkspace({
      clientInstanceId,
      name: "Other team",
      kind: "shared",
      creatorUserId: asUserId(admin.id)
    });
    const scope: AssetScope = { kind: "workspace", workspaceId: workspace.id };
    await seed(world, "knowledge_base", kb("ws-a-kb"), scope, true);
    await seed(world, "data_store", store("ws-a-store"), scope);
    return { world, workspace, other, scope };
  }

  for (const kind of ["agent", "knowledge_base"]) {
    const definition = (name: string) =>
      kind === "agent" ? agent(name, { knowledgeBases: ["ws-a-kb"] }) : kb(name, "ws-a-store");
    it(`refuses ${kind} of the instance or another workspace on save, in EN and DE`, async () => {
      const { world, workspace, other } = await setup();
      for (const locale of ["en", "de"])
        for (const owner of [undefined, other.id]) {
          const response = await put(world, kind, definition("outside"), owner, {
            "accept-language": locale
          });
          expect(response.statusCode, response.body).toBe(422);
          const error = errorSchema.parse(response.json()).error;
          expect(error.details).toMatchObject({
            reason: "invalid_scope",
            reference: {
              name: kind === "agent" ? "ws-a-kb" : "ws-a-store",
              owner: { kind: "workspace", workspaceId: workspace.id }
            }
          });
          expect(error.message).toContain(workspace.id);
          expect(error.message).toContain(
            locale === "de" ? "desselben Arbeitsbereichs" : "own workspace or the instance"
          );
        }
    });

    it(`refuses a stored legacy ${kind} on publish and next save, while leaving its live content intact`, async () => {
      const { world } = await setup();
      const config = definition("legacy");
      const legacy = await seed(world, kind, config);
      let revision = legacy.revision;
      if (kind === "agent") {
        const admin = await person(world, "admin", ["user", "admin", "superadmin"]);
        const pending = await world.stores.agentProposals.save({
          clientInstanceId,
          agentId: legacy.id,
          source: { kind: "person", userId: asUserId(admin.id) },
          author: { userId: asUserId(admin.id), release: false },
          baseRevision: legacy.revision,
          expectedDraftRevision: null,
          config,
          savedAt: new Date().toISOString()
        });
        revision = required(pending).revision;
      }
      const published = await world.api.call("assets.publish", {
        params: { kind, name: "legacy" },
        payload: { revision }
      });
      expect(published.statusCode, published.body).toBe(422);
      expect(errorSchema.parse(published.json()).error.details).toMatchObject({
        reason: "invalid_scope"
      });
      const saved = await world.api.call("assets.put", {
        params: { kind, name: "legacy" },
        payload: { config, expectedRevision: legacy.revision }
      });
      expect(saved.statusCode, saved.body).toBe(422);
      expect(errorSchema.parse(saved.json()).error.details).toMatchObject({
        reason: "invalid_scope"
      });
      expect(
        await world.stores.configAssets.getConfigAsset({ clientInstanceId, kind, name: "legacy" })
      ).toMatchObject({ config, revision: legacy.revision });
      // Saving a target or an unrelated asset must not revalidate a legacy source.
      expect((await put(world, "knowledge_base", kb("unrelated"))).statusCode).toBe(200);
      const target = required(
        await world.stores.configAssets.getConfigAsset({
          clientInstanceId,
          kind: "knowledge_base",
          name: "ws-a-kb"
        })
      );
      const updated = await world.api.call("assets.put", {
        params: { kind: "knowledge_base", name: target.name },
        payload: {
          config: kb(target.name),
          workspaceId: target.scope.kind === "workspace" ? target.scope.workspaceId : undefined,
          expectedRevision: target.revision
        }
      });
      expect(updated.statusCode, updated.body).toBe(200);
    });
  }

  it("accepts a same-workspace target and an instance target from a workspace source", async () => {
    const { world, workspace } = await setup();
    await seed(world, "knowledge_base", kb("instance-kb"), undefined, true);
    await seed(world, "data_store", store("instance-store"));
    for (const name of ["ws-a-kb", "instance-kb"]) {
      const response = await put(
        world,
        "agent",
        agent(`uses-${name}`, { knowledgeBases: [name] }),
        workspace.id
      );
      expect(response.statusCode, response.body).toBe(200);
    }
    for (const name of ["ws-a-store", "instance-store"]) {
      const response = await put(world, "knowledge_base", kb(`uses-${name}`, name), workspace.id);
      expect(response.statusCode, response.body).toBe(200);
    }
  });

  it("offers exactly the Knowledge Bases accepted by save, including published use-only access", async () => {
    const { world, workspace } = await setup();
    const writer = await world.stores.users.resolveUserIdentity({
      clientInstanceId,
      authSource: "development",
      externalUserId: "writer",
      displayLabel: "writer",
      roles: ["user"],
      permissionRefs: [],
      permissions: [],
      correlationId: "test"
    });
    async function grant(action: string, scopeKind: string, scopeId: string, effect = "allow") {
      const response = await world.api.call("permissions.grant", {
        payload: {
          holderKind: "user",
          holderId: writer.id,
          action,
          scopeKind,
          ...(scopeKind === "instance" ? {} : { scopeId }),
          effect
        }
      });
      expect(response.statusCode, response.body).toBe(200);
    }
    for (const action of ["agent.read", "agent.write"])
      await grant(action, "workspace", workspace.id);
    await grant("knowledge_base.write", "instance", clientInstanceId);
    const choices = [
      { name: "use-only", action: "knowledge_base.use", published: true },
      { name: "read-only", action: "knowledge_base.read", published: false },
      { name: "unpublished", action: "knowledge_base.use", published: false },
      { name: "hidden", action: undefined, published: true }
    ];
    for (const choice of choices) {
      const asset = await seed(
        world,
        "knowledge_base",
        kb(choice.name),
        undefined,
        choice.published
      );
      if (choice.action) await grant(choice.action, "asset", asset.id);
    }
    const listed = await world.api.call("assets.list", {
      params: { kind: "knowledge_base" },
      headers: writerHeaders
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const offered = names.parse(listed.json()).items.map((item) => item.name);
    expect(offered.sort()).toEqual(["read-only", "use-only"]);
    for (const choice of choices) {
      const response = await put(
        world,
        "agent",
        agent(`uses-${choice.name}`, { knowledgeBases: [choice.name] }),
        workspace.id,
        writerHeaders
      );
      expect(response.statusCode === 200, response.body).toBe(offered.includes(choice.name));
    }
    const badStore = await seed(world, "data_store", store("hidden-store"));
    const denied = await put(
      world,
      "knowledge_base",
      kb("uses-hidden-store", badStore.name),
      workspace.id,
      writerHeaders
    );
    expect(denied.statusCode, denied.body).toBe(422);
  });

  it("declares the complete reference inventory of every kind, including nested calls", async () => {
    const { world } = await setup();
    const kinds = world.execution.configAssets.kinds;
    expect(
      kinds.require("agent").references?.(
        agent("a", {
          skillNames: ["skill"],
          knowledgeBases: ["kb"],
          subagentNames: ["child"],
          toolNames: ["connection.source.query", "data_store.store.query"]
        })
      )
    ).toEqual([
      { kind: "skill", name: "skill" },
      { kind: "knowledge_base", name: "kb" },
      { kind: "agent", name: "child" },
      { kind: "connection", name: "source" },
      { kind: "data_store", name: "store" }
    ]);
    expect(
      kinds
        .require("knowledge_base")
        .references?.({ backend: { dataStore: "store" }, sources: [{ connection: "source" }] })
    ).toEqual([
      { kind: "data_store", name: "store" },
      { kind: "connection", name: "source" }
    ]);
    expect(
      kinds.require("workflow").references?.({
        manifest: dataFlowManifest("flow", ["data_store.store.query", "knowledge.kb.search"], {
          nested: true
        })
      })
    ).toEqual([
      { kind: "connection", name: "source" },
      { kind: "data_store", name: "store" },
      { kind: "knowledge_base", name: "kb" }
    ]);
    expect(
      createAppAssetKind().references?.({
        manifest: { connections: ["source"], dataStores: [{ name: "store" }] }
      })
    ).toEqual([
      { kind: "connection", name: "source" },
      { kind: "data_store", name: "store" }
    ]);
    expect(
      createGuardrailAssetKind().references?.({
        name: "guard",
        displayName: "Guard",
        on: "operation.before_call",
        filter: { agent: "child", operation: "data_store.store.*" },
        check: { kind: "pattern", pattern: "x", reason: "x" },
        outcome: "block"
      })
    ).toEqual([
      { kind: "agent", name: "child" },
      { kind: "data_store", name: "store" }
    ]);
    const connection = createConnectionAssetKind({
      connectorTypes: fixtureConnectorTypes,
      egress: { admits: () => true }
    });
    for (const kind of [kinds.require("skill"), kinds.require("data_store"), connection])
      expect(kind.references?.({})).toEqual([]);
    for (const kind of kinds.kinds) expect(kind.references, kind.kind).toBeTypeOf("function");
    // Hostile and unparseable input is left to schema validation, without a hook throwing.
    for (const kind of kinds.kinds) expect(() => kind.references?.(null), kind.kind).not.toThrow();
  });

  it("counts legacy owner violations read-only, across stored agent drafts and published revisions", async () => {
    const { world } = await setup();
    await seed(world, "agent", agent("bad-agent", { knowledgeBases: ["ws-a-kb", "ws-a-kb"] }));
    await seed(world, "knowledge_base", kb("bad-kb", "ws-a-store"), undefined, true);
    const live = required(
      await world.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "agent",
        name: "default"
      })
    );
    const admin = await person(world, "admin", ["user", "admin", "superadmin"]);
    await world.stores.agentProposals.save({
      clientInstanceId,
      agentId: live.id,
      source: { kind: "person", userId: asUserId(admin.id) },
      baseRevision: live.revision,
      expectedDraftRevision: null,
      config: agent("default", { knowledgeBases: ["ws-a-kb"] }),
      savedAt: new Date().toISOString()
    });
    const query = await readFile(
      new URL("../scripts/preflight-reference-owners.sql", import.meta.url),
      "utf8"
    );
    const rows = await withTestSql(async (sql) =>
      sql.begin("read only", (transaction) =>
        transaction.unsafe(query.replace("BEGIN READ ONLY;", "").replace("COMMIT;", ""))
      )
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ refused_references: "3", affected_assets: "3" });
  });
});
