import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { asUserId } from "@vivd-catalyst/core";
import { clientInstanceId, grantSchema, setupAccessInstance } from "./support/access-instance";
import { holdTransaction, settled } from "./support/postgres-concurrency-harness";
import { fileTestDatabaseUrl } from "./support/test-database";

// Access acceptance check 41 (RIGHTS-1b): people follow the rule of no escalation. Before it,
// a holder of `users.manage` alone gave any row, the admin role or a legacy key, also to
// themselves, and reset the password of an admin. Each test fails with its guard removed: the
// rule on a row given, on a role or key given, on an account changed, and the own-row refusal.

async function setup() {
  const t = await setupAccessInstance();
  // Manages users and holds nothing else: the holder the plan review found to be admin.
  const manager = await t.stores.users.createUser({
    clientInstanceId,
    displayLabel: "Manager",
    roles: ["user"],
    permissions: ["users.manage"]
  });
  await t.createNamespace("kai-");
  const rowFor = (holderId: string, action: string, effect: "allow" | "deny" = "allow") => ({
    payload: {
      holderKind: "user",
      holderId,
      action,
      effect,
      scopeKind: "namespace",
      namespace: "kai-"
    }
  });
  return { ...t, manager, rowFor };
}

const holderNotAdministrable = (operation: string) => ({
  status: 403,
  code: "FORBIDDEN",
  details: { action: operation, reason: "holder_not_administrable" }
});

describe("check 41: giving a person a row", () => {
  it("needs the action at the scope given, for an allow and a deny", async () => {
    const t = await setup();
    const refused = await t.expectRefused(
      t.manager.id,
      "permissions.grant",
      t.rowFor(t.kai.id, "agent.write"),
      t.forbidden("agent.write", "no_grant")
    );
    expect(refused.message).toBe(
      "This call does not hold 'agent.write' in the Namespace 'kai-', and 'Kai' would hold it. Only a holder of a right gives or lends it"
    );
    await t.expectRefused(
      t.manager.id,
      "permissions.grant",
      t.rowFor(t.kai.id, "agent.read", "deny"),
      t.forbidden("agent.read", "no_grant")
    );
    expect(await t.stores.access.listGrants({ clientInstanceId, holderId: t.kai.id })).toEqual([]);

    // Once the manager holds the right there, the manager gives it.
    await t.grant(t.manager.id, "agent.write", { namespace: "kai-" });
    await t.expectOk(t.manager.id, "permissions.grant", t.rowFor(t.kai.id, "agent.write"));
  });

  it("is never one's own, held or not, and lifting one's own deny is refused too", async () => {
    const t = await setup();
    // The admin holds every right of the role, and still writes no row for themselves.
    await t.expectRefused(
      t.admin.id,
      "permissions.grant",
      t.rowFor(t.admin.id, "agent.write"),
      holderNotAdministrable("permissions.grant")
    );
    const deny = await t.expectOk(
      t.root.id,
      "permissions.grant",
      t.rowFor(t.admin.id, "agent.write", "deny")
    );
    await t.expectRefused(
      t.admin.id,
      "permissions.revoke",
      { params: { grantId: grantSchema.parse(deny.json()).id } },
      holderNotAdministrable("permissions.revoke")
    );
  });

  it("lifts another person's deny only for a holder of what it refuses, and takes away freely", async () => {
    const t = await setup();
    const deny = grantSchema.parse(
      (
        await t.expectOk(t.root.id, "permissions.grant", t.rowFor(t.kai.id, "agent.read", "deny"))
      ).json()
    ).id;
    const allow = await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });
    await t.expectRefused(
      t.manager.id,
      "permissions.revoke",
      { params: { grantId: deny } },
      t.forbidden("agent.read", "no_grant")
    );
    // Taking a right away asks nothing of the rule.
    await t.expectOk(t.manager.id, "permissions.revoke", { params: { grantId: allow } });
    await t.expectOk(t.admin.id, "permissions.revoke", { params: { grantId: deny } });
  });
});

