import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  GRANTABLE_ACTION_SCOPES,
  GRANTABLE_ACTIONS,
  LEGACY_PERMISSION_ACTIONS,
  ROLE_DEFAULT_ACTIONS,
  createAuthorizer,
  isAppError,
  type AccessResource,
  type ActorAccess,
  type UserRecord
} from "@work-shape/catalyst-core";
import { resolveEffectivePermissions } from "./support/ap4-verify/pre-ap4-permissions";
import { SCOPES_HEADER, clientInstanceId, type AccessInstance } from "./support/access-instance";
import { assetPageSchema } from "./support/asset-operations";
import { connection, setupConnectionInstance } from "./support/connections";

// The rights of a Connection: the five actions, who holds them by role, which of them a grant
// row can be written for and at which scope, and that each right opens what it names and
// nothing beside it.

const CONNECTION_RIGHTS = [
  "connection.read",
  "connection.use",
  "connection.write",
  "connection.delete",
  "connection.approve"
];

/** The rights of one stored user, decided by the evaluator every operation decides with. */
function accessOf(t: AccessInstance, user: UserRecord): Promise<ActorAccess> {
  return createAuthorizer(t.stores.access).forActor({
    id: user.id,
    externalUserId: user.id,
    displayLabel: user.displayLabel,
    roles: user.roles,
    permissions: user.permissions,
    permissionRefs: user.permissionRefs,
    clientInstanceId,
    authSource: "test",
    scopes: ["*"]
  });
}

function resourceOf(name: string, assetId: string): AccessResource {
  return { kind: "connection", name, assetId };
}

/** What `require` refuses with: the action and the reason. */
function refusalOf(access: ActorAccess, action: string, resource: AccessResource): unknown {
  try {
    access.require(action, resource);
  } catch (error) {
    return isAppError(error) ? { code: error.code, details: error.details } : error;
  }
  return undefined;
}

describe("the vocabulary of Connection rights", () => {
  it("holds the five actions, all of them with the administrator's role and none with a user's", () => {
    expect(ACTIONS.filter((action) => action.startsWith("connection."))).toEqual(CONNECTION_RIGHTS);
    for (const role of ["admin", "superadmin"] as const) {
      expect(
        ROLE_DEFAULT_ACTIONS[role].filter((action) => action.startsWith("connection.")),
        role
      ).toEqual(CONNECTION_RIGHTS);
    }
    expect(ROLE_DEFAULT_ACTIONS.user).toEqual([]);
  });

  it("gives no legacy key a Connection right and no role another legacy key than before", async () => {
    expect(
      Object.values(LEGACY_PERMISSION_ACTIONS)
        .flat()
        .filter((action) => action.startsWith("connection."))
    ).toEqual([]);
    // Snapshot the historical role vocabulary; keep the no-Connection-right invariant above.
    await expect(
      ["user", "admin", "superadmin"]
        .map((role) =>
          JSON.stringify({
            role,
            permissions: [...resolveEffectivePermissions({ roles: [role], permissions: [] })]
          })
        )
        .join("\n") +
        "\n" +
        JSON.stringify({
          adminActions: ROLE_DEFAULT_ACTIONS.admin.filter(
            (action) =>
              !/^(?:connection|app|workflow|data_store|knowledge_base|guardrail)\./u.test(action)
          )
        }) +
        "\n"
    ).toMatchFileSnapshot("./__snapshots__/rights.txt");
  });

  it("lets a new grant row name reading and using on one Connection or the instance", () => {
    expect(GRANTABLE_ACTIONS.filter((action) => action.startsWith("connection."))).toEqual([
      "connection.read",
      "connection.use"
    ]);
    // A workspace owns agents, skills, Apps and Data Stores (WS-OWN-1a), so their rights are
    // written there too. No workspace owns a Connection, so no right on Connections is written
    // at workspace scope. A right no legacy key carries is also written for the whole instance
    // (RIGHTS-1c, D3); agent and skill rights are carried by legacy keys, so they are not.
    expect(GRANTABLE_ACTION_SCOPES["connection.use"]).toEqual(["asset", "instance"]);
    expect(GRANTABLE_ACTION_SCOPES["guardrail.publish"]).toEqual(["workspace", "instance"]);
    for (const action of GRANTABLE_ACTIONS) {
      const scopes: readonly string[] = GRANTABLE_ACTION_SCOPES[action];
      expect(scopes.includes("workspace"), action).toBe(
        /^(?:agent|skill|app|data_store|guardrail)\./u.test(action)
      );
      expect(scopes.includes("instance"), action).toBe(
        !/^(?:agent|skill)\./u.test(action) && action !== "workflow.read_run_data"
      );
    }
  });
});

