import {
  createAppAssetKind,
  createConnectionAssetKind,
  createGuardrailAssetKind
} from "@work-shape/catalyst-server";
import { appActionsSchema } from "@work-shape/catalyst-api-contract";
import { parseWorkflowManifest } from "@work-shape/catalyst-workflows";
import { setupAppActions } from "./support/app-actions";
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
  ].map((u) => ({
    ...u,
    externalUserId: u.id,
    displayLabel: u.id,
    permissionRefs: [],
    permissions: u.id === "writer" ? ["config_assets.read", "config_assets.write"] : []
  }))
};

async function seed(
  world: Pick<DataStoreInstance, "stores">,
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
          expect(error.message).toContain(workspace.name);
          expect(error.message).not.toContain(workspace.id);
          expect(error.message).toContain(
            owner ? other.name : locale === "de" ? "der Instanz" : "the instance"
          );
          if (locale === "de" && kind === "agent")
            expect(error.message).toContain("Wissensdatenbank");
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
      // Unrelated assets stay editable; touching either end checks the owner pair.
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
      expect(updated.statusCode, updated.body).toBe(kind === "agent" ? 422 : 200);
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
    const { world, workspace, other, scope } = await setup();
    const writer = await world.stores.users.resolveUserIdentity({
      clientInstanceId,
      authSource: "development",
      externalUserId: "writer",
      displayLabel: "writer",
      roles: ["user"],
      permissionRefs: [],
      permissions: ["config_assets.read", "config_assets.write"],
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
    await grant("knowledge_base.write", "instance", clientInstanceId);
    const choices = [
      { name: "use-only", action: "knowledge_base.use", published: true },
      { name: "read-only", action: "knowledge_base.read", published: false },
      { name: "unpublished", action: "knowledge_base.use", published: false },
      { name: "hidden", action: undefined, published: true },
      { name: "own-use", action: "knowledge_base.use", published: true, scope },
      { name: "own-read", action: "knowledge_base.read", published: false, scope },
      { name: "own-hidden", action: undefined, published: true, scope },
      {
        name: "other-read",
        action: "knowledge_base.read",
        published: true,
        scope: { kind: "workspace", workspaceId: other.id } satisfies AssetScope
      }
    ];
    for (const choice of choices) {
      const asset = await seed(
        world,
        "knowledge_base",
        kb(choice.name),
        choice.scope,
        choice.published
      );
      if (choice.action) await grant(choice.action, "asset", asset.id);
    }
    for (const owner of [undefined, workspace.id]) {
      const offered: string[] = [];
      for (const workspaceId of owner === undefined ? [undefined] : [owner, undefined]) {
        const listed = await world.api.call("assets.list", {
          params: { kind: "knowledge_base" },
          query: workspaceId === undefined ? {} : { workspaceId },
          headers: writerHeaders
        });
        expect(listed.statusCode, listed.body).toBe(200);
        offered.push(...names.parse(listed.json()).items.map((item) => item.name));
      }
      expect(offered.sort()).toEqual(
        owner === undefined
          ? ["read-only", "use-only"]
          : ["own-read", "own-use", "read-only", "use-only"]
      );
      for (const choice of choices) {
        const response = await put(
          world,
          "agent",
          agent(`uses-${owner ? "ws" : "instance"}-${choice.name}`, {
            knowledgeBases: [choice.name]
          }),
          owner,
          writerHeaders
        );
        expect(response.statusCode === 200, response.body).toBe(offered.includes(choice.name));
      }
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

  it("offers exactly the App actions accepted by instance and workspace agents, with owner and read rights together", async () => {
    const t = await setupAppActions();
    try {
      const own: AssetScope = { kind: "workspace", workspaceId: t.workspaceId };
      const other = await t.stores.workspaces.createWorkspace({
        clientInstanceId,
        name: "Other App team",
        kind: "shared",
        creatorUserId: t.admin.id
      });
      const orders = required(
        await t.stores.configAssets.getConfigAsset({
          clientInstanceId,
          kind: "app",
          name: "orders"
        })
      );
      const choices = [
        { name: "own-app", scope: own, read: true, published: true },
        {
          name: "other-app",
          scope: { kind: "workspace", workspaceId: other.id } satisfies AssetScope,
          read: true,
          published: true
        },
        { name: "hidden-app", scope: own, read: false, published: true },
        { name: "draft-app", scope: own, read: false, published: false }
      ];
      for (const choice of choices) {
        const asset = await seed(
          t,
          "app",
          { ...required(orders.config), name: choice.name },
          choice.scope,
          choice.published
        );
        if (choice.read) await t.grant(t.lena.id, "app.read", { assetId: asset.id });
      }
      const listed = await t.expectOk(t.lena.id, "apps.actions.list");
      const catalog = appActionsSchema.parse(listed.json()).apps;
      for (const owner of [undefined, t.workspaceId]) {
        const offered = catalog
          .filter((app) => app.scope.kind === "instance" || app.scope.workspaceId === owner)
          .filter((app) => app.actions.some((action) => action.name === "load" && action.agentTool))
          .map((app) => app.name);
        expect(offered.sort()).toEqual(owner === undefined ? [] : ["own-app"]);
        for (const choice of choices) {
          const name = `parity-${owner ? "ws" : "instance"}-${choice.name}`;
          const source = await seed(t, "agent", agent(name), owner === undefined ? undefined : own);
          for (const action of ["agent.read", "agent.write"])
            await t.grant(t.lena.id, action, { assetId: source.id });
          const response = await t.call(t.lena.id, "assets.put", {
            params: { kind: "agent", name },
            payload: {
              config: agent(name, { toolNames: [`app.${choice.name}.load`] }),
              expectedRevision: source.revision,
              ...(owner ? { workspaceId: owner } : {})
            }
          });
          expect(response.statusCode === 200, response.body).toBe(offered.includes(choice.name));
        }
      }
      // Membership supplies app.use, which save accepts even without app.read.
      const memberCatalog = appActionsSchema.parse(
        (await t.expectOk(t.kai.id, "apps.actions.list")).json()
      );
      expect(
        memberCatalog.apps
          .find((app) => app.name === "orders")
          ?.actions.some((action) => action.toolName === "app.orders.load" && action.agentTool)
      ).toBe(true);
      const memberSource = await seed(t, "agent", agent("member-choices"), own);
      for (const action of ["agent.read", "agent.write"])
        await t.grant(t.kai.id, action, { assetId: memberSource.id });
      const saved = await t.call(t.kai.id, "assets.put", {
        params: { kind: "agent", name: memberSource.name },
        payload: {
          workspaceId: t.workspaceId,
          expectedRevision: memberSource.revision,
          config: agent(memberSource.name, { toolNames: ["app.orders.load"] })
        }
      });
      expect(saved.statusCode, saved.body).toBe(200);
    } finally {
      await t.closeAll();
    }
  });

  it("localizes Workflow references to unread Knowledge Bases in EN and DE without revealing their owner", async () => {
    const { world, scope } = await setup();
    await seed(world, "knowledge_base", kb("hidden-kb"), scope, true);
    const writer = await world.stores.users.resolveUserIdentity({
      clientInstanceId,
      authSource: "development",
      externalUserId: "writer",
      displayLabel: "writer",
      roles: ["user"],
      permissions: ["config_assets.read", "config_assets.write"],
      permissionRefs: [],
      correlationId: "test"
    });
    for (const action of ["workflow.read", "workflow.write"]) {
      const granted = await world.api.call("permissions.grant", {
        payload: {
          holderKind: "user",
          holderId: writer.id,
          action,
          effect: "allow",
          scopeKind: "instance"
        }
      });
      expect(granted.statusCode, granted.body).toBe(200);
    }
    for (const locale of ["en", "de"]) {
      const name = `unknown-${locale}`;
      const response = await put(
        world,
        "workflow",
        { name, manifest: dataFlowManifest(name, ["knowledge.hidden-kb.search"]) },
        undefined,
        { ...writerHeaders, "accept-language": locale }
      );
      expect(response.statusCode, response.body).toBe(422);
      expect(response.body).toContain(
        locale === "de"
          ? "verweist auf unbekanntes Asset: Wissensdatenbank"
          : "references unknown Knowledge Base"
      );
      expect(response.body).not.toContain("Reference team");
    }
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
          toolNames: [
            "connection.source.query",
            "data_store.store.query",
            "knowledge.kb.search",
            "workflow.flow.start",
            "app.orders.load"
          ]
        })
      )
    ).toEqual([
      { kind: "skill", name: "skill" },
      { kind: "knowledge_base", name: "kb" },
      { kind: "agent", name: "child" },
      { kind: "connection", name: "source" },
      { kind: "data_store", name: "store" },
      { kind: "knowledge_base", name: "kb" },
      { kind: "workflow", name: "flow" },
      { kind: "app", name: "orders" }
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
        manifest: {
          connections: ["source"],
          dataStores: [{ name: "store" }],
          actions: [
            {
              name: "call",
              file: "actions/call.action.yaml",
              kind: "connection",
              effect: "reading",
              connection: "action-source",
              operation: "query",
              input: { schema: { type: "object", properties: {} }, mapping: {} }
            },
            {
              name: "read",
              file: "actions/read.action.yaml",
              kind: "sql",
              effect: "reading",
              dataStore: "action-store",
              parameters: [],
              statement: "select 1",
              input: { schema: { type: "object", properties: {} } }
            },
            {
              name: "start",
              file: "actions/start.action.yaml",
              kind: "workflow",
              effect: "changing",
              workflow: "child",
              input: { schema: { type: "object", properties: {} }, mapping: {} }
            }
          ]
        }
      })
    ).toEqual([
      { kind: "connection", name: "source" },
      { kind: "data_store", name: "store" },
      { kind: "connection", name: "action-source" },
      { kind: "data_store", name: "action-store" },
      { kind: "workflow", name: "child" }
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
    ).toEqual([]);
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

  it("inventories Workflow tools, notice links, nested Workflow calls and onFailure independently", async () => {
    const { world, workspace } = await setup();
    const manifest = dataFlowManifest("inventory", []);
    manifest.kind = "process";
    manifest.tools = [
      "app.tool-app.load",
      "connection.tool-source.echo",
      "data_store.tool-store.query",
      "knowledge.tool-kb.search",
      "workflow.tool-flow.start"
    ];
    manifest.onFailure = "workflow.recovery";
    manifest.steps = [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      {
        id: "branch",
        name: "Branch",
        type: "loop",
        items: { step: "start", path: "input.items" },
        steps: [{ id: "child", name: "Child", type: "workflow", workflow: "nested", input: {} }]
      },
      {
        id: "tell",
        name: "Tell",
        type: "notify",
        to: { users: ["admin"] },
        channels: ["inbox"],
        title: { value: "Ready" },
        text: { value: "Ready" },
        link: { kind: "app", app: "notice-app", workspaceId: workspace.id }
      },
      { id: "result", name: "Result", type: "output", input: {} }
    ];
    // Failure Workflows are declared but not executable yet. Inventory must still see them.
    expect(parseWorkflowManifest(manifest)).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ path: "onFailure" })]
    });
    expect(
      world.execution.configAssets.kinds.require("workflow").references?.({ manifest })
    ).toEqual([
      { kind: "workflow", name: "nested" },
      { kind: "app", name: "notice-app" },
      { kind: "app", name: "tool-app" },
      { kind: "connection", name: "tool-source" },
      { kind: "data_store", name: "tool-store" },
      { kind: "knowledge_base", name: "tool-kb" },
      { kind: "workflow", name: "tool-flow" },
      { kind: "workflow", name: "recovery" }
    ]);
  });

  it("saves instance Workflows reaching workspace stores, KBs, App actions and notice links", async () => {
    const { world, workspace, scope } = await setup();
    await seed(
      world,
      "app",
      {
        name: "ws-app",
        title: "Workspace App",
        manifest: {
          actions: [
            {
              name: "load",
              file: "actions/load.action.yaml",
              kind: "connection",
              effect: "reading",
              connection: "source",
              operation: "echo",
              input: { schema: { type: "object", properties: {} }, mapping: {} }
            }
          ]
        }
      },
      scope,
      true
    );
    const manifest = dataFlowManifest("workspace-flow", [
      "data_store.ws-a-store.query",
      "knowledge.ws-a-kb.search",
      "app.ws-app.load"
    ]);
    manifest.kind = "process";
    manifest.tools = ["app.ws-app.load"];
    manifest.steps = [
      ...(Array.isArray(manifest.steps) ? manifest.steps.slice(0, -1) : []),
      {
        id: "tell",
        name: "Tell",
        type: "notify",
        to: { users: ["admin"] },
        channels: ["inbox"],
        title: { value: "Ready" },
        text: { value: "Ready" },
        link: { kind: "app", app: "ws-app", workspaceId: workspace.id }
      },
      { id: "result", name: "Result", type: "output", input: {} }
    ];
    const saved = await put(world, "workflow", { name: "workspace-flow", manifest });
    expect(saved.statusCode, saved.body).toBe(200);
    // The exception belongs to Workflows alone, including when only the target changes.
    const refused = await put(
      world,
      "agent",
      agent("instance-app-agent", { toolNames: ["app.ws-app.load"] })
    );
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.body).toContain("invalid_scope");
  });

  it("saves instance guardrails filtering workspace agents, Data Stores and Knowledge Bases", async () => {
    const { world, scope } = await setup();
    await seed(world, "agent", agent("ws-agent"), scope);
    const filters: JsonObject[] = [
      { agent: "ws-agent" },
      { operation: "data_store.ws-a-store.query" },
      { operation: "knowledge.ws-a-kb.search" }
    ];
    for (const [index, filter] of filters.entries()) {
      const saved = await put(world, "guardrail", {
        name: `instance-filter-${index}`,
        displayName: "Govern workspace events",
        on: "operation.before_call",
        filter,
        check: { kind: "pattern", pattern: "x", reason: "x" },
        outcome: "block"
      });
      expect(saved.statusCode, saved.body).toBe(200);
    }
  });

  it("refuses creating a workspace target named by an existing instance source", async () => {
    const { world, workspace } = await setup();
    // Legacy drafts can name a target before it exists. Creating it must check both owners.
    await seed(world, "agent", agent("waiting", { knowledgeBases: ["future-kb"] }));
    const saved = await put(world, "knowledge_base", kb("future-kb"), workspace.id);
    expect(saved.statusCode, saved.body).toBe(422);
    expect(saved.body).toContain("invalid_scope");
    expect(
      await world.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "knowledge_base",
        name: "future-kb"
      })
    ).toBeUndefined();
  });

  it("counts legacy owner violations read-only, across stored agent drafts and published revisions", async () => {
    const { world } = await setup();
    await seed(world, "agent", agent("bad-agent", { knowledgeBases: ["ws-a-kb", "ws-a-kb"] }));
    await seed(world, "knowledge_base", kb("bad-kb", "ws-a-store"), undefined, true);
    // The preflight uses the same two exceptions as writes, across live and draft revisions.
    await seed(
      world,
      "workflow",
      {
        name: "allowed-flow",
        manifest: dataFlowManifest("allowed-flow", [
          "data_store.ws-a-store.query",
          "knowledge.ws-a-kb.search"
        ])
      },
      undefined,
      true
    );
    await seed(world, "guardrail", {
      name: "allowed-filter",
      displayName: "Allowed filter",
      on: "operation.before_call",
      filter: { operation: "data_store.ws-a-store.query" },
      check: { kind: "pattern", pattern: "x", reason: "x" },
      outcome: "block"
    });
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
