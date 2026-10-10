import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  agent,
  clientInstanceId,
  errorSchema,
  skill,
  type AccessInstance
} from "./support/access-instance";
import {
  assetPageSchema as pageSchema,
  setupNamespaceHolder as setupNamespace,
  type AssetCall as Call
} from "./support/asset-operations";
import { withTestSql } from "./support/test-sql";

// The asset operations, each called as an administrator, as a holder of rights in one
// Namespace and as a user who holds nothing. Every call is an Operation Run. What a call may
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
  it("shows a Namespace holder the assets of that Namespace and nobody anything without a right", async () => {
    const t = await setupNamespace();
    await t.put(t.admin.id, "agent", "kai-intake");
    await t.put(t.admin.id, "agent", "kai-tax");
    await t.put(t.admin.id, "agent", "lena-notes");
    await t.put(t.admin.id, "skill", "kai-guide");
    const agents = { params: { kind: "agent" } };

    expect(await t.names(t.admin.id, "assets.list", agents)).toEqual([
      "assistant",
      "kai-intake",
      "kai-tax",
      "lena-notes"
    ]);
    expect(await t.names(t.kai.id, "assets.list", agents)).toEqual(["kai-intake", "kai-tax"]);
    expect(await t.names(t.lena.id, "assets.list", agents)).toEqual([]);
    // A kind is one list: the skill of the Namespace is in the other one.
    expect(await t.names(t.kai.id, "assets.list", { params: { kind: "skill" } })).toEqual([
      "kai-guide"
    ]);

    const listed = pageSchema.parse((await t.expectOk(t.kai.id, "assets.list", agents)).json());
    expect(listed.items[0]).toMatchObject({
      kind: "agent",
      name: "kai-intake",
      title: "kai-intake",
      scope: { kind: "instance" },
      namespace: "kai-",
      revision: 1
    });
    // A summary carries no content.
    expect(Object.keys(listed.items[0] ?? {})).not.toContain("config");
    // What the list shows is what `assets.get` answers, and nothing else.
    await t.expectOk(t.kai.id, "assets.get", { params: { kind: "agent", name: "kai-tax" } });
    await t.expectRefused(
      t.kai.id,
      "assets.get",
      { params: { kind: "agent", name: "lena-notes" } },
      t.forbidden("agent.read", "no_grant")
    );
  });

  it("filters by name prefix and by text, and pages by name", async () => {
    const t = await setupNamespace();
    for (const name of ["kai-intake", "kai-tax", "kai-Taxes-2", "lena-tax"]) {
      await t.put(t.admin.id, "agent", name);
    }
    const list = (query: Record<string, string | number>) =>
      t.names(t.admin.id, "assets.list", { params: { kind: "agent" }, query });

    expect(await list({ prefix: "kai-" })).toEqual(["kai-Taxes-2", "kai-intake", "kai-tax"]);
    expect(await list({ text: "TAX" })).toEqual(["kai-Taxes-2", "kai-tax", "lena-tax"]);
    expect(await list({ prefix: "kai-", text: "tax" })).toEqual(["kai-Taxes-2", "kai-tax"]);
    // A prefix is matched as text, not as a pattern.
    expect(await list({ prefix: "kai_" })).toEqual([]);

    const first = pageSchema.parse(
      (
        await t.expectOk(t.kai.id, "assets.list", {
          params: { kind: "agent" },
          query: { limit: 2 }
        })
      ).json()
    );
    expect(first.items.map((item) => item.name)).toEqual(["kai-Taxes-2", "kai-intake"]);
    expect(first.nextCursor).toBeDefined();
    expect(
      await t.names(t.kai.id, "assets.list", {
        params: { kind: "agent" },
        query: { limit: 2, cursor: first.nextCursor }
      })
    ).toEqual(["kai-tax"]);
    await t.expectRefused(
      t.admin.id,
      "assets.list",
      { params: { kind: "widget" } },
      { status: 422, code: "VALIDATION_FAILED" }
    );
  });

  it("reads ten thousand assets through the name index, for a caller who may read few of them", async () => {
    const t = await setupNamespace();
    // 10,000 agents of this instance, each with its active revision; 100 of them in `kai-`.
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

describe("assets.put, assets.delete and assets.revert", () => {
  it("creates without a revision, replaces at the one read, and answers a stale one with the current", async () => {
    const t = await setupNamespace();
    const put = (userId: string, instructions: string, expectedRevision?: number) =>
      t.call(userId, "assets.put", {
        params: { kind: "agent", name: "kai-intake" },
        payload: {
          config: agent("kai-intake", { instructions }),
          // An explicit `undefined` keeps the helper from filling in the current revision.
          expectedRevision
        }
      });

    const created = await put(t.kai.id, "First.");
    expect(created.statusCode).toBe(200);
    expect(writeSchema.parse(created.json())).toEqual({ version: 2, revision: 1, warnings: [] });
    const replaced = await put(t.kai.id, "Second.", 1);
    expect(writeSchema.parse(replaced.json())).toEqual({ version: 3, revision: 2, warnings: [] });

    // Stale: made against revision 1 while the asset is at 2. And a create of a taken name.
    for (const stale of [await put(t.admin.id, "Stale.", 1), await put(t.kai.id, "Again.")]) {
      expect(stale.statusCode).toBe(409);
      expect(errorSchema.parse(stale.json()).error).toMatchObject({
        code: "CONFLICT",
        details: { kind: "agent", name: "kai-intake", currentRevision: 2 }
      });
    }
    // A replace of an asset that does not exist is told so.
    const missing = await t.call(t.kai.id, "assets.put", {
      params: { kind: "agent", name: "kai-none" },
      payload: { config: agent("kai-none"), expectedRevision: 4 }
    });
    expect(errorSchema.parse(missing.json()).error).toMatchObject({
      code: "CONFLICT",
      details: { currentRevision: null }
    });
    expect(await t.stored("agent", "kai-intake")).toMatchObject({
      revision: 2,
      config: { instructions: "Second." }
    });
    expect(await t.stored("agent", "kai-none")).toBeUndefined();

    // Outside the Namespace, and for the user who holds nothing, the right is missing.
    await t.expectRefused(
      t.kai.id,
      "assets.put",
      { params: { kind: "agent", name: "lena-intake" }, payload: { config: agent("lena-intake") } },
      t.forbidden("agent.write", "no_grant")
    );
    await t.expectRefused(
      t.lena.id,
      "assets.put",
      { params: { kind: "agent", name: "kai-intake" }, payload: { config: agent("kai-intake") } },
      t.forbidden("agent.write", "no_grant")
    );
  });

  it("deletes and reverts at the revision read, keeps the history and writes the audit rows", async () => {
    const t = await setupNamespace();
    const address = { params: { kind: "agent", name: "kai-intake" } };
    await t.put(t.kai.id, "agent", "kai-intake");
    await t.expectOk(t.kai.id, "assets.put", {
      ...address,
      payload: { config: agent("kai-intake", { instructions: "Changed." }), expectedRevision: 1 }
    });

    const staleRevert = await t.call(t.kai.id, "assets.revert", {
      ...address,
      payload: { revision: 1, expectedRevision: 1 }
    });
    expect(errorSchema.parse(staleRevert.json()).error).toMatchObject({
      code: "CONFLICT",
      details: { currentRevision: 2 }
    });
    const reverted = await t.expectOk(t.kai.id, "assets.revert", {
      ...address,
      payload: { revision: 1, expectedRevision: 2 }
    });
    expect(writeSchema.parse(reverted.json())).toMatchObject({ revision: 3, warnings: [] });
    expect(await t.stored("agent", "kai-intake")).toMatchObject({
      revision: 3,
      config: { instructions: "Help." }
    });

    const staleDelete = await t.call(t.kai.id, "assets.delete", {
      ...address,
      payload: { expectedRevision: 2 }
    });
    expect(errorSchema.parse(staleDelete.json()).error).toMatchObject({
      code: "CONFLICT",
      details: { currentRevision: 3 }
    });
    const deleted = await t.expectOk(t.kai.id, "assets.delete", {
      ...address,
      payload: { expectedRevision: 3 }
    });
    expect(writeSchema.parse(deleted.json())).toMatchObject({ revision: 4, warnings: [] });
    expect(await t.stored("agent", "kai-intake")).toMatchObject({ status: "deleted", revision: 4 });
    await t.expectRefused(t.kai.id, "assets.get", address, { status: 404, code: "NOT_FOUND" });

    const history = z
      .object({ items: z.array(z.object({ revision: z.number(), operation: z.string() })) })
      .parse((await t.expectOk(t.kai.id, "assets.revisions.list", address)).json());
    expect(history.items.map((item) => [item.revision, item.operation])).toEqual([
      [1, "create"],
      [2, "update"],
      [3, "revert"],
      [4, "delete"]
    ]);
    await t.expectRefused(t.lena.id, "assets.revisions.list", address, {
      ...t.forbidden("agent.read", "no_grant")
    });

    const events = await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 });
    const written = events.filter((event) => event.type.startsWith("config_asset."));
    expect(written.map((event) => [event.type, event.metadata?.revision]).reverse()).toEqual([
      ["config_asset.updated", 1],
      ["config_asset.updated", 2],
      ["config_asset.reverted", 3],
      ["config_asset.deleted", 4]
    ]);
    // Each row names the run that wrote it.
    expect(written.every((event) => typeof event.metadata?.operationRunId === "string")).toBe(true);
  });
});