describe("a right on a Connection", () => {
  it("opens what it names: reading is not using, using is not writing or reading", async () => {
    const t = await setupConnectionInstance();
    const a = await t.seed("alpha");
    await t.grant(t.kai.id, "connection.read", { assetId: a });
    await t.grant(t.lena.id, "connection.use", { assetId: a });
    const kai = await accessOf(t, t.kai);
    const lena = await accessOf(t, t.lena);
    const alpha = resourceOf("alpha", a);

    expect(kai.authorize("connection.read", alpha)).toEqual({ allowed: true, source: "grant" });
    for (const action of CONNECTION_RIGHTS.filter((right) => right !== "connection.read")) {
      expect(kai.authorize(action, alpha), action).toEqual({ allowed: false, reason: "no_grant" });
    }
    expect(refusalOf(kai, "connection.use", alpha)).toEqual({
      code: "FORBIDDEN",
      details: { action: "connection.use", reason: "no_grant" }
    });

    expect(lena.authorize("connection.use", alpha)).toEqual({ allowed: true, source: "grant" });
    for (const action of CONNECTION_RIGHTS.filter((right) => right !== "connection.use")) {
      expect(lena.authorize(action, alpha), action).toEqual({
        allowed: false,
        reason: "no_grant"
      });
    }
    expect(refusalOf(lena, "connection.write", alpha)).toEqual({
      code: "FORBIDDEN",
      details: { action: "connection.write", reason: "no_grant" }
    });
  });

  it("on Connection A is refused on Connection B, with the right named", async () => {
    const t = await setupConnectionInstance();
    const a = await t.seed("alpha");
    const b = await t.seed("beta");
    await t.grant(t.kai.id, "connection.use", { assetId: a });
    await t.grant(t.kai.id, "connection.read", { assetId: a });
    const kai = await accessOf(t, t.kai);

    expect(kai.authorize("connection.use", resourceOf("alpha", a)).allowed).toBe(true);
    expect(refusalOf(kai, "connection.use", resourceOf("beta", b))).toEqual({
      code: "FORBIDDEN",
      details: { action: "connection.use", reason: "no_grant" }
    });
    // Asked without a Connection, as the right on every one, it is refused too.
    expect(kai.authorize("connection.use")).toEqual({ allowed: false, reason: "no_grant" });

    // The asset operations decide with the same evaluator.
    const read = (name: string) => ({ params: { kind: "connection", name } });
    await t.expectOk(t.kai.id, "assets.get", read("alpha"));
    await t.expectRefused(
      t.kai.id,
      "assets.get",
      read("beta"),
      t.forbidden("connection.read", "no_grant")
    );
    const listed = await t.expectOk(t.kai.id, "assets.list", { params: { kind: "connection" } });
    expect(assetPageSchema.parse(listed.json()).items.map((item) => item.name)).toEqual(["alpha"]);
    await t.expectRefused(
      t.kai.id,
      "assets.put",
      { ...read("alpha"), payload: { config: connection("alpha", { enabled: false }) } },
      t.forbidden("connection.write", "no_grant")
    );
    await t.expectRefused(
      t.kai.id,
      "assets.delete",
      read("alpha"),
      t.forbidden("connection.delete", "no_grant")
    );
  });

  it("in a Namespace covers the Connections of that prefix and no other", async () => {
    // Fails without the Namespace scope: the two grants are refused with `invalid_scope`.
    const t = await setupConnectionInstance();
    await t.createNamespace("kai-");
    const inside = await t.seed("kai-crm");
    const outside = await t.seed("crm");
    await t.seedHistoricalGrant(t.kai.id, "connection.read", { namespace: "kai-" });
    await t.seedHistoricalGrant(t.lena.id, "connection.use", { namespace: "kai-" });
    const kai = await accessOf(t, t.kai);
    const lena = await accessOf(t, t.lena);

    expect(kai.authorize("connection.read", resourceOf("kai-crm", inside))).toEqual({
      allowed: true,
      source: "grant"
    });
    expect(kai.authorize("connection.use", resourceOf("kai-crm", inside)).allowed).toBe(false);
    expect(lena.authorize("connection.use", resourceOf("kai-crm", inside))).toEqual({
      allowed: true,
      source: "grant"
    });
    for (const access of [kai, lena]) {
      for (const action of CONNECTION_RIGHTS) {
        expect(access.authorize(action, resourceOf("crm", outside)), action).toEqual({
          allowed: false,
          reason: "no_grant"
        });
      }
      // The Namespace opens nothing that writes, deletes or approves.
      for (const action of ["connection.write", "connection.delete", "connection.approve"]) {
        expect(access.authorize(action, resourceOf("kai-crm", inside)).allowed, action).toBe(false);
      }
    }

    // The asset operations and the platform context decide with the same evaluator.
    const read = (name: string) => ({ params: { kind: "connection", name } });
    await t.expectOk(t.kai.id, "assets.get", read("kai-crm"));
    await t.expectRefused(
      t.kai.id,
      "assets.get",
      read("crm"),
      t.forbidden("connection.read", "no_grant")
    );
    const listed = await t.expectOk(t.kai.id, "assets.list", { params: { kind: "connection" } });
    expect(assetPageSchema.parse(listed.json()).items.map((item) => item.name)).toEqual([
      "kai-crm"
    ]);
    // The context names the Namespace with the action, which is what Build reads to show
    // the kind's list.
    const context = (await t.expectOk(t.kai.id, "platform.context.get")).json<{
      namespaces: Array<{ prefix: string; actions: string[] }>;
    }>();
    expect(context.namespaces).toEqual([
      { prefix: "kai-", displayName: "kai-", actions: ["connection.read"] }
    ]);
    // A deny on one Connection of the Namespace wins over the Namespace's allow.
    await t.grant(t.kai.id, "connection.read", { assetId: inside }, "deny");
    expect(
      (await accessOf(t, t.kai)).authorize("connection.read", resourceOf("kai-crm", inside)).allowed
    ).toBe(false);
  });

  it("on the whole instance is named by the platform context, a right on one Connection is not", async () => {
    const t = await setupConnectionInstance();
    const a = await t.seed("alpha");
    await t.grant(t.kai.id, "connection.read", { assetId: a });
    await t.grant(t.lena.id, "connection.use", { assetId: a });
    const contextOf = async (userId: string) =>
      (await t.expectOk(userId, "platform.context.get")).json<{
        actions: string[];
        assetActions: string[];
      }>();
    const admin = await contextOf(t.admin.id);
    expect(admin.actions.filter((action) => action.startsWith("connection."))).toEqual([
      "connection.read",
      "connection.write",
      "connection.delete"
    ]);
    expect(admin.assetActions).toEqual([]);
    // A read grant on one Connection says that the kind has a list for its holder: Build
    // shows Connections. A grant to use says nothing of the kind.
    const kai = await contextOf(t.kai.id);
    expect(kai.actions).toEqual([]);
    expect(kai.assetActions).toEqual(["connection.read"]);
    const lena = await contextOf(t.lena.id);
    expect(lena.actions).toEqual([]);
    expect(lena.assetActions).toEqual([]);
  });

  it("on one workspace's Connections, or denied on one, is named or not by the platform context", async () => {
    const t = await setupConnectionInstance();
    const a = await t.seed("alpha");
    // No grant writes this row any more; one written before is still read.
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.kai.id,
      action: "connection.read",
      effect: "allow",
      scopeKind: "workspace",
      scopeId: await t.sharedWorkspace("Team"),
      grantedBy: t.root.id
    });
    await t.grant(t.lena.id, "connection.read", { assetId: a }, "deny");
    const assetActionsOf = async (userId: string, scopes?: string) =>
      (
        await t.expectOk(userId, "platform.context.get", {
          ...(scopes === undefined ? {} : { headers: { [SCOPES_HEADER]: scopes } })
        })
      ).json<{ assetActions: string[] }>().assetActions;
    expect(await assetActionsOf(t.kai.id)).toEqual(["connection.read"]);
    expect(await assetActionsOf(t.lena.id)).toEqual([]);
    // A credential whose scopes read no asset is told of no list.
    expect(await assetActionsOf(t.kai.id, "chat:read")).toEqual([]);
  });

  it("to use is no right to read: the holder is shown nothing of the Connection", async () => {
    const t = await setupConnectionInstance();
    const a = await t.seed("alpha");
    await t.grant(t.lena.id, "connection.use", { assetId: a });
    const read = { params: { kind: "connection", name: "alpha" } };
    await t.expectRefused(
      t.lena.id,
      "assets.get",
      read,
      t.forbidden("connection.read", "no_grant")
    );
    await t.expectRefused(
      t.lena.id,
      "assets.revisions.list",
      read,
      t.forbidden("connection.read", "no_grant")
    );
    const listed = await t.expectOk(t.lena.id, "assets.list", { params: { kind: "connection" } });
    expect(assetPageSchema.parse(listed.json()).items).toEqual([]);
  });

  it("is taken from an administrator by a deny on the Connection", async () => {
    const t = await setupConnectionInstance();
    const a = await t.seed("alpha");
    const b = await t.seed("beta");
    expect(
      (await accessOf(t, t.admin)).authorize("connection.use", resourceOf("alpha", a))
    ).toEqual({ allowed: true, source: "role" });
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.admin.id,
      action: "connection.use",
      effect: "deny",
      scopeKind: "asset",
      scopeId: a,
      grantedBy: t.root.id
    });
    const admin = await accessOf(t, t.admin);
    expect(admin.authorize("connection.use", resourceOf("alpha", a))).toEqual({
      allowed: false,
      reason: "denied"
    });
    expect(admin.authorize("connection.use", resourceOf("beta", b)).allowed).toBe(true);
  });

  it("is held by nobody through the legacy keys", async () => {
    const t = await setupConnectionInstance();
    const a = await t.seed("alpha");
    const editor = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Editor",
      roles: ["user"],
      permissions: ["config_assets.read", "config_assets.write", "agent_skills.approve"]
    });
    const access = await accessOf(t, editor);
    expect(access.authorize("agent.write").allowed).toBe(true);
    for (const action of CONNECTION_RIGHTS) {
      expect(access.authorize(action, resourceOf("alpha", a)), action).toEqual({
        allowed: false,
        reason: "no_grant"
      });
    }
  });
});

