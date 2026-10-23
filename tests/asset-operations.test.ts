import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agent, clientInstanceId, errorSchema, skill } from "./support/access-instance";
import {
  assetPageSchema as pageSchema,
  setupWorkspaceHolder as setup,
  type AssetCall as Call,
  type WorkspaceHolderInstance
} from "./support/asset-operations";
import { withTestSql } from "./support/test-sql";

// The asset operations, each called as an administrator, as a holder of rights in one
// Shared Workspace and as a user who holds nothing. Every call is an Operation Run. What a call may
// reach across scopes, and what a definition is checked for, is in asset-operation-scopes.

const writeSchema = z.object({
  version: z.number(),
  revision: z.number(),
  warnings: z.array(z.unknown())
});
const syncRefusalSchema = z.object({
  reason: z.literal("sync_refused"),
  items: z.array(
    z.object({
      index: z.number(),
      type: z.string(),
      kind: z.string(),
      name: z.string().optional(),
      status: z.enum(["refused", "not_applied"]),
      error: z
        .object({
          code: z.string(),
          message: z.string(),
          action: z.string().optional(),
          currentRevision: z.number().nullable().optional()
        })
        .optional()
    })
  )
});

describe("assets.list", () => {
  it("shows a holder of rights in a workspace the assets it owns and nobody anything without a right", async () => {
    const t = await setup();
    await t.put(t.admin.id, "agent", "kai-intake", t.kaiTeam);
    await t.put(t.admin.id, "agent", "kai-tax", t.kaiTeam);
    await t.put(t.admin.id, "agent", "lena-notes", t.lenaTeam);
    await t.put(t.admin.id, "skill", "kai-guide", t.kaiTeam);
    const agents = (workspaceId?: string) => ({
      params: { kind: "agent" },
      ...(workspaceId === undefined ? {} : { query: { workspaceId } })
    });

    // Each owner is its own list.
    expect(await t.names(t.admin.id, "assets.list", agents())).toEqual(["assistant"]);
    expect(await t.names(t.admin.id, "assets.list", agents(t.kaiTeam))).toEqual([
      "kai-intake",
      "kai-tax"
    ]);
    expect(await t.names(t.admin.id, "assets.list", agents(t.lenaTeam))).toEqual(["lena-notes"]);
    expect(await t.names(t.kai.id, "assets.list", agents(t.kaiTeam))).toEqual([
      "kai-intake",
      "kai-tax"
    ]);
    expect(await t.names(t.kai.id, "assets.list", agents())).toEqual([]);
    expect(await t.names(t.kai.id, "assets.list", agents(t.lenaTeam))).toEqual([]);
    expect(await t.names(t.lena.id, "assets.list", agents(t.kaiTeam))).toEqual([]);
    // A kind is one list: the skill of the workspace is in the other one.
    expect(
      await t.names(t.kai.id, "assets.list", {
        params: { kind: "skill" },
        query: { workspaceId: t.kaiTeam }
      })
    ).toEqual(["kai-guide"]);

    const listed = pageSchema.parse(
      (await t.expectOk(t.kai.id, "assets.list", agents(t.kaiTeam))).json()
    );
    expect(listed.items[0]).toEqual({
      id: expect.any(String),
      kind: "agent",
      name: "kai-intake",
      title: "kai-intake",
      scope: { kind: "workspace", workspaceId: t.kaiTeam },
      revision: 1
    });
    // A summary carries no content.
    expect(Object.keys(listed.items[0] ?? {})).not.toContain("config");
    // What the list shows is what `assets.get` answers, and nothing else.
    await t.expectOk(t.kai.id, "assets.get", {
      params: { kind: "agent", name: "kai-tax" },
      query: { workspaceId: t.kaiTeam }
    });
    await t.expectRefused(
      t.kai.id,
      "assets.get",
      { params: { kind: "agent", name: "lena-notes" }, query: { workspaceId: t.lenaTeam } },
      t.forbidden("agent.read", "no_grant")
    );
  });

  it("filters by name prefix and by text, and pages by name", async () => {
    const t = await setup();
    for (const name of ["kai-intake", "kai-tax", "kai-Taxes-2", "lena-tax"]) {
      await t.put(t.admin.id, "agent", name, t.kaiTeam);
    }
    const list = (query: Record<string, string | number>) =>
      t.names(t.admin.id, "assets.list", {
        params: { kind: "agent" },
        query: { workspaceId: t.kaiTeam, ...query }
      });

    expect(await list({ prefix: "kai-" })).toEqual(["kai-Taxes-2", "kai-intake", "kai-tax"]);
    expect(await list({ text: "TAX" })).toEqual(["kai-Taxes-2", "kai-tax", "lena-tax"]);
    expect(await list({ prefix: "kai-", text: "tax" })).toEqual(["kai-Taxes-2", "kai-tax"]);
    // A prefix is matched as text, not as a pattern.
    expect(await list({ prefix: "kai_" })).toEqual([]);

    const first = pageSchema.parse(
      (
        await t.expectOk(t.kai.id, "assets.list", {
          params: { kind: "agent" },
          query: { workspaceId: t.kaiTeam, limit: 2 }
        })
      ).json()
    );
    expect(first.items.map((item) => item.name)).toEqual(["kai-Taxes-2", "kai-intake"]);
    expect(first.nextCursor).toBeDefined();
    expect(
      await t.names(t.kai.id, "assets.list", {
        params: { kind: "agent" },
        query: { workspaceId: t.kaiTeam, limit: 2, cursor: first.nextCursor }
      })
    ).toEqual(["kai-tax", "lena-tax"]);
    await t.expectRefused(
      t.admin.id,
      "assets.list",
      { params: { kind: "widget" } },
      { status: 422, code: "VALIDATION_FAILED" }
    );
  });

  it("finds a title by text that holds a quote or a backslash, which its JSON escapes", async () => {
    const t = await setup();
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "agent", name: "kai-quoted" },
      payload: { config: agent("kai-quoted", { displayName: 'The "Q4" share at C:\\ledger' }) }
    });
    const list = (text: string) =>
      t.names(t.admin.id, "assets.list", { params: { kind: "agent" }, query: { text } });

    expect(await list('"Q4"')).toEqual(["kai-quoted"]);
    expect(await list("C:\\ledger")).toEqual(["kai-quoted"]);
  });

  it("reads ten thousand assets through the name index, for a caller who may read few of them", async () => {
    const t = await setup();
    // 10,000 agents of this instance, each with its active revision; Kai may read every
    // hundredth of them, through a grant on that one agent.
    const plan = await withTestSql(async (sql) => {
      await sql`
        insert into config_assets
          (id, client_instance_id, kind, name, status, active_revision_id, created_at, updated_at)
        select 'bulk_' || n, ${clientInstanceId}, 'agent',
          case when n % 100 = 0 then 'kai-bulk-' || lpad(n::text, 5, '0')
               else 'bulk-' || lpad(n::text, 5, '0') end,
          'active', 'bulkrev_' || n, now(), now()
        from generate_series(1, 10000) as n`;
      await sql`
        insert into permission_grants
          (id, client_instance_id, holder_kind, holder_id, action, scope_kind, scope_id, effect,
           granted_by)
        select 'bulkgrant_' || n, ${clientInstanceId}, 'user', ${t.kai.id}, 'agent.read', 'asset',
          'bulk_' || n, 'allow', ${t.admin.id}
        from generate_series(100, 10000, 100) as n`;
      await sql`
        insert into config_asset_revisions
          (id, client_instance_id, asset_id, revision, operation, config, global_version, created_at)
        select 'bulkrev_' || n, ${clientInstanceId}, 'bulk_' || n, 1, 'create',
          jsonb_build_object('name', 'bulk'), 1, now()
        from generate_series(1, 10000) as n`;
      await sql`analyze config_assets`;
      // The read of the list: one kind in one scope, after a name, in the byte order of names.
      return sql`
        explain select id, kind, name, scope_kind, scope_id from config_assets
        where client_instance_id = ${clientInstanceId} and kind = 'agent' and status = 'active'
          and scope_kind = 'instance' and name ~>~ 'bulk-05000'
        order by name using ~<~ limit 1000`;
    });
    const text = plan.map((row) => Object.values(row).join(" ")).join("\n");
    expect(text).toContain("config_assets_client_kind_name_prefix_idx");
    expect(text).not.toContain("Seq Scan");
    expect(text).not.toContain("Sort");

    // Kai may read 100 of the 10,000, spread over the whole range of names.
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = pageSchema.parse(
        (
          await t.expectOk(t.kai.id, "assets.list", {
            params: { kind: "agent" },
            query: { limit: 40, ...(cursor === undefined ? {} : { cursor }) }
          })
        ).json()
      );
      pages.push(page.items.map((item) => item.name));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(pages.map((page) => page.length)).toEqual([40, 40, 20]);
    const all = pages.flat();
    expect(new Set(all).size).toBe(100);
    expect(all.every((name) => name.startsWith("kai-bulk-"))).toBe(true);
    expect(all).toEqual([...all].sort());
    // The administrator's page is the first names of all of them.
    expect(
      await t.names(t.admin.id, "assets.list", { params: { kind: "agent" }, query: { limit: 3 } })
    ).toEqual(["assistant", "bulk-00001", "bulk-00002"]);
  });
});