describe("check 41: giving a person a role or a legacy key", () => {
  it("needs each action the role or the key carries, and is never one's own", async () => {
    const t = await setup();
    const update = (by: string, userId: string, payload: Record<string, unknown>) =>
      t.call(by, "users.update", { params: { userId }, payload });

    const role = await update(t.manager.id, t.kai.id, { roles: ["user", "admin"] });
    expect(role.statusCode).toBe(403);
    expect(role.json()).toMatchObject({ error: { details: { reason: "no_grant" } } });
    const key = await update(t.manager.id, t.kai.id, { permissions: ["audit.view"] });
    expect(key.json()).toMatchObject({
      error: { details: { action: "audit.view", reason: "no_grant" } }
    });
    const created = await t.call(t.manager.id, "users.create", {
      payload: { displayLabel: "Newcomer", roles: ["user", "admin"] }
    });
    expect(created.statusCode).toBe(403);
    expect(
      (await t.stores.users.listUsers({ clientInstanceId })).map((u) => u.displayLabel)
    ).not.toContain("Newcomer");
    expect(
      await t.stores.users.getUser({ clientInstanceId, userId: asUserId(t.kai.id) })
    ).toMatchObject({ roles: ["user"], permissions: [] });

    // Lifting a revocation gives the key back.
    await update(t.root.id, t.kai.id, { permissions: ["!audit.view"] });
    const lifted = await update(t.manager.id, t.kai.id, { permissions: [] });
    expect(lifted.json()).toMatchObject({ error: { details: { action: "audit.view" } } });

    // Never to oneself: not the role, and not a key the admin holds through the role.
    for (const [by, payload] of [
      [t.manager.id, { roles: ["user", "admin"] }],
      [t.admin.id, { permissions: ["audit.view"] }]
    ] as const) {
      const own = await update(by, by, payload);
      expect(own.statusCode).toBe(403);
      expect(own.json()).toMatchObject({
        error: { details: { action: "users.update", reason: "holder_not_administrable" } }
      });
    }

    // A holder of every action gives the same.
    expect((await update(t.admin.id, t.kai.id, { roles: ["user", "admin"] })).statusCode).toBe(200);
  });
});

describe("check 41: changing a person's account", () => {
  it("needs every right the person holds, a disabled person's included", async () => {
    const t = await setup();
    const changes = (userId: string) =>
      [
        ["users.update", { params: { userId }, payload: { displayLabel: "Renamed" } }],
        ["users.update", { params: { userId }, payload: { status: "disabled" } }],
        [
          "users.identities.upsert",
          { params: { userId }, payload: { authSource: "oidc", externalUserId: `ext-${userId}` } }
        ],
        ["users.password.reset", { params: { userId }, payload: { password: "a-long-password-1" } }]
      ] as const;

    for (const [operation, input] of changes(t.admin.id)) {
      const refused = await t.call(t.manager.id, operation, input);
      expect({ operation, status: refused.statusCode }).toEqual({ operation, status: 403 });
      expect(JSON.stringify(refused.json())).toContain(
        "'Admin' holds it. Only a holder of every right of an account changes the account"
      );
    }
    await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });
    // A disabled admin holds the role's rights again once enabled, so the rule still asks them.
    await t.expectOk(t.root.id, "users.update", {
      params: { userId: t.admin.id },
      payload: { status: "disabled" }
    });
    const disabled = await t.call(t.manager.id, "users.update", {
      params: { userId: t.admin.id },
      payload: { status: "active" }
    });
    expect(disabled.statusCode).toBe(403);

    // A row the person holds counts like a role: Kai holds `agent.write` in `kai-`.
    const kai = await t.call(t.manager.id, "users.identities.upsert", changes(t.kai.id)[2][1]);
    expect(kai.json()).toMatchObject({
      error: { details: { action: "agent.write", reason: "no_grant" } }
    });

    // Lena holds nothing the manager lacks.
    for (const [operation, input] of changes(t.lena.id).slice(0, 3)) {
      await t.expectOk(t.manager.id, operation, input);
    }

    // A membership counts too: whoever takes the account opens the workspace's Apps.
    const workspaceId = await t.sharedWorkspace("Team");
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: workspaceId,
      userId: asUserId(t.lena.id),
      role: "member"
    });
    const member = await t.call(t.manager.id, "users.update", changes(t.lena.id)[0][1]);
    expect(member.json()).toMatchObject({
      error: { details: { action: "app.use", reason: "no_grant" } }
    });
    expect(JSON.stringify(member.json())).toContain(`in the workspace '${workspaceId}'`);
  });
});

// The second review of RIGHTS-1b: the references of tools a person may use were given outside
// the rule, also to oneself, and the account checks left a person's references out. Fails
// without the references in `rightsGiven` and in `personRights`.
describe("check 41: a reference of a tool", () => {
  const refsOf = async (t: Awaited<ReturnType<typeof setup>>, userId: string) =>
    (await t.stores.users.getUser({ clientInstanceId, userId: asUserId(userId) }))?.permissionRefs;

  it("is never given to oneself and only by a holder of it", async () => {
    const t = await setup();
    const own = await t.call(t.manager.id, "users.update", {
      params: { userId: t.manager.id },
      payload: { permissionRefs: ["private-tool"] }
    });
    expect(own.statusCode).toBe(403);
    expect(own.json()).toMatchObject({
      error: { details: { action: "users.update", reason: "holder_not_administrable" } }
    });
    expect(await refsOf(t, t.manager.id)).toEqual([]);

    const given = await t.call(t.manager.id, "users.update", {
      params: { userId: t.kai.id },
      payload: { permissionRefs: ["private-tool"] }
    });
    expect(given.json()).toMatchObject({
      error: { details: { action: "ref:private-tool", reason: "no_grant" } }
    });
    const created = await t.call(t.manager.id, "users.create", {
      payload: { displayLabel: "Newcomer", permissionRefs: ["private-tool"] }
    });
    expect(created.statusCode).toBe(403);
    expect(await refsOf(t, t.kai.id)).toEqual([]);

    // A holder of the reference gives it; taking it away asks nothing.
    await t.stores.users.updateUser({
      clientInstanceId,
      userId: asUserId(t.manager.id),
      permissionRefs: ["private-tool"]
    });
    await t.expectOk(t.manager.id, "users.update", {
      params: { userId: t.kai.id },
      payload: { permissionRefs: ["private-tool"] }
    });
    expect(await refsOf(t, t.kai.id)).toEqual(["private-tool"]);
  });

  it("counts among the rights of an account whoever changes it holds", async () => {
    const t = await setup();
    await t.stores.users.updateUser({
      clientInstanceId,
      userId: asUserId(t.lena.id),
      permissionRefs: ["private-tool"]
    });
    const renamed = await t.call(t.manager.id, "users.update", {
      params: { userId: t.lena.id },
      payload: { displayLabel: "Renamed" }
    });
    expect(renamed.statusCode).toBe(403);
    expect(renamed.json()).toMatchObject({
      error: { details: { action: "ref:private-tool", reason: "no_grant" } }
    });
  });
});