describe("a grant of a Connection right", () => {
  const invalidScope = { status: 422, code: "VALIDATION_FAILED" };

  it("is written on one Connection and refused for every other action and place", async () => {
    const t = await setupConnectionInstance();
    const a = await t.seed("alpha");
    await t.createNamespace("kai-");
    const agentId = await t.assetId("agent", "assistant");
    const grant = (action: string, scope: Record<string, unknown>) => ({
      payload: { holderKind: "user", holderId: t.kai.id, action, ...scope }
    });
    const refusedFor = async (
      action: string,
      scope: Record<string, unknown>,
      reason: string
    ): Promise<void> => {
      const error = await t.expectRefused(
        t.admin.id,
        "permissions.grant",
        grant(action, scope),
        invalidScope
      );
      expect(error.details, `${action} ${JSON.stringify(scope)}`).toMatchObject({ reason });
    };
    const onAlpha = { scopeKind: "asset", scopeId: a };

    await t.expectOk(t.admin.id, "permissions.grant", grant("connection.use", onAlpha));
    await t.expectOk(t.admin.id, "permissions.grant", grant("connection.read", onAlpha));
    for (const action of ["connection.write", "connection.delete", "connection.approve"]) {
      await refusedFor(action, onAlpha, "action_not_grantable");
    }
    // No instance row with a place named, and no row in a Namespace that does not exist.
    // Writing stays with the role in a Namespace as on one Connection.
    await refusedFor("connection.use", { scopeKind: "instance", scopeId: a }, "invalid_scope");
    await refusedFor(
      "connection.use",
      { scopeKind: "namespace", namespace: "nobody-" },
      "invalid_scope"
    );
    await refusedFor(
      "connection.write",
      { scopeKind: "namespace", namespace: "kai-" },
      "action_not_grantable"
    );
    // The asset has to be a Connection, and a Connection is no scope of an agent right.
    await refusedFor("connection.use", { scopeKind: "asset", scopeId: agentId }, "invalid_scope");
    await refusedFor("agent.read", onAlpha, "invalid_scope");
    await refusedFor(
      "connection.use",
      { scopeKind: "asset", scopeId: "asset_gone" },
      "invalid_scope"
    );

    const rows = await t.stores.access.listGrants({ clientInstanceId, holderId: t.kai.id });
    expect(rows.map((row) => [row.action, row.scopeKind, row.scopeId])).toEqual(
      expect.arrayContaining([
        ["connection.use", "asset", a],
        ["connection.read", "asset", a]
      ])
    );
    expect(rows).toHaveLength(2);
  });

  it("is refused on a workspace, which owns no Connection", async () => {
    const t = await setupConnectionInstance();
    const team = await t.sharedWorkspace("Team");
    for (const action of ["connection.use", "connection.read"]) {
      const error = await t.expectRefused(
        t.admin.id,
        "permissions.grant",
        {
          payload: {
            holderKind: "user",
            holderId: t.kai.id,
            action,
            scopeKind: "workspace",
            scopeId: team
          }
        },
        invalidScope
      );
      expect(error.details, action).toMatchObject({ reason: "invalid_scope" });
    }
    expect(await t.stores.access.listGrants({ clientInstanceId, scopeKind: "workspace" })).toEqual(
      []
    );
  });
});