describe("the instance default and the availability of an asset", () => {
  const readSchema = z.object({
    name: z.string(),
    isDefault: z.literal(true).optional(),
    availability: z
      .object({
        mode: z.string(),
        personalWorkspaces: z.boolean(),
        collaborationWorkspaceIds: z.array(z.string())
      })
      .optional()
  });
  const listSchema = z.object({
    items: z.array(z.object({ name: z.string(), isDefault: z.literal(true).optional() }))
  });

  it("marks the default agent in the read and in the list, and no other asset", async () => {
    const t = await setup();
    await t.put(t.admin.id, "agent", "kai-intake");
    await t.put(t.admin.id, "skill", "kai-guide");
    // Kai reads the two through a grant on each.
    await t.grant(t.kai.id, "agent.read", { assetId: await t.assetId("agent", "kai-intake") });
    await t.grant(t.kai.id, "skill.read", { assetId: await t.assetId("skill", "kai-guide") });
    await t.stores.configAssets.setAgentAvailability({
      clientInstanceId,
      agentName: "kai-intake",
      availability: { mode: "selected", personalWorkspaces: true, collaborationWorkspaceIds: [] }
    });
    const read = async (userId: string, kind: string, name: string) =>
      readSchema.parse((await t.expectOk(userId, "assets.get", { params: { kind, name } })).json());

    expect(await read(t.admin.id, "agent", "assistant")).toEqual({
      name: "assistant",
      isDefault: true,
      availability: { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] }
    });
    // Another agent is no default and carries its own availability, for a reader of it too.
    expect(await read(t.kai.id, "agent", "kai-intake")).toEqual({
      name: "kai-intake",
      availability: { mode: "selected", personalWorkspaces: true, collaborationWorkspaceIds: [] }
    });
    // A kind that holds no default and is offered in no workspace carries neither.
    expect(await read(t.kai.id, "skill", "kai-guide")).toEqual({ name: "kai-guide" });

    const agents = listSchema.parse(
      (await t.expectOk(t.admin.id, "assets.list", { params: { kind: "agent" } })).json()
    );
    expect(agents.items).toEqual([{ name: "assistant", isDefault: true }, { name: "kai-intake" }]);
    const skills = listSchema.parse(
      (await t.expectOk(t.admin.id, "assets.list", { params: { kind: "skill" } })).json()
    );
    expect(skills.items).toEqual([{ name: "kai-guide" }]);
  });

  it("leaves the availability out for an agent that has no stored record", async () => {
    const t = await setup();
    await t.put(t.admin.id, "agent", "kai-intake");
    const assetId = await t.assetId("agent", "kai-intake");
    await t.grant(t.kai.id, "agent.read", { assetId });
    await withTestSql(async (sql) => {
      await sql`delete from config_asset_availability where asset_id = ${assetId}`;
    });

    const read = readSchema.parse(
      (
        await t.expectOk(t.kai.id, "assets.get", { params: { kind: "agent", name: "kai-intake" } })
      ).json()
    );
    expect(read).toEqual({ name: "kai-intake" });
  });
});

