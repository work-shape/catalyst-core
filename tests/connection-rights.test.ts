import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  GRANTABLE_ACTION_SCOPES,
  GRANTABLE_ACTIONS,
  LEGACY_PERMISSION_ACTIONS,
  ROLE_DEFAULT_ACTIONS,
  ROLE_DEFAULT_PERMISSIONS,
  createAuthorizer,
  isAppError,
  type AccessResource,
  type ActorAccess,
  type UserRecord
} from "@vivd-catalyst/core";
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

function resourceOf(name: string, assetId: string, workspaceId?: string): AccessResource {
  return {
    kind: "connection",
    name,
    assetId,
    ...(workspaceId === undefined ? {} : { workspaceId })
  };
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

  it("gives no legacy key a Connection right and no role another legacy key than before", () => {
    expect(
      Object.values(LEGACY_PERMISSION_ACTIONS)
        .flat()
        .filter((action) => action.startsWith("connection."))
    ).toEqual([]);
    expect(ROLE_DEFAULT_PERMISSIONS).toEqual({
      user: [],
      admin: [
        "agent_skills.approve",
        "config_assets.read",
        "config_assets.write",
        "usage.view",
        "users.manage",
        "audit.view"
      ],
      superadmin: [
        "agent_skills.approve",
        "config_assets.read",
        "config_assets.write",
        "usage.view",
        "users.manage",
        "api_access.manage",
        "agent_models.manage",
        "audit.view"
      ]
    });
    // What an administrator held before, action by action, is what the role holds now.
    expect(
      ROLE_DEFAULT_ACTIONS.admin.filter((action) => !/^(?:connection|app)\./u.test(action))
    ).toEqual([
      "agent.read",
      "agent.write",
      "agent.delete",
      "skill.read",
      "skill.write",
      "skill.delete",
      "skill.approve",
      "operations.approve",
      "users.manage",
      "usage.view",
      "audit.view"
    ]);
  });

  it("lets a grant row name reading and using, in a Namespace, on one Connection or one workspace", () => {
    expect(GRANTABLE_ACTIONS.filter((action) => action.startsWith("connection."))).toEqual([
      "connection.read",
      "connection.use"
    ]);
    expect(GRANTABLE_ACTION_SCOPES["connection.read"]).toEqual(["namespace", "asset", "workspace"]);
    expect(GRANTABLE_ACTION_SCOPES["connection.use"]).toEqual(["namespace", "asset", "workspace"]);
    // The scopes of agents and skills are the ones they had.
    for (const action of GRANTABLE_ACTIONS.filter((name) => !name.startsWith("connection."))) {
      expect(GRANTABLE_ACTION_SCOPES[action], action).toEqual(["namespace", "asset"]);
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
    await t.grant(t.kai.id, "connection.read", { namespace: "kai-" });
    await t.grant(t.lena.id, "connection.use", { namespace: "kai-" });
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
    const workspaceId = await t.sharedWorkspace("Team");
    await t.grant(t.kai.id, "connection.read", { workspaceId });
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
    // No instance row, and no row in a Namespace that does not exist. Writing stays with the
    // role in a Namespace as on one Connection.
    await refusedFor("connection.use", { scopeKind: "instance" }, "invalid_scope");
    await refusedFor(
      "connection.use",
      { scopeKind: "namespace", namespace: "nobody-" },
      "unknown_namespace"
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

  it("is written on a Shared Workspace, covers what that workspace owns, and goes with it", async () => {
    const t = await setupConnectionInstance();
    const a = await t.seed("alpha");
    const team = await t.sharedWorkspace("Team");
    const other = await t.sharedWorkspace("Other team");
    const personal = await t.stores.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: t.kai.id
    });
    const grant = (action: string, workspaceId: string) => ({
      payload: {
        holderKind: "user",
        holderId: t.kai.id,
        action,
        scopeKind: "workspace",
        scopeId: workspaceId
      }
    });

    await t.expectOk(t.admin.id, "permissions.grant", grant("connection.use", team));
    await t.expectOk(t.admin.id, "permissions.grant", grant("connection.read", team));
    for (const [action, workspaceId] of [
      ["connection.use", personal.id],
      ["connection.use", "ws_not_there"],
      // An agent or skill right has no workspace row yet.
      ["agent.read", team],
      ["skill.write", team]
    ] as const) {
      const error = await t.expectRefused(
        t.admin.id,
        "permissions.grant",
        grant(action, workspaceId),
        invalidScope
      );
      expect(error.details, `${action} ${workspaceId}`).toMatchObject({ reason: "invalid_scope" });
    }
    const missingId = await t.expectRefused(
      t.admin.id,
      "permissions.grant",
      { payload: { ...grant("connection.use", team).payload, scopeId: undefined } },
      invalidScope
    );
    expect(missingId.details).toMatchObject({ reason: "invalid_scope" });

    const kai = await accessOf(t, t.kai);
    // A Connection the workspace owns is covered, one of another workspace or of the instance
    // is not.
    expect(kai.authorize("connection.use", resourceOf("team-crm", "asset_1", team)).allowed).toBe(
      true
    );
    expect(kai.authorize("connection.use", resourceOf("other-crm", "asset_2", other))).toEqual({
      allowed: false,
      reason: "no_grant"
    });
    expect(kai.authorize("connection.use", resourceOf("alpha", a))).toEqual({
      allowed: false,
      reason: "no_grant"
    });
    await t.expectRefused(
      t.kai.id,
      "assets.get",
      { params: { kind: "connection", name: "alpha" } },
      t.forbidden("connection.read", "no_grant")
    );

    // The rows go with the workspace they name.
    await t.stores.workspaces.markWorkspaceDeletionRequested({
      clientInstanceId,
      collaborationWorkspaceId: team
    });
    const closed = await t.expectRefused(
      t.admin.id,
      "permissions.grant",
      {
        payload: { ...grant("connection.use", team).payload, holderId: t.lena.id }
      },
      invalidScope
    );
    expect(closed.details).toMatchObject({ reason: "invalid_scope" });
    await t.stores.workspaces.deleteWorkspace({
      clientInstanceId,
      collaborationWorkspaceId: team
    });
    expect(await t.stores.access.listGrants({ clientInstanceId, scopeKind: "workspace" })).toEqual(
      []
    );
  });
});