// The second review of RIGHTS-1b: the rules were asked before the write and not with it, so a
// user promoted between the check and the write ended with a sign-in of the caller. Fails
// without the `check` the store asks under the lock of the user: the sign-in is attached.
describe("check 41: the account checked is the account written", () => {
  it("refuses a sign-in for a user who became a superadmin after the first check", async () => {
    const t = await setup();
    const upsert = t.stores.users.upsertUserIdentity.bind(t.stores.users);
    // The promotion commits after the operation read Lena and before its write.
    t.stores.users.upsertUserIdentity = async (input) => {
      await t.stores.users.updateUser({
        clientInstanceId,
        userId: asUserId(t.lena.id),
        roles: ["user", "superadmin"]
      });
      return upsert(input);
    };
    const signIn = await t.call(t.manager.id, "users.identities.upsert", {
      params: { userId: t.lena.id },
      payload: { authSource: "oidc", externalUserId: "manager-own-sign-in" }
    });
    expect(signIn.statusCode).toBe(403);
    expect(JSON.stringify(signIn.json())).toContain("Only a superadmin may change a superadmin");
    const lena = await t.stores.users.getUser({ clientInstanceId, userId: asUserId(t.lena.id) });
    expect(lena?.identities.map((identity) => identity.externalUserId)).not.toContain(
      "manager-own-sign-in"
    );
  });

  it("refuses a change of a user given a right after the first check", async () => {
    const t = await setup();
    const update = t.stores.users.updateUser.bind(t.stores.users);
    t.stores.users.updateUser = async (input) => {
      if (input.userId === t.lena.id && input.check !== undefined) {
        await t.grant(t.lena.id, "agent.write", { namespace: "kai-" });
      }
      return update(input);
    };
    const renamed = await t.call(t.manager.id, "users.update", {
      params: { userId: t.lena.id },
      payload: { displayLabel: "Renamed" }
    });
    expect(renamed.json()).toMatchObject({
      error: { details: { action: "agent.write", reason: "no_grant" } }
    });
    const lena = await t.stores.users.getUser({ clientInstanceId, userId: asUserId(t.lena.id) });
    expect(lena?.displayLabel).toBe("Lena");
  });
});

describe("check 41: the lock of the account checked", () => {
  // Fails with the lock the identity writes took before, which shares the user with a grant
  // written for them: the write does not wait, and the check misses the row.
  it("keeps the write waiting for a row being written for the user, and counts it", async () => {
    const t = await setup();
    const sql = postgres(await fileTestDatabaseUrl(), { max: 2 });
    try {
      // What `createGrant` does for Lena, held open: the user shared, the row not committed.
      const granting = await holdTransaction(sql, async (tx) => {
        await tx`select id from product_users where id = ${t.lena.id} for share`;
        await tx`
          insert into permission_grants
            (id, client_instance_id, holder_kind, holder_id, action, effect, scope_kind,
             namespace, granted_by, created_at)
          values ('grant_race', ${clientInstanceId}, 'user', ${t.lena.id}, 'agent.write',
             'allow', 'namespace', 'kai-', ${t.root.id}, now())`;
      });
      const renaming = settled(
        t.call(t.manager.id, "users.update", {
          params: { userId: t.lena.id },
          payload: { displayLabel: "Renamed" }
        })
      );
      const deadline = Date.now() + 15_000;
      for (;;) {
        const [row] = await sql<Array<{ waiting: number }>>`
          select count(*)::int as waiting from pg_locks where not granted`;
        if ((row?.waiting ?? 0) > 0) break;
        if (Date.now() > deadline) throw new Error("The rename never waited for the user");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await granting.commit();
      const outcome = await renaming;
      if (outcome.status !== "fulfilled") throw outcome.reason;
      expect(outcome.value.json()).toMatchObject({
        error: { details: { action: "agent.write", reason: "no_grant" } }
      });
    } finally {
      await sql.end();
    }
  });
});