describe("assets.put, assets.delete and assets.revert", () => {
  // Fails without the change: a put without a revision created, a conflict answered 409
  // without who and when, and `null` brought a deleted asset back.
  it("names the revision it was made against: null creates, a missing one is refused, a stale one is told the current", async () => {
    const t = await setup();
    const put = (userId: string, instructions: string, expectedRevision?: number | null) =>
      t.call(userId, "assets.put", {
        params: { kind: "agent", name: "kai-intake" },
        payload: {
          config: agent("kai-intake", { instructions }),
          // An explicit `undefined` keeps the helper from filling in the current revision.
          expectedRevision,
          workspaceId: t.kaiTeam
        }
      });

    // No revision named: refused, naming the asset, and nothing is written.
    const blind = await put(t.kai.id, "Blind.");
    expect(blind.statusCode).toBe(428);
    expect(errorSchema.parse(blind.json()).error).toMatchObject({
      code: "PRECONDITION_REQUIRED",
      details: {
        reason: "precondition_required",
        assets: [{ kind: "agent", name: "kai-intake" }]
      }
    });
    expect(await t.stored("agent", "kai-intake")).toBeUndefined();

    const created = await put(t.kai.id, "First.", null);
    expect(created.statusCode).toBe(200);
    // A new agent made by someone who may not approve its publish starts hidden until its first
    // publish is approved (WS-PUB-1b), and the answer says so.
    expect(writeSchema.parse(created.json())).toEqual({
      version: 2,
      revision: 1,
      warnings: [
        {
          code: "agent_hidden",
          message:
            "Agent 'kai-intake' is offered in its workspace once its first publish is approved"
        }
      ]
    });
    const replaced = await put(t.kai.id, "Second.", 1);
    expect(writeSchema.parse(replaced.json())).toEqual({ version: 2, revision: 1, warnings: [] });
    await t.publishDraft("kai-intake", t.kaiTeam);

    // Stale: made against revision 1 while the asset is at 2. And a create of a taken name.
    for (const stale of [await put(t.admin.id, "Stale.", 1), await put(t.kai.id, "Again.", null)]) {
      expect(stale.statusCode).toBe(412);
      expect(errorSchema.parse(stale.json()).error).toMatchObject({
        code: "REVISION_CONFLICT",
        details: {
          reason: "revision_conflict",
          conflicts: [
            {
              kind: "agent",
              name: "kai-intake",
              currentRevision: 2,
              changedBy: "Admin",
              changedAt: expect.any(String)
            }
          ]
        }
      });
    }
    // A replace of an asset that does not exist is told so.
    const missing = await t.call(t.kai.id, "assets.put", {
      params: { kind: "agent", name: "kai-none" },
      payload: { config: agent("kai-none"), expectedRevision: 4, workspaceId: t.kaiTeam }
    });
    expect(errorSchema.parse(missing.json()).error).toMatchObject({
      code: "REVISION_CONFLICT",
      details: { conflicts: [{ kind: "agent", name: "kai-none", currentRevision: null }] }
    });
    expect(await t.stored("agent", "kai-intake")).toMatchObject({
      revision: 2,
      config: { instructions: "Second." }
    });
    expect(await t.stored("agent", "kai-none")).toBeUndefined();

    // In another workspace, on the instance, and for the user who holds nothing, the right is
    // missing.
    for (const workspaceId of [t.lenaTeam, undefined]) {
      await t.expectRefused(
        t.kai.id,
        "assets.put",
        {
          params: { kind: "agent", name: "lena-intake" },
          payload: { config: agent("lena-intake"), ...(workspaceId ? { workspaceId } : {}) }
        },
        t.forbidden("agent.write", "no_grant")
      );
    }
    await t.expectRefused(
      t.lena.id,
      "assets.put",
      {
        params: { kind: "agent", name: "kai-intake" },
        payload: { config: agent("kai-intake"), workspaceId: t.kaiTeam }
      },
      t.forbidden("agent.write", "no_grant")
    );
  });

  it("deletes and reverts at the revision read, keeps the history and writes the audit rows", async () => {
    const t = await setup();
    const inKai = { workspaceId: t.kaiTeam };
    const address = { params: { kind: "agent", name: "kai-intake" } };
    const read = { ...address, query: inKai };
    await t.put(t.kai.id, "agent", "kai-intake", t.kaiTeam);
    await t.expectOk(t.kai.id, "assets.put", {
      ...address,
      payload: {
        config: agent("kai-intake", { instructions: "Changed." }),
        expectedRevision: 1,
        ...inKai
      }
    });

    await t.publishDraft("kai-intake", t.kaiTeam);
    const staleRevert = await t.call(t.kai.id, "assets.revert", {
      ...address,
      payload: { revision: 1, expectedRevision: 1, ...inKai }
    });
    expect(errorSchema.parse(staleRevert.json()).error).toMatchObject({
      code: "REVISION_CONFLICT",
      details: { conflicts: [{ currentRevision: 2 }] }
    });
    const reverted = await t.expectOk(t.kai.id, "assets.revert", {
      ...address,
      payload: { revision: 1, expectedRevision: 2, ...inKai }
    });
    expect(writeSchema.parse(reverted.json())).toMatchObject({ revision: 2, warnings: [] });
    await t.publishDraft("kai-intake", t.kaiTeam);
    expect(await t.stored("agent", "kai-intake")).toMatchObject({
      revision: 3,
      config: { instructions: "Help." }
    });

    const staleDelete = await t.call(t.kai.id, "assets.delete", {
      ...address,
      payload: { expectedRevision: 2, ...inKai }
    });
    expect(errorSchema.parse(staleDelete.json()).error).toMatchObject({
      code: "REVISION_CONFLICT",
      details: { conflicts: [{ currentRevision: 3 }] }
    });
    for (const operation of ["assets.delete", "assets.revert"] as const) {
      const blind = await t.call(t.kai.id, operation, {
        ...address,
        payload: { revision: 1, expectedRevision: undefined, ...inKai }
      });
      expect(blind.statusCode, operation).toBe(428);
    }
    const deleted = await t.expectOk(t.kai.id, "assets.delete", {
      ...address,
      payload: { expectedRevision: 3, ...inKai }
    });
    expect(writeSchema.parse(deleted.json())).toMatchObject({ revision: 4, warnings: [] });
    await t.expectRefused(t.kai.id, "assets.get", read, { status: 404, code: "NOT_FOUND" });

    // The deleted asset keeps its revision. Creating the name again names it.
    const revival = (expectedRevision: number | null) =>
      t.call(t.kai.id, "assets.put", {
        ...address,
        payload: {
          config: agent("kai-intake", { instructions: "Again." }),
          expectedRevision,
          ...inKai
        }
      });
    const unreviewed = await revival(null);
    expect(unreviewed.statusCode).toBe(412);
    expect(errorSchema.parse(unreviewed.json()).error.details).toMatchObject({
      conflicts: [{ kind: "agent", name: "kai-intake", currentRevision: 4, deleted: true }]
    });
    expect(await t.stored("agent", "kai-intake")).toMatchObject({ status: "deleted", revision: 4 });
    expect((await revival(4)).statusCode).toBe(200);
    await t.expectOk(t.kai.id, "assets.delete", {
      ...address,
      payload: { expectedRevision: 5, ...inKai }
    });

    const history = z
      .object({ items: z.array(z.object({ revision: z.number(), operation: z.string() })) })
      .parse((await t.expectOk(t.kai.id, "assets.revisions.list", read)).json());
    expect(history.items.map((item) => [item.revision, item.operation])).toEqual([
      [6, "delete"],
      [5, "create"],
      [4, "delete"],
      [3, "update"],
      [2, "update"],
      [1, "create"]
    ]);
    await t.expectRefused(t.lena.id, "assets.revisions.list", read, {
      ...t.forbidden("agent.read", "no_grant")
    });

    // Call order is the revision each row names: audit timestamps of two calls may tie, and the
    // list breaks a tie by random id.
    const events = await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 });
    // The first publish's offering of the agent in its workspace names no revision (WS-PUB-1b).
    const written = events
      .filter(
        (event) =>
          event.type.startsWith("config_asset.") && event.type !== "config_asset.availability_set"
      )
      .sort((left, right) => Number(left.metadata?.revision) - Number(right.metadata?.revision));
    expect(written.map((event) => [event.type, event.metadata?.revision])).toEqual([
      ["config_asset.updated", 1],
      ["config_asset.updated", 2],
      ["config_asset.updated", 3],
      ["config_asset.deleted", 4],
      ["config_asset.updated", 5],
      ["config_asset.deleted", 6]
    ]);
    // Each row names the run that wrote it.
    expect(written.every((event) => typeof event.metadata?.operationRunId === "string")).toBe(true);
  });
});

