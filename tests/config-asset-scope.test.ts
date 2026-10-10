import { describe, expect, it } from "vitest";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import { AppError, type AssetScope, type ConfigAssetMutation } from "@vivd-catalyst/core";
import { applyValidatedConfigAssetMutations } from "@vivd-catalyst/chat-server";
import {
  agent,
  clientInstanceId,
  setupAccessInstance as setup,
  skill
} from "./support/access-instance";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";
import { createTestAssetKinds } from "./support/test-instance";
import { withTestSql } from "./support/test-sql";

// Who owns an asset. Every asset is owned by the instance until the first kind a workspace can
// own: the columns and the indexes exist, the write path refuses the scope.

/** A workspace that exists: an asset names its owner through a foreign key. */
async function createWorkspace(t: Awaited<ReturnType<typeof setup>>, name = "Scope test") {
  const workspace = await t.stores.workspaces.createWorkspace({
    clientInstanceId,
    kind: "shared",
    name,
    creatorUserId: t.admin.id
  });
  return workspace.id;
}

describe("scope on a config asset", () => {
  it("stores an asset written without a scope as owned by the instance", async () => {
    const t = await setup();
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "skill", name: "research" },
      payload: { config: skill("research") }
    });

    const stored = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "skill",
      name: "research"
    });
    expect(stored?.scope).toEqual({ kind: "instance" });
    const rows = await withTestSql(
      (sql) => sql`select name, scope_kind, scope_id from config_assets order by name`
    );
    expect(rows.map((row) => ({ ...row }))).toEqual([
      { name: "assistant", scope_kind: "instance", scope_id: null },
      { name: "research", scope_kind: "instance", scope_id: null }
    ]);
  });

  it("refuses a workspace scope on the write path with invalid_scope and writes nothing", async () => {
    const t = await setup();
    const validationRefs = {
      modelProviderIds: ["local"],
      modelBindingIds: [],
      modelBindings: [],
      fastModeModelBindingIds: [],
      reasoningEfforts: [],
      enabledToolNames: []
    };
    const config = parseClientInstanceConfig({
      version: 1,
      clientInstance: { id: clientInstanceId, displayName: "Scope", environment: "development" },
      auth: {},
      infrastructure: { models: { local: { provider: "deterministic", model: "local" } } }
    });
    const write = applyValidatedConfigAssetMutations(
      {
        config,
        clientInstanceId,
        configAssets: {
          store: t.stores.configAssets,
          source: createStaticConfigAssetSource({}),
          kinds: createTestAssetKinds({ config, validationRefs }),
          validationRefs
        }
      },
      {
        clientInstanceId,
        mutations: [
          {
            type: "upsert",
            kind: "agent",
            name: "team-agent",
            config: agent("team-agent"),
            scope: { kind: "workspace", workspaceId: await createWorkspace(t) }
          }
        ]
      }
    );

    await expect(write).rejects.toBeInstanceOf(AppError);
    await expect(write).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { reason: "invalid_scope" }
    });
    await expect(
      t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "agent", name: "team-agent" })
    ).resolves.toBeUndefined();
  });

  it("keeps the scope an asset was created with and refuses a write that means another", async () => {
    const t = await setup();
    const workspaceId = await createWorkspace(t);
    const otherWorkspaceId = await createWorkspace(t, "Another");
    const write = (mutation: ConfigAssetMutation) =>
      t.stores.configAssets.applyConfigAssetMutations({ clientInstanceId, mutations: [mutation] });
    const upsert = (scope?: AssetScope) =>
      write({
        type: "upsert",
        kind: "skill",
        name: "team-notes",
        config: skill("team-notes"),
        ...(scope ? { scope } : {})
      });
    const invalidScope = { code: "VALIDATION_FAILED", details: { reason: "invalid_scope" } };
    const owner: AssetScope = { kind: "workspace", workspaceId };
    await upsert(owner);

    // A write that names no scope means the instance's own assets: it never reaches this one.
    await expect(upsert()).rejects.toMatchObject(invalidScope);
    await expect(upsert({ kind: "instance" })).rejects.toMatchObject(invalidScope);
    await expect(
      upsert({ kind: "workspace", workspaceId: otherWorkspaceId })
    ).rejects.toMatchObject(invalidScope);
    // Neither does a delete, with or without a scope that is not the owner's.
    await expect(
      write({ type: "delete", kind: "skill", name: "team-notes" })
    ).rejects.toMatchObject(invalidScope);
    const stored = () =>
      t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "skill", name: "team-notes" });
    expect(await stored()).toMatchObject({ revision: 1, status: "active", scope: owner });

    await upsert(owner);
    expect(await stored()).toMatchObject({ revision: 2, scope: owner });
    await write({ type: "delete", kind: "skill", name: "team-notes", scope: owner });
    expect(await stored()).toMatchObject({ revision: 3, status: "deleted", scope: owner });
    // The name stays with its owner across the delete.
    await expect(upsert()).rejects.toMatchObject(invalidScope);
  });

  it("holds scope_id null exactly for instance scope, and a name once per kind", async () => {
    const t = await setup();
    const workspaceId = await createWorkspace(t);
    await t.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      mutations: [{ type: "upsert", kind: "skill", name: "research", config: skill("research") }]
    });
    const insert = (id: string, name: string, scopeKind: string, scopeId: string | null) =>
      withTestSql(
        (sql) => sql`
          insert into config_assets
            (id, client_instance_id, kind, name, scope_kind, scope_id, status, active_revision_id, created_at, updated_at)
          values (${id}, ${clientInstanceId}, 'skill', ${name}, ${scopeKind}, ${scopeId}, 'active', 'none', now(), now())`
      );

    await expect(insert("a1", "one", "instance", workspaceId)).rejects.toThrow(
      "config_assets_scope_id_check"
    );
    await expect(insert("a2", "two", "workspace", null)).rejects.toThrow(
      "config_assets_scope_id_check"
    );
    await expect(insert("a3", "three", "team", "x")).rejects.toThrow(
      "config_assets_scope_kind_check"
    );
    await insert("a4", "four", "workspace", workspaceId);
    // The owner of an asset is a workspace that exists.
    await expect(insert("a6", "six", "workspace", "cw_none")).rejects.toThrow(
      "config_assets_scope_workspace_fk"
    );
    // The name of an instance asset is taken for every workspace, too.
    await expect(insert("a5", "research", "workspace", workspaceId)).rejects.toThrow(
      "config_assets_client_kind_name_idx"
    );
  });

  it("lists the assets of a name prefix as a range of the prefix index", async () => {
    const t = await setup();
    const names = ["kai-tax", "kai-intake", "kai_tax", "kaiser", "lena-notes"];
    await t.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      mutations: names.map((name) => ({
        type: "upsert" as const,
        kind: "skill" as const,
        name,
        config: skill(name)
      }))
    });
    const list = async (namePrefix: string) =>
      (
        await t.stores.configAssets.listActiveConfigAssets({
          clientInstanceId,
          kind: "skill",
          namePrefix
        })
      ).map((asset) => asset.name);

    expect(await list("kai-")).toEqual(["kai-intake", "kai-tax"]);
    // A prefix is matched as text: `_` and `%` are not wildcards.
    expect(await list("kai_")).toEqual(["kai_tax"]);
    expect(await list("%")).toEqual([]);

    // The planner takes the prefix index once the table is large enough for the choice to
    // matter: 5,000 further skills of this instance, 50 of them under the prefix.
    const plan = await withTestSql(async (sql) => {
      await sql`
        insert into config_assets
          (id, client_instance_id, kind, name, status, active_revision_id, created_at, updated_at)
        select 'bulk_' || n, ${clientInstanceId}, 'skill',
          case when n % 100 = 0 then 'kai-bulk-' || n else 'bulk-' || n end,
          'active', 'none', now(), now()
        from generate_series(1, 5000) as n`;
      await sql`analyze config_assets`;
      return sql`
        explain select id from config_assets
        where client_instance_id = ${clientInstanceId} and kind = 'skill' and name like 'kai-%'`;
    });
    const text = plan.map((row) => Object.values(row).join(" ")).join("\n");
    expect(text).toContain("config_assets_client_kind_name_prefix_idx");
    expect(text).toMatch(/Index Cond: .*name ~>=~ 'kai-'/u);
  });
});