// No operation writes a workspace row today. The store keeps such a row to a Shared Workspace
// and removes it with its workspace, for the kinds a workspace will own.
describe("a grant row on a workspace", () => {
  it("is written on a Shared Workspace only, and goes with it", async () => {
    const t = await setupConnectionInstance();
    const team = await t.sharedWorkspace("Team");
    const personal = await t.stores.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: t.kai.id
    });
    const rowOn = (holderId: string, workspaceId: string) =>
      t.stores.access.createGrant({
        clientInstanceId,
        holderKind: "user",
        holderId,
        action: "agent.read",
        effect: "allow",
        scopeKind: "workspace",
        scopeId: workspaceId,
        grantedBy: t.root.id
      });
    const refusal = (holderId: string, workspaceId: string) =>
      rowOn(holderId, workspaceId).then(
        () => "written",
        (error: unknown) => (isAppError(error) ? error.details : error)
      );

    await rowOn(t.kai.id, team);
    for (const workspaceId of [personal.id, "ws_not_there"]) {
      expect(await refusal(t.lena.id, workspaceId), workspaceId).toMatchObject({
        reason: "invalid_scope"
      });
    }
    await t.stores.workspaces.markWorkspaceDeletionRequested({
      clientInstanceId,
      collaborationWorkspaceId: team
    });
    expect(await refusal(t.lena.id, team)).toMatchObject({ reason: "invalid_scope" });
    await t.stores.workspaces.deleteWorkspace({
      clientInstanceId,
      collaborationWorkspaceId: team
    });
    expect(await t.stores.access.listGrants({ clientInstanceId, scopeKind: "workspace" })).toEqual(
      []
    );
  });
});