describe("assets.sync", () => {
  const sync = (
    t: WorkspaceHolderInstance,
    userId: string,
    items: unknown[],
    // `null`: the batch names no workspace.
    workspaceId: string | null = t.kaiTeam
  ) =>
    t.call(userId, "assets.sync", {
      payload: { items, ...(workspaceId === null ? {} : { workspaceId }) }
    });
  const putItem = (kind: "agent" | "skill", name: string, expectedRevision?: number) => ({
    type: "put",
    kind,
    config: kind === "agent" ? agent(name) : skill(name),
    ...(expectedRevision === undefined ? {} : { expectedRevision })
  });

  it("applies every item of a batch and reports each", async () => {
    const t = await setup();
    await t.put(t.kai.id, "agent", "kai-old", t.kaiTeam);

    const applied = await sync(t, t.kai.id, [
      putItem("skill", "kai-guide"),
      putItem("agent", "kai-intake"),
      { type: "delete", kind: "agent", name: "kai-old", expectedRevision: 1 }
    ]);
    expect(applied.statusCode, applied.body).toBe(200);
    // Each item names the asset it wrote: the id a later write is bound to.
    const item = (type: string, kind: string, name: string) => ({
      type,
      kind,
      name,
      status: "applied",
      id: expect.stringMatching(/^cfga_/u)
    });
    expect(applied.json()).toEqual({
      version: 3,
      items: [
        { ...item("put", "skill", "kai-guide"), revision: 1 },
        { ...item("put", "agent", "kai-intake"), revision: 1 },
        { ...item("delete", "agent", "kai-old"), revision: 2 }
      ],
      // A batch is no release: its new agent starts hidden.
      hiddenAgentNames: ["kai-intake"],
      warnings: []
    });
    expect(await t.stored("skill", "kai-guide")).toMatchObject({ status: "active", revision: 1 });
    expect(await t.stored("agent", "kai-intake")).toMatchObject({ status: "active", revision: 1 });
    expect(await t.stored("agent", "kai-old")).toMatchObject({ status: "deleted", revision: 2 });
  });

  it("applies nothing when one item is refused, and names the item", async () => {
    const t = await setup();
    await t.put(t.admin.id, "skill", "kai-guide", t.kaiTeam);

    // Kai may write the workspace's skills and may not delete them.
    const refused = await sync(t, t.kai.id, [
      putItem("agent", "kai-intake"),
      { type: "delete", kind: "skill", name: "kai-guide", expectedRevision: 1 }
    ]);
    expect(refused.statusCode).toBe(403);
    const error = errorSchema.parse(refused.json()).error;
    expect(error.code).toBe("FORBIDDEN");
    expect(syncRefusalSchema.parse(error.details).items).toEqual([
      { index: 0, type: "put", kind: "agent", name: "kai-intake", status: "not_applied" },
      {
        index: 1,
        type: "delete",
        kind: "skill",
        name: "kai-guide",
        status: "refused",
        error: {
          code: "FORBIDDEN",
          message: "Missing the right 'skill.delete'",
          action: "skill.delete"
        }
      }
    ]);
    expect(await t.stored("agent", "kai-intake")).toBeUndefined();
    expect(await t.stored("skill", "kai-guide")).toMatchObject({ status: "active", revision: 1 });

    // An item made against another revision stops the batch the same way.
    const stale = await sync(t, t.kai.id, [
      putItem("agent", "kai-intake"),
      putItem("skill", "kai-guide", 7)
    ]);
    expect(stale.statusCode).toBe(412);
    expect(syncRefusalSchema.parse(errorSchema.parse(stale.json()).error.details).items).toEqual([
      { index: 0, type: "put", kind: "agent", name: "kai-intake", status: "not_applied" },
      expect.objectContaining({
        index: 1,
        status: "refused",
        error: expect.objectContaining({ code: "REVISION_CONFLICT", currentRevision: 1 })
      })
    ]);
    // So does an item whose definition is invalid.
    const invalid = await sync(t, t.kai.id, [
      putItem("agent", "kai-intake"),
      { type: "put", kind: "agent", config: { name: "kai-broken" } }
    ]);
    expect(invalid.statusCode).toBe(422);
    expect(
      syncRefusalSchema
        .parse(errorSchema.parse(invalid.json()).error.details)
        .items.map((item) => [item.name, item.status, item.error?.code])
    ).toEqual([
      ["kai-intake", "not_applied", undefined],
      ["kai-broken", "refused", "VALIDATION_FAILED"]
    ]);
    expect(await t.stored("agent", "kai-intake")).toBeUndefined();
    // A user who holds nothing is refused every item.
    const nothing = await sync(t, t.lena.id, [putItem("agent", "kai-intake")]);
    expect(nothing.statusCode).toBe(403);
    expect(await t.stored("agent", "kai-intake")).toBeUndefined();
  });

  it("reaches no asset outside the named workspace, whoever calls", async () => {
    const t = await setup();
    await t.put(t.admin.id, "agent", "lena-notes", t.lenaTeam);

    // The administrator may write and delete everywhere, and the batch is still one workspace's.
    const outside = await sync(t, t.admin.id, [
      putItem("agent", "kai-intake"),
      putItem("agent", "lena-notes", 1),
      { type: "delete", kind: "agent", name: "assistant", expectedRevision: 1 }
    ]);
    expect(outside.statusCode).toBe(422);
    const items = syncRefusalSchema.parse(errorSchema.parse(outside.json()).error.details).items;
    expect(items.map((item) => [item.name, item.status])).toEqual([
      ["kai-intake", "not_applied"],
      ["lena-notes", "refused"],
      ["assistant", "refused"]
    ]);
    expect(items[1]?.error?.message).toBe("Config agent 'lena-notes' belongs to another scope");
    expect(await t.stored("agent", "kai-intake")).toBeUndefined();
    expect(await t.stored("agent", "lena-notes")).toMatchObject({ status: "active", revision: 1 });
    expect(await t.stored("agent", "assistant")).toMatchObject({ status: "active" });

    // A batch that names no workspace is a release's, a workspace id nobody made is no owner,
    // and one item twice is no batch.
    const unnamed = await sync(t, t.admin.id, [putItem("agent", "kai-intake")], null);
    expect(errorSchema.parse(unnamed.json()).error).toMatchObject({
      code: "VALIDATION_FAILED",
      message:
        "A batch names the workspace it belongs to. Only a release writes the instance's own assets"
    });
    const unknown = await sync(t, t.admin.id, [putItem("agent", "team-intake")], "cws_none");
    expect(errorSchema.parse(unknown.json()).error).toMatchObject({
      code: "VALIDATION_FAILED",
      details: { reason: "workspace_not_found" }
    });
    const twice = await sync(t, t.admin.id, [
      putItem("agent", "kai-intake"),
      putItem("agent", "kai-intake")
    ]);
    expect(twice.statusCode).toBe(422);
    expect(await t.stored("agent", "kai-intake")).toBeUndefined();
    expect(await t.stored("agent", "team-intake")).toBeUndefined();
  });
});