describe("assets.sync", () => {
  const sync = (t: AccessInstance, userId: string, items: unknown[], namespace = "kai-") =>
    t.call(userId, "assets.sync", { payload: { namespace, items } });
  const putItem = (kind: "agent" | "skill", name: string, expectedRevision?: number) => ({
    type: "put",
    kind,
    config: kind === "agent" ? agent(name) : skill(name),
    ...(expectedRevision === undefined ? {} : { expectedRevision })
  });

  it("applies every item of a batch and reports each", async () => {
    const t = await setupNamespace();
    await t.put(t.kai.id, "agent", "kai-old");

    const applied = await sync(t, t.kai.id, [
      putItem("skill", "kai-guide"),
      putItem("agent", "kai-intake"),
      { type: "delete", kind: "agent", name: "kai-old", expectedRevision: 1 }
    ]);
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json()).toEqual({
      version: 3,
      items: [
        { type: "put", kind: "skill", name: "kai-guide", status: "applied", revision: 1 },
        { type: "put", kind: "agent", name: "kai-intake", status: "applied", revision: 1 },
        { type: "delete", kind: "agent", name: "kai-old", status: "applied", revision: 2 }
      ],
      warnings: []
    });
    expect(await t.stored("skill", "kai-guide")).toMatchObject({ status: "active", revision: 1 });
    expect(await t.stored("agent", "kai-intake")).toMatchObject({ status: "active", revision: 1 });
    expect(await t.stored("agent", "kai-old")).toMatchObject({ status: "deleted", revision: 2 });
  });

  it("applies nothing when one item is refused, and names the item", async () => {
    const t = await setupNamespace();
    await t.put(t.admin.id, "skill", "kai-guide");

    // Kai may write skills in the Namespace and may not delete them.
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
    expect(stale.statusCode).toBe(409);
    expect(syncRefusalSchema.parse(errorSchema.parse(stale.json()).error.details).items).toEqual([
      { index: 0, type: "put", kind: "agent", name: "kai-intake", status: "not_applied" },
      expect.objectContaining({
        index: 1,
        status: "refused",
        error: expect.objectContaining({ code: "CONFLICT", currentRevision: 1 })
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

  it("reaches no asset outside the named prefix, whoever calls", async () => {
    const t = await setupNamespace();
    await t.put(t.admin.id, "agent", "lena-notes");

    // The administrator may write and delete everywhere, and the batch is still one Namespace's.
    const outside = await sync(t, t.admin.id, [
      putItem("agent", "kai-intake"),
      putItem("agent", "lena-intake"),
      { type: "delete", kind: "agent", name: "lena-notes", expectedRevision: 1 },
      { type: "delete", kind: "agent", name: "assistant", expectedRevision: 1 }
    ]);
    expect(outside.statusCode).toBe(422);
    const items = syncRefusalSchema.parse(errorSchema.parse(outside.json()).error.details).items;
    expect(items.map((item) => [item.name, item.status])).toEqual([
      ["kai-intake", "not_applied"],
      ["lena-intake", "refused"],
      ["lena-notes", "refused"],
      ["assistant", "refused"]
    ]);
    expect(items[1]?.error?.message).toBe("Config agent 'lena-intake' is outside Namespace 'kai-'");
    expect(await t.stored("agent", "kai-intake")).toBeUndefined();
    expect(await t.stored("agent", "lena-intake")).toBeUndefined();
    expect(await t.stored("agent", "lena-notes")).toMatchObject({ status: "active" });
    expect(await t.stored("agent", "assistant")).toMatchObject({ status: "active" });

    // A prefix nobody registered is no Namespace, and one item twice is no batch.
    const unregistered = await sync(t, t.admin.id, [putItem("agent", "team-intake")], "team-");
    expect(errorSchema.parse(unregistered.json()).error).toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Namespace 'team-' is not registered"
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
  it("leaves one run per call with its actor, effect and outcome", async () => {
    const t = await setupNamespace();
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
    const address = { params: { kind: "agent", name: "kai-intake" } };
    const put = { ...address, payload: { config: agent("kai-intake") } };
    const done = (operation: string, actor: string, effect: string) => ({
      operation,
      actor,
      effect,
      status: "done"
    });

    expect(await runOf(t.kai.id, "assets.put", put)).toEqual(
      done("assets.put", t.kai.id, "changing")
    );
    expect(await runOf(t.kai.id, "assets.get", address)).toEqual(
      done("assets.get", t.kai.id, "reading")
    );
    expect(await runOf(t.admin.id, "assets.list", { params: { kind: "agent" } })).toEqual(
      done("assets.list", t.admin.id, "reading")
    );
    expect(await runOf(t.kai.id, "assets.revisions.list", address)).toEqual(
      done("assets.revisions.list", t.kai.id, "reading")
    );
    expect(
      await runOf(t.kai.id, "assets.validate", {
        params: { kind: "agent" },
        payload: { config: agent("kai-intake") }
      })
    ).toEqual(done("assets.validate", t.kai.id, "reading"));
    expect(await runOf(t.lena.id, "platform.context.get")).toEqual(
      done("platform.context.get", t.lena.id, "reading")
    );
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
        payload: { config: agent("kai-intake"), expectedRevision: 9 }
      })
    ).toEqual({
      operation: "assets.put",
      actor: t.kai.id,
      effect: "changing",
      status: "failed",
      error: "CONFLICT"
    });
    expect(
      await runOf(t.kai.id, "assets.sync", {
        payload: {
          namespace: "kai-",
          items: [{ type: "delete", kind: "agent", name: "lena-x", expectedRevision: 1 }]
        }
      })
    ).toMatchObject({ operation: "assets.sync", effect: "changing", status: "failed" });
    expect(
      await runOf(t.kai.id, "assets.revert", {
        ...address,
        payload: { revision: 1, expectedRevision: 1 }
      })
    ).toEqual(done("assets.revert", t.kai.id, "changing"));
    expect(
      await runOf(t.kai.id, "assets.delete", { ...address, payload: { expectedRevision: 2 } })
    ).toEqual(done("assets.delete", t.kai.id, "changing"));
  });
});
