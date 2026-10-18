import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  assetSchema,
  assetSummarySchema,
  platformContextSchema
} from "@work-shape/catalyst-api-contract";
import {
  GRANTABLE_ACTION_SCOPES,
  GRANTABLE_ACTIONS,
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND
} from "@work-shape/catalyst-core";
import { SCOPES_HEADER, clientInstanceId, grantSchema } from "./support/access-instance";
import { runSchema, type WorkflowFixture } from "./support/workflow-instance";
import { NOTE, notifyClients, readyWorkflows } from "./support/workflow-runs";

// The rights on a Workflow as an administrator gives them, through `permissions.grant` and
// `permissions.revoke` alone: no row here is written to the store. Each test fails without the
// Workflow rows of `GRANTABLE_ACTION_SCOPES`: before them every one of these grants was
// refused with `action_not_grantable`, and a member reached a Workflow only as an administrator.

const NOTIFY = "notify-clients";
const ARCHIVE = "archive-clients";

const listSchema = z.object({
  items: z.array(z.object({ id: z.string(), actions: z.array(z.string()) }).loose())
});

describe("a right on a Workflow given through grant administration", () => {
  let open: WorkflowFixture | undefined;
  afterEach(async () => {
    await open?.instance.close();
    open = undefined;
  });

  /** An instance with two published Workflows, each an asset of its own. */
  async function ready() {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: "assets" }
    );
    for (const [id, name] of [
      [NOTIFY, "Notify clients"],
      [ARCHIVE, "Archive clients"]
    ] as const) {
      const revision = await put(t, t.admin.id, id, { ...notifyClients(), id, name }, null);
      await t.expectOk(t.root.id, "assets.publish", {
        params: { kind: WORKFLOW_ASSET_KIND, name: id },
        payload: { revision }
      });
    }
    return t;
  }

  /** Writes the definition as the draft of the Workflow. Answers the revision. */
  async function put(
    t: WorkflowFixture,
    userId: string,
    id: string,
    manifest: Record<string, unknown>,
    expectedRevision: number | null
  ) {
    const response = await t.expectOk(userId, "assets.put", {
      params: { kind: WORKFLOW_ASSET_KIND, name: id },
      payload: { config: { name: id, manifest }, expectedRevision }
    });
    return z.object({ revision: z.number() }).parse(response.json()).revision;
  }

  const listed = async (t: WorkflowFixture, userId: string) =>
    listSchema
      .parse((await t.expectOk(userId, "workflows.list")).json())
      .items.map((workflow) => [workflow.id, workflow.actions]);
  const startOf = (workflow: string) => ({
    params: { workflow },
    payload: { input: { note: NOTE } }
  });
  const revoke = (t: WorkflowFixture, grantId: string) =>
    t.expectOk(t.admin.id, "permissions.revoke", { params: { grantId } });
  const rowsOf = async (t: WorkflowFixture, holderId: string) =>
    (await t.stores.access.listGrants({ clientInstanceId, holderId })).map((row) => [
      row.action,
      row.scopeKind
    ]);

  it("names the rights of a Workflow a row is written for, and where", () => {
    expect(GRANTABLE_ACTIONS.filter((action) => action.startsWith("workflow."))).toEqual([
      WORKFLOW_ACTIONS.read,
      WORKFLOW_ACTIONS.write,
      WORKFLOW_ACTIONS.publish,
      WORKFLOW_ACTIONS.delete,
      WORKFLOW_ACTIONS.use,
      WORKFLOW_ACTIONS.readRunData
    ]);
    for (const action of [
      WORKFLOW_ACTIONS.read,
      WORKFLOW_ACTIONS.use,
      WORKFLOW_ACTIONS.write,
      WORKFLOW_ACTIONS.publish
    ] as const) {
      expect(GRANTABLE_ACTION_SCOPES[action], action).toEqual(["asset", "instance"]);
    }
    // RIGHTS-1c: deleting is new and has no Namespace; the run data is one Workflow's (D4).
    expect(GRANTABLE_ACTION_SCOPES[WORKFLOW_ACTIONS.delete]).toEqual(["asset", "instance"]);
    expect(GRANTABLE_ACTION_SCOPES[WORKFLOW_ACTIONS.readRunData]).toEqual(["asset"]);
  });

  it("shows a member the one Workflow she was given to read, and starts it only with the use right", async () => {
    const t = await ready();
    const notify = await t.assetId(WORKFLOW_ASSET_KIND, NOTIFY);
    expect(await listed(t, t.kai.id)).toEqual([]);

    const read = await t.grant(t.kai.id, WORKFLOW_ACTIONS.read, { assetId: notify });

    // Exactly that one, with the read right alone: its runs are hers to read, a start is not.
    expect(await listed(t, t.kai.id)).toEqual([[NOTIFY, ["workflow.read"]]]);
    await t.expectOk(t.kai.id, "workflows.list_runs", { params: { workflow: NOTIFY } });
    await t.expectRefused(
      t.kai.id,
      "workflows.start",
      startOf(NOTIFY),
      t.forbidden("workflow.use", "no_grant")
    );

    const use = await t.grant(t.kai.id, WORKFLOW_ACTIONS.use, { assetId: notify });

    expect(await listed(t, t.kai.id)).toEqual([[NOTIFY, ["workflow.read", "workflow.use"]]]);
    const started = await t.expectOk(t.kai.id, "workflows.start", startOf(NOTIFY));
    const run = await t.finish(runSchema.parse(started.json()).id);
    expect(run).toMatchObject({ status: "done", startedBy: { kind: "user", id: t.kai.id } });
    // The other Workflow is neither shown nor started, and none of its runs is read.
    await t.expectRefused(
      t.kai.id,
      "workflows.start",
      startOf(ARCHIVE),
      t.forbidden("workflow.use", "no_grant")
    );
    await t.expectRefused(
      t.kai.id,
      "workflows.list_runs",
      { params: { workflow: ARCHIVE } },
      t.forbidden("workflow.read", "no_grant")
    );

    // Each row is removed by itself, and the next call is decided without it.
    await revoke(t, use);
    expect(await listed(t, t.kai.id)).toEqual([[NOTIFY, ["workflow.read"]]]);
    await t.expectRefused(
      t.kai.id,
      "workflows.start",
      startOf(NOTIFY),
      t.forbidden("workflow.use", "no_grant")
    );
    await revoke(t, read);
    expect(await listed(t, t.kai.id)).toEqual([]);
    await t.expectRefused(
      t.kai.id,
      "workflows.list_runs",
      { params: { workflow: NOTIFY } },
      t.forbidden("workflow.read", "no_grant")
    );
    // The run she started stays hers to end and is no longer hers to read.
    await t.expectRefused(
      t.kai.id,
      "workflows.get_run",
      { params: { runId: run.id } },
      t.forbidden("workflow.read", "no_grant")
    );
    expect(await rowsOf(t, t.kai.id)).toEqual([]);
  });

  it("takes the list entry and the start away at once when the use right is the only row", async () => {
    const t = await ready();
    const use = await t.grant(t.lena.id, WORKFLOW_ACTIONS.use, {
      assetId: await t.assetId(WORKFLOW_ASSET_KIND, NOTIFY)
    });
    expect(await listed(t, t.lena.id)).toEqual([[NOTIFY, ["workflow.use"]]]);
    await t.expectOk(t.lena.id, "workflows.start", startOf(NOTIFY));

    await revoke(t, use);

    expect(await listed(t, t.lena.id)).toEqual([]);
    await t.expectRefused(
      t.lena.id,
      "workflows.start",
      startOf(NOTIFY),
      t.forbidden("workflow.use", "no_grant")
    );
  });

  it("lets no member grant onward, and no credential without the scope of managing users", async () => {
    const t = await ready();
    const notify = await t.assetId(WORKFLOW_ASSET_KIND, NOTIFY);
    await t.grant(t.kai.id, WORKFLOW_ACTIONS.read, { assetId: notify });
    await t.grant(t.kai.id, WORKFLOW_ACTIONS.use, { assetId: notify });
    const toLena = (action: string) => ({
      payload: {
        holderKind: "user",
        holderId: t.lena.id,
        action,
        effect: "allow",
        scopeKind: "asset",
        scopeId: notify
      }
    });

    // Holding a right on the Workflow is no right to hand it on: that is `users.manage`.
    for (const action of [WORKFLOW_ACTIONS.read, WORKFLOW_ACTIONS.use]) {
      await t.expectRefused(
        t.kai.id,
        "permissions.grant",
        toLena(action),
        t.forbidden("users.manage", "no_grant")
      );
    }
    const [own] = await t.stores.access.listGrants({ clientInstanceId, holderId: t.kai.id });
    await t.expectRefused(
      t.kai.id,
      "permissions.revoke",
      { params: { grantId: own?.id ?? "" } },
      t.forbidden("users.manage", "no_grant")
    );
    // An administrator's key issued for something else writes no row either.
    const capped = await t.call(t.admin.id, "permissions.grant", {
      ...toLena(WORKFLOW_ACTIONS.use),
      headers: { [SCOPES_HEADER]: "user_admin:read workflow_runs:write" }
    });
    expect(capped.statusCode, capped.body).toBe(403);
    expect(await rowsOf(t, t.lena.id)).toEqual([]);
    expect(await listed(t, t.lena.id)).toEqual([]);
    expect(await rowsOf(t, t.kai.id)).toHaveLength(2);
  });

  it("writes a row in a Namespace, on one Workflow or for the instance, and none for a workspace or a place the action has none", async () => {
    const t = await ready();
    const notify = await t.assetId(WORKFLOW_ASSET_KIND, NOTIFY);
    const workspaceId = await t.sharedWorkspace("Team");
    const refusedFor = async (action: string, scope: Record<string, unknown>, reason: string) => {
      const error = await t.expectRefused(
        t.admin.id,
        "permissions.grant",
        { payload: { holderKind: "user", holderId: t.kai.id, action, effect: "allow", ...scope } },
        { status: 422, code: "VALIDATION_FAILED" }
      );
      expect(error.details, `${action} ${JSON.stringify(scope)}`).toMatchObject({ reason });
    };
    const onNotify = { scopeKind: "asset", scopeId: notify };

    for (const action of [WORKFLOW_ACTIONS.read, WORKFLOW_ACTIONS.use]) {
      // No workspace owns a Workflow, and an instance row names no place.
      await refusedFor(action, { scopeKind: "instance", scopeId: notify }, "invalid_scope");
      await refusedFor(action, { scopeKind: "workspace", scopeId: workspaceId }, "invalid_scope");
      await refusedFor(
        action,
        { scopeKind: "asset", scopeId: await t.assetId("agent", "assistant") },
        "invalid_scope"
      );
    }
    // The rights 1c opens have no Namespace, and the run data is given on one Workflow only.
    await t.createNamespace("notify-");
    for (const action of [WORKFLOW_ACTIONS.delete, WORKFLOW_ACTIONS.readRunData]) {
      await refusedFor(action, { scopeKind: "namespace", namespace: "notify-" }, "invalid_scope");
    }
    await refusedFor(WORKFLOW_ACTIONS.readRunData, { scopeKind: "instance" }, "invalid_scope");
    expect(await rowsOf(t, t.kai.id)).toEqual([]);
    const deleting = await t.expectOk(t.admin.id, "permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: t.kai.id,
        action: WORKFLOW_ACTIONS.delete,
        ...onNotify
      }
    });
    expect(await rowsOf(t, t.kai.id)).toEqual([[WORKFLOW_ACTIONS.delete, "asset"]]);
    await revoke(t, grantSchema.parse(deleting.json()).id);

    // A Namespace covers the Workflows whose names start with its prefix, also later ones.
    await t.seedHistoricalGrant(t.kai.id, WORKFLOW_ACTIONS.use, { namespace: "notify-" });
    expect(await listed(t, t.kai.id)).toEqual([[NOTIFY, ["workflow.use"]]]);
    await t.expectOk(t.kai.id, "workflows.start", startOf(NOTIFY));
    await t.expectRefused(
      t.kai.id,
      "workflows.start",
      startOf(ARCHIVE),
      t.forbidden("workflow.use", "no_grant")
    );
  });

  it("lets a member with the write right edit the draft, and publish only with the publish right and the right over the principal", async () => {
    const t = await ready();
    const notify = await t.assetId(WORKFLOW_ASSET_KIND, NOTIFY);
    const address = { kind: WORKFLOW_ASSET_KIND, name: NOTIFY };
    const next = { ...notifyClients(), name: "Notify clients, reworded" };
    const draft = (expectedRevision: number) => ({
      params: address,
      payload: { config: { name: NOTIFY, manifest: next }, expectedRevision }
    });
    await t.expectRefused(
      t.kai.id,
      "assets.put",
      draft(1),
      t.forbidden("workflow.write", "no_grant")
    );

    await t.grant(t.kai.id, WORKFLOW_ACTIONS.write, { assetId: notify });
    const revision = await put(t, t.kai.id, NOTIFY, next, 1);

    // Editing the draft makes nothing live, and the write right publishes nothing.
    const publish = { params: address, payload: { revision } };
    await t.expectRefused(
      t.kai.id,
      "assets.publish",
      publish,
      t.forbidden("workflow.publish", "no_grant")
    );
    // The publish right alone lends nobody the rights of the principal the Workflow runs as.
    await t.grant(t.kai.id, WORKFLOW_ACTIONS.publish, { assetId: notify });
    await t.expectRefused(
      t.kai.id,
      "assets.publish",
      publish,
      t.forbidden("connection.use", "no_grant")
    );
    const asset = await t.stores.configAssets.getConfigAsset({ clientInstanceId, ...address });
    expect(asset?.publishedRevision).toBe(1);
    // The other Workflow is not hers to edit.
    await t.expectRefused(
      t.kai.id,
      "assets.put",
      {
        params: { kind: WORKFLOW_ASSET_KIND, name: ARCHIVE },
        payload: {
          config: { name: ARCHIVE, manifest: { ...notifyClients(), id: ARCHIVE } },
          expectedRevision: 1
        }
      },
      t.forbidden("workflow.write", "no_grant")
    );
  });

  it("lists an unpublished Workflow for its asset-only writer with the record's allowed rights", async () => {
    const t = await ready();
    const name = "draft-for-one-writer";
    await put(t, t.admin.id, name, { ...notifyClients(), id: name }, null);
    const assetId = await t.assetId(WORKFLOW_ASSET_KIND, name);
    await t.grant(t.kai.id, WORKFLOW_ACTIONS.write, { assetId });
    const rows = z
      .object({ items: z.array(assetSummarySchema) })
      .parse(
        (
          await t.expectOk(t.kai.id, "assets.list", { params: { kind: WORKFLOW_ASSET_KIND } })
        ).json()
      ).items;
    const record = assetSchema.parse(
      (
        await t.expectOk(t.kai.id, "assets.get", { params: { kind: WORKFLOW_ASSET_KIND, name } })
      ).json()
    );
    expect(rows.map((row) => row.name)).toEqual([name]);
    expect(rows[0]).toMatchObject({
      id: assetId,
      allowed: ["write"],
      draftRevision: record.revision
    });
    expect(record.allowed).toEqual(["write"]);
    expect(rows[0]?.allowed).toEqual(record.allowed);
  });

  it("opens the Workflow area for an asset-only publisher of an unpublished draft", async () => {
    const t = await ready();
    const name = "draft-for-one-publisher";
    await put(t, t.admin.id, name, { ...notifyClients(), id: name }, null);
    await t.grant(t.kai.id, WORKFLOW_ACTIONS.publish, {
      assetId: await t.assetId(WORKFLOW_ASSET_KIND, name)
    });
    const context = platformContextSchema.parse(
      (await t.expectOk(t.kai.id, "platform.context.get")).json()
    );
    expect(context.visibleSections).toContain("workflows");
    const rows = z
      .object({ items: z.array(assetSummarySchema) })
      .parse(
        (
          await t.expectOk(t.kai.id, "assets.list", { params: { kind: WORKFLOW_ASSET_KIND } })
        ).json()
      ).items;
    expect(rows.map((row) => row.name)).toEqual([name]);
    expect(rows[0]?.allowed).toEqual(["publish"]);
    const conversation = await t.expectOk(t.kai.id, "conversations.create", {
      payload: { title: "Publish Workflow", subject: { kind: WORKFLOW_ASSET_KIND, name } }
    });
    expect(conversation.json()).toMatchObject({ subject: { kind: WORKFLOW_ASSET_KIND, name } });
  });

  it("opens an edit conversation with a write-only grant on that Workflow and no other", async () => {
    const t = await ready();
    await t.grant(t.kai.id, WORKFLOW_ACTIONS.write, {
      assetId: await t.assetId(WORKFLOW_ASSET_KIND, NOTIFY)
    });
    const edit = await t.expectOk(t.kai.id, "conversations.create", {
      payload: { title: "Edit Workflow", subject: { kind: WORKFLOW_ASSET_KIND, name: NOTIFY } }
    });
    expect(edit.json()).toMatchObject({
      subject: { kind: WORKFLOW_ASSET_KIND, name: NOTIFY }
    });
    await t.expectRefused(
      t.kai.id,
      "conversations.create",
      {
        payload: { title: "Edit Workflow", subject: { kind: WORKFLOW_ASSET_KIND, name: ARCHIVE } }
      },
      { status: 404, code: "NOT_FOUND", details: { reason: "subject_unavailable" } }
    );
    await put(t, t.kai.id, NOTIFY, { ...notifyClients(), name: "Changed by its writer" }, 1);
  });

  it("keeps use-only access to a published Workflow out of asset-subject conversations", async () => {
    const t = await ready();
    await t.grant(t.kai.id, WORKFLOW_ACTIONS.use, {
      assetId: await t.assetId(WORKFLOW_ASSET_KIND, NOTIFY)
    });
    await t.expectOk(t.kai.id, "assets.get", {
      params: { kind: WORKFLOW_ASSET_KIND, name: NOTIFY }
    });
    await t.expectRefused(
      t.kai.id,
      "conversations.create",
      {
        payload: { title: "Workflow subject", subject: { kind: WORKFLOW_ASSET_KIND, name: NOTIFY } }
      },
      { status: 404, code: "NOT_FOUND", details: { reason: "subject_unavailable" } }
    );
  });

  it("keeps an asset delete deny in Workflow list and record answers over an instance grant", async () => {
    const t = await ready();
    const assetId = await t.assetId(WORKFLOW_ASSET_KIND, NOTIFY);
    for (const action of [WORKFLOW_ACTIONS.read, WORKFLOW_ACTIONS.delete]) {
      await t.expectOk(t.admin.id, "permissions.grant", {
        payload: { holderKind: "user", holderId: t.kai.id, action, scopeKind: "instance" }
      });
    }
    await t.expectOk(t.admin.id, "permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: t.kai.id,
        action: WORKFLOW_ACTIONS.delete,
        effect: "deny",
        scopeKind: "asset",
        scopeId: assetId
      }
    });
    const rows = z
      .object({ items: z.array(assetSummarySchema) })
      .parse(
        (
          await t.expectOk(t.kai.id, "assets.list", { params: { kind: WORKFLOW_ASSET_KIND } })
        ).json()
      ).items;
    const record = assetSchema.parse(
      (
        await t.expectOk(t.kai.id, "assets.get", {
          params: { kind: WORKFLOW_ASSET_KIND, name: NOTIFY }
        })
      ).json()
    );
    expect(record.allowed).toEqual(["read"]);
    expect(rows.find((row) => row.id === assetId)?.allowed).toEqual(record.allowed);
    expect(rows.find((row) => row.name === ARCHIVE)?.allowed).toEqual(["read", "delete"]);
  });

  it("gives a service principal the use right on one Workflow, and no other right of the kind", async () => {
    const t = await ready();
    const notify = await t.assetId(WORKFLOW_ASSET_KIND, NOTIFY);
    const toPrincipal = (action: string, scope: Record<string, unknown>) => ({
      payload: { holderKind: "service_principal", holderId: t.principal.id, action, ...scope }
    });
    const onNotify = { scopeKind: "asset", scopeId: notify };

    for (const action of [
      WORKFLOW_ACTIONS.read,
      WORKFLOW_ACTIONS.write,
      WORKFLOW_ACTIONS.publish,
      WORKFLOW_ACTIONS.delete,
      WORKFLOW_ACTIONS.readRunData
    ]) {
      const error = await t.expectRefused(
        t.root.id,
        "permissions.grant",
        toPrincipal(action, onNotify),
        { status: 422, code: "VALIDATION_FAILED" }
      );
      expect(error.details, action).toMatchObject({ reason: "action_not_grantable_to_principal" });
    }
    await t.createNamespace("notify-");
    const inNamespace = await t.expectRefused(
      t.root.id,
      "permissions.grant",
      toPrincipal(WORKFLOW_ACTIONS.use, { scopeKind: "namespace", namespace: "notify-" }),
      { status: 422, code: "VALIDATION_FAILED" }
    );
    expect(inNamespace.details).toMatchObject({ reason: "invalid_scope" });
    // Who does not administer principals gives one nothing; an administrator who is no
    // superadmin gives it a right she holds herself (RIGHTS-1a).
    await t.expectRefused(
      t.kai.id,
      "permissions.grant",
      toPrincipal(WORKFLOW_ACTIONS.use, onNotify),
      t.forbidden("service_principals.manage", "no_grant")
    );

    const written = await t.expectOk(
      t.admin.id,
      "permissions.grant",
      toPrincipal(WORKFLOW_ACTIONS.use, onNotify)
    );
    expect(grantSchema.parse(written.json())).toMatchObject({
      holderKind: "service_principal",
      holderId: t.principal.id,
      action: "workflow.use",
      effect: "allow",
      scopeKind: "asset",
      scopeId: notify
    });
  });

  // RIGHTS-1c, D4: the rows of a run's datasets are what the Workflow's principal read, so
  // `workflow.read_run_data` is given, and a deny of it lifted, only by a holder of every
  // right of the principal. Fails without `requireRunDataLendable`: the manager gives it.
  it("gives the run data of one Workflow only to a holder of every right of its principal", async () => {
    const t = await ready();
    const notify = await t.assetId(WORKFLOW_ASSET_KIND, NOTIFY);
    const manager = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Manager",
      roles: ["user"],
      permissions: ["users.manage"]
    });
    // The manager holds the right to give, on the Workflow, and not the principal's
    // `connection.use`.
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: manager.id,
      action: WORKFLOW_ACTIONS.readRunData,
      effect: "allow",
      scopeKind: "asset",
      scopeId: notify,
      grantedBy: t.root.id
    });
    const runData = (effect: "allow" | "deny") => ({
      payload: {
        holderKind: "user",
        holderId: t.kai.id,
        action: WORKFLOW_ACTIONS.readRunData,
        effect,
        scopeKind: "asset",
        scopeId: notify
      }
    });
    const refused = await t.expectRefused(
      manager.id,
      "permissions.grant",
      runData("allow"),
      t.forbidden("connection.use", "no_grant")
    );
    expect(refused.message).toBe(
      "This call does not hold 'connection.use' on the whole instance, and 'workflow-runner' would act with it. Only a holder of a right gives or lends it"
    );
    expect(await rowsOf(t, t.kai.id)).toEqual([]);

    // Lifting a deny of it gives it back, and asks the same.
    const deny = grantSchema.parse(
      (await t.expectOk(t.admin.id, "permissions.grant", runData("deny"))).json()
    ).id;
    await t.expectRefused(
      manager.id,
      "permissions.revoke",
      { params: { grantId: deny } },
      t.forbidden("connection.use", "no_grant")
    );

    // Once the manager holds what the principal holds, both pass.
    await t.allow({ kind: "user", id: manager.id }, "connection.use");
    await t.expectOk(manager.id, "permissions.revoke", { params: { grantId: deny } });
    await t.expectOk(manager.id, "permissions.grant", runData("allow"));
    expect(await rowsOf(t, t.kai.id)).toEqual([[WORKFLOW_ACTIONS.readRunData, "asset"]]);
  });
});