describe("the Operation Run of an asset call", () => {
  it("leaves one run per changing call and per failed read, and none for an allowed read", async () => {
    const t = await setup();
    const runs = () => t.stores.operationRuns.list({ clientInstanceId });
    const runOf = async (...call: Call) => {
      const before = (await runs()).length;
      const response = await t.call(...call);
      const all = await runs();
      expect(all.length, `${call[1]} left one run`).toBe(before + 1);
      const id = response.headers["operation-run-id"];
      const run = all.find((candidate) => candidate.id === id);
      if (!run) throw new Error(`No run for ${call[1]}`);
      return {
        operation: run.operation,
        actor: run.actor.id,
        effect: run.effect,
        status: run.status,
        ...(run.error ? { error: run.error.code } : {})
      };
    };
    const inKai = { workspaceId: t.kaiTeam };
    const address = { params: { kind: "agent", name: "kai-intake" } };
    const read = { ...address, query: inKai };
    const put = { ...address, payload: { config: agent("kai-intake"), ...inKai } };
    const done = (operation: string, actor: string, effect: string) => ({
      operation,
      actor,
      effect,
      status: "done"
    });

    expect(await runOf(t.kai.id, "assets.put", put)).toEqual(
      done("assets.put", t.kai.id, "changing")
    );
    // The five reads over HTTP are allowed here: no run, no audit row and no header. Fails
    // without the change, when each left one `done` run and three audit rows.
    const audited = async () => (await t.stores.audit.listAuditEvents({ clientInstanceId })).length;
    const reads: Call[] = [
      [t.kai.id, "assets.get", read],
      [t.admin.id, "assets.list", { params: { kind: "agent" } }],
      [t.kai.id, "assets.revisions.list", read],
      [
        t.kai.id,
        "assets.validate",
        { params: { kind: "agent" }, payload: { config: agent("kai-intake"), ...inKai } }
      ],
      [t.lena.id, "platform.context.get"]
    ];
    for (const read of reads) {
      const before = { runs: (await runs()).length, audited: await audited() };
      const response = await t.call(...read);
      expect(response.statusCode, read[1]).toBe(200);
      expect(response.headers["operation-run-id"], read[1]).toBeUndefined();
      expect({ runs: (await runs()).length, audited: await audited() }, read[1]).toEqual(before);
    }
    // A read that fails is a run.
    expect(
      await runOf(t.kai.id, "assets.get", {
        params: { kind: "agent", name: "kai-missing" },
        query: inKai
      })
    ).toEqual({
      operation: "assets.get",
      actor: t.kai.id,
      effect: "reading",
      status: "failed",
      error: "NOT_FOUND"
    });
    // A refusal of the right, a conflict and a refused batch are runs too.
    expect(await runOf(t.lena.id, "assets.put", put)).toMatchObject({
      operation: "assets.put",
      actor: t.lena.id,
      effect: "changing",
      status: "denied"
    });
    expect(
      await runOf(t.kai.id, "assets.put", {
        ...address,
        payload: { config: agent("kai-intake"), expectedRevision: 9, ...inKai }
      })
    ).toEqual({
      operation: "assets.put",
      actor: t.kai.id,
      effect: "changing",
      status: "failed",
      error: "REVISION_CONFLICT"
    });
    expect(
      await runOf(t.kai.id, "assets.sync", {
        payload: {
          ...inKai,
          items: [{ type: "delete", kind: "agent", name: "lena-x", expectedRevision: 1 }]
        }
      })
    ).toMatchObject({ operation: "assets.sync", effect: "changing", status: "failed" });
    expect(
      await runOf(t.kai.id, "assets.revert", {
        ...address,
        payload: { revision: 1, expectedRevision: 1, ...inKai }
      })
    ).toEqual(done("assets.revert", t.kai.id, "changing"));
    expect(
      await runOf(t.kai.id, "assets.delete", {
        ...address,
        payload: { expectedRevision: 1, ...inKai }
      })
    ).toEqual(done("assets.delete", t.kai.id, "changing"));
  });
});

describe("a name with a NUL byte", () => {
  it("is refused readably by every operation that takes a name, and never reaches the store", async () => {
    const t = await setup();
    const name = "kai-\u0000intake";
    const address = { params: { kind: "agent", name } };
    const calls: Call[] = [
      [t.admin.id, "assets.get", address],
      [t.admin.id, "assets.revisions.list", address],
      [t.admin.id, "assets.put", { ...address, payload: { config: agent(name) } }],
      // The definition is read for its name where no address carries one.
      [
        t.admin.id,
        "assets.put",
        { params: { kind: "agent", name: "kai-intake" }, payload: { config: agent(name) } }
      ],
      [t.admin.id, "assets.delete", { ...address, payload: { expectedRevision: 1 } }],
      [t.admin.id, "assets.revert", { ...address, payload: { revision: 1, expectedRevision: 1 } }],
      [
        t.admin.id,
        "assets.validate",
        { params: { kind: "agent" }, payload: { config: agent(name) } }
      ],
      [t.admin.id, "assets.list", { params: { kind: "agent" }, query: { prefix: "kai-\u0000" } }],
      [t.admin.id, "assets.list", { params: { kind: "agent" }, query: { text: "\u0000" } }],
      [
        t.admin.id,
        "assets.sync",
        {
          payload: {
            workspaceId: t.kaiTeam,
            items: [{ type: "put", kind: "agent", config: agent(name) }]
          }
        }
      ],
      [
        t.admin.id,
        "assets.sync",
        {
          payload: {
            workspaceId: t.kaiTeam,
            items: [{ type: "delete", kind: "agent", name, expectedRevision: 1 }]
          }
        }
      ],
      // The workspace a batch names is the caller's text as well.
      [
        t.admin.id,
        "assets.sync",
        {
          payload: {
            workspaceId: `${t.kaiTeam}\u0000`,
            items: [{ type: "put", kind: "agent", config: agent("kai-intake") }]
          }
        }
      ],
      [t.admin.id, "assets.list", { params: { kind: "agent" }, query: { workspaceId: "\u0000" } }]
    ];
    for (const [userId, operation, input] of calls) {
      // The harness reads no revision for the call: the name would not reach its store either.
      const response = await t.instance.call(operation, {
        ...input,
        headers: { "x-test-user": userId }
      });
      const label = `${operation} ${JSON.stringify(input)}`;
      expect(response.statusCode, label).toBe(422);
      const { error } = errorSchema.parse(response.json());
      expect(error.code, label).toBe("VALIDATION_FAILED");
      expect(JSON.stringify(error), label).toContain("A name must not contain a NUL byte");
    }

    // A cursor is the caller's text too: one forged to carry such a name is no cursor.
    const agents = { params: { kind: "agent" } };
    await t.put(t.admin.id, "agent", "kai-intake");
    const first = pageSchema.parse(
      (await t.expectOk(t.admin.id, "assets.list", { ...agents, query: { limit: 1 } })).json()
    );
    const cursor = z
      .object({ scope: z.string(), keys: z.array(z.string()) })
      .parse(JSON.parse(Buffer.from(first.nextCursor ?? "", "base64url").toString()));
    const forged = Buffer.from(JSON.stringify({ ...cursor, keys: ["kai-\u0000"] })).toString(
      "base64url"
    );
    await t.expectRefused(
      t.admin.id,
      "assets.list",
      { ...agents, query: { limit: 1, cursor: forged } },
      { status: 422, code: "VALIDATION_FAILED" }
    );
  });
});
