import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { roleSchema } from "@work-shape/catalyst-api-contract";
import { runCli } from "@work-shape/catalyst-cli";
import { ROLE_DEFAULT_ACTIONS } from "@work-shape/catalyst-core";
import { migrateDatabase } from "@work-shape/catalyst-postgres-store";
import {
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { setupPersonalKeyInstance } from "./support/personal-api-keys";
import { createTestFetch } from "./support/test-instance";
import { fileTestDatabaseUrl } from "./support/test-database";
import { withTestSql } from "./support/test-sql";

// Roles as data (ADR-0028): `user` and `admin` are rows once a superadmin edits them, reset to
// the release's default, and reconciled at deploy; `superadmin` is the floor; custom roles
// give what they list.

const instances: AccessInstance[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((t) => t.instance.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function setup(): Promise<AccessInstance> {
  const t = await setupAccessInstance();
  instances.push(t);
  return t;
}

const effectiveSchema = z.object({
  items: z.array(
    z.object({ action: z.string(), source: z.string(), roleId: z.string().optional() }).loose()
  )
});

async function role(t: AccessInstance, roleId: string) {
  return roleSchema.parse(
    (await t.expectOk(t.root.id, "roles.get", { params: { roleId } })).json()
  );
}

async function auditOf(t: AccessInstance, type: string) {
  return t.stores.audit.listAuditEvents({ clientInstanceId, type });
}

const instanceAllow = (action: string) => ({ action, effect: "allow", scopeKind: "instance" });

describe("built-in roles as data", () => {
  it("an edited user role changes what a user may do on the next call", async () => {
    const t = await setup();
    await t.expectRefused(t.kai.id, "usage.get_summary", {}, t.forbidden("usage.view", "no_grant"));

    await t.expectOk(t.root.id, "roles.update", {
      params: { roleId: "user" },
      payload: { grants: [instanceAllow("usage.view")] }
    });

    await t.expectOk(t.kai.id, "usage.get_summary");
    const effective = effectiveSchema.parse(
      (
        await t.expectOk(t.kai.id, "permissions.effective", {
          query: { holderKind: "user", holderId: t.kai.id }
        })
      ).json()
    );
    expect(effective.items.filter((entry) => entry.source === "role")).toEqual([
      expect.objectContaining({ action: "usage.view", roleId: "user" })
    ]);
    expect(await role(t, "user")).toMatchObject({ equalsDefault: false, builtIn: true });
    const [event] = await auditOf(t, "role.updated");
    expect(event?.metadata).toMatchObject({
      roleId: "user",
      added: [instanceAllow("usage.view")],
      removed: []
    });
  });

  it("reset to default restores the release's bundle of admin", async () => {
    const t = await setup();
    const narrowed = ROLE_DEFAULT_ACTIONS.admin.filter((action) => action !== "audit.view");
    await t.expectOk(t.root.id, "roles.update", {
      params: { roleId: "admin" },
      payload: { grants: narrowed.map(instanceAllow) }
    });
    await t.expectRefused(
      t.admin.id,
      "audit_events.list",
      {},
      t.forbidden("audit.view", "no_grant")
    );

    const reset = roleSchema.parse(
      (await t.expectOk(t.root.id, "roles.reset", { params: { roleId: "admin" } })).json()
    );

    expect(reset.equalsDefault).toBe(true);
    expect(reset.grants.map((grant) => grant.action).sort()).toEqual(
      [...ROLE_DEFAULT_ACTIONS.admin].sort()
    );
    await t.expectOk(t.admin.id, "audit_events.list");
    const [event] = await auditOf(t, "role.reset");
    expect(event?.metadata).toMatchObject({
      roleId: "admin",
      added: [instanceAllow("audit.view")]
    });
  });

  it("shows superadmin read-only with the floor, and lets nobody write it", async () => {
    const t = await setup();
    const floor = await role(t, "superadmin");
    expect(floor.editable).toBe(false);
    expect(floor.grants.map((grant) => grant.action)).not.toContain("assets.release");
    expect(floor.grants.map((grant) => grant.action)).toContain("api_access.manage");
    for (const [operation, input] of [
      ["roles.update", { params: { roleId: "superadmin" }, payload: { grants: [] } }],
      ["roles.reset", { params: { roleId: "superadmin" } }],
      ["roles.delete", { params: { roleId: "superadmin" } }]
    ] as const) {
      await t.expectRefused(t.root.id, operation, input, {
        status: 403,
        code: "FORBIDDEN",
        details: { action: operation, reason: "holder_not_administrable" }
      });
    }
  });

  it("never lets a deny take users.manage on the instance from a superadmin", async () => {
    const t = await setup();
    await withTestSql(
      (sql) => sql`
        insert into permission_grants
          (id, client_instance_id, holder_kind, holder_id, action, scope_kind, effect, granted_by, created_at)
        values
          ('grant_deny_root', ${clientInstanceId}, 'user', ${t.root.id}, 'users.manage', 'instance', 'deny', ${t.admin.id}, now())`
    );
    await t.expectOk(t.root.id, "users.list");
  });
});

describe("only a superadmin writes what only a superadmin hands out", () => {
  it("refuses an admin's edit or reset of a built-in role, and records the refusal", async () => {
    const t = await setup();
    const rule = (operation: string) => ({
      status: 403,
      code: "FORBIDDEN",
      details: { action: operation, reason: "no_grant" }
    });
    await t.expectRefused(
      t.admin.id,
      "roles.update",
      { params: { roleId: "user" }, payload: { grants: [instanceAllow("usage.view")] } },
      rule("roles.update")
    );
    await t.expectRefused(
      t.admin.id,
      "roles.reset",
      { params: { roleId: "admin" } },
      rule("roles.reset")
    );
    await t.expectRefused(
      t.admin.id,
      "roles.pending.decide",
      { params: { roleId: "admin" }, payload: { action: "usage.view", decision: "apply" } },
      rule("roles.pending.decide")
    );
    expect((await role(t, "user")).equalsDefault).toBe(true);
    const runs = await withTestSql(
      (sql) =>
        sql`select operation, status from operation_runs where operation like 'roles.%' order by operation`
    );
    expect(runs).toEqual([
      { operation: "roles.pending.decide", status: "denied" },
      { operation: "roles.reset", status: "denied" },
      { operation: "roles.update", status: "denied" }
    ]);
    const denied = await auditOf(t, "operation.denied");
    expect(denied.map((event) => event.metadata?.operation).sort()).toEqual([
      "roles.pending.decide",
      "roles.reset",
      "roles.update"
    ]);
  });

  it("refuses an admin a custom role that carries a superadmin's right, and its assignment", async () => {
    const t = await setup();
    const keys = { name: "Keys", grants: [instanceAllow("api_access.manage")] };
    await t.expectRefused(
      t.admin.id,
      "roles.create",
      { payload: keys },
      {
        status: 403,
        code: "FORBIDDEN",
        details: { action: "roles.create", reason: "no_grant" }
      }
    );
    const created = roleSchema.parse(
      (await t.expectOk(t.root.id, "roles.create", { payload: keys })).json()
    );
    await t.expectRefused(
      t.admin.id,
      "users.update",
      { params: { userId: t.kai.id }, payload: { roles: ["user", created.id] } },
      { status: 403, code: "FORBIDDEN", details: { action: "users.update", reason: "no_grant" } }
    );
    await t.expectOk(t.root.id, "users.update", {
      params: { userId: t.kai.id },
      payload: { roles: ["user", created.id] }
    });
  });
});

describe("custom roles", () => {
  it("grants what the role lists and nothing more", async () => {
    const t = await setup();
    await t.putAgent(t.admin.id, "listed");
    await t.putAgent(t.admin.id, "other");
    const listed = await t.assetId("agent", "listed");
    const created = roleSchema.parse(
      (
        await t.expectOk(t.admin.id, "roles.create", {
          payload: {
            name: "Buchhaltung",
            description: "Reads one agent and the usage",
            grants: [
              { action: "agent.read", scopeKind: "asset", scopeId: listed },
              instanceAllow("usage.view")
            ]
          }
        })
      ).json()
    );
    await t.expectOk(t.admin.id, "users.update", {
      params: { userId: t.kai.id },
      payload: { roles: ["user", created.id] }
    });

    await t.expectOk(t.kai.id, "assets.get", { params: { kind: "agent", name: "listed" } });
    await t.expectOk(t.kai.id, "usage.get_summary");
    await t.expectRefused(
      t.kai.id,
      "assets.get",
      { params: { kind: "agent", name: "other" } },
      t.forbidden("agent.read", "no_grant")
    );
    await t.expectRefused(t.kai.id, "audit_events.list", {}, t.forbidden("audit.view", "no_grant"));
    const effective = effectiveSchema.parse(
      (
        await t.expectOk(t.admin.id, "permissions.effective", {
          query: { holderKind: "user", holderId: t.kai.id }
        })
      ).json()
    );
    expect(
      effective.items
        .filter((entry) => entry.source === "role")
        .map((entry) => entry.action)
        .sort()
    ).toEqual(["agent.read", "usage.view"]);
    expect(
      effective.items
        .filter((entry) => entry.source === "role")
        .every((entry) => entry.roleId === created.id)
    ).toBe(true);

    // A role a person holds is not deleted from under them; taken from them, it goes.
    await t.expectRefused(
      t.admin.id,
      "roles.delete",
      { params: { roleId: created.id } },
      {
        status: 409,
        code: "CONFLICT",
        details: { reason: "role_in_use" }
      }
    );
    await t.expectOk(t.admin.id, "users.update", {
      params: { userId: t.kai.id },
      payload: { roles: ["user"] }
    });
    await t.expectOk(t.admin.id, "roles.delete", { params: { roleId: created.id } });
    await t.expectRefused(t.kai.id, "usage.get_summary", {}, t.forbidden("usage.view", "no_grant"));
    expect((await auditOf(t, "role.deleted")).map((event) => event.metadata?.roleId)).toEqual([
      created.id
    ]);
  });

  it("keeps role rows off the grant operations: a role is changed on the role", async () => {
    const t = await setup();
    const created = roleSchema.parse(
      (
        await t.expectOk(t.admin.id, "roles.create", {
          payload: { name: "Readers", grants: [instanceAllow("workflow.read")] }
        })
      ).json()
    );
    const listed = z.object({ items: z.array(z.object({ id: z.string() }).loose()) }).parse(
      (
        await t.expectOk(t.admin.id, "permissions.list", {
          query: { holderKind: "role", holderId: created.id }
        })
      ).json()
    );
    const invalidScope = {
      status: 422,
      code: "VALIDATION_FAILED",
      details: { reason: "invalid_scope" }
    };
    expect(listed.items).toHaveLength(1);
    await t.expectRefused(
      t.admin.id,
      "permissions.revoke",
      { params: { grantId: listed.items[0]?.id ?? "" } },
      invalidScope
    );
    await t.expectRefused(
      t.admin.id,
      "permissions.grant",
      {
        payload: {
          holderKind: "role",
          holderId: created.id,
          action: "audit.view",
          scopeKind: "instance"
        }
      },
      invalidScope
    );
    expect((await role(t, created.id)).grants).toEqual([instanceAllow("workflow.read")]);
  });

  it("refuses a role the instance does not have and a built-in role's name", async () => {
    const t = await setup();
    await t.expectRefused(
      t.admin.id,
      "users.update",
      { params: { userId: t.kai.id }, payload: { roles: ["user", "auditor"] } },
      { status: 422, code: "VALIDATION_FAILED", details: { reason: "unknown_role" } }
    );
    await t.expectRefused(
      t.admin.id,
      "roles.create",
      { payload: { name: "Admin", grants: [] } },
      { status: 409, code: "CONFLICT", details: { reason: "role_name_taken" } }
    );
  });
});

describe("a release that changes a default", () => {
  it("leaves an edited admin as it is with the new action pending, and moves an unedited one", async () => {
    const t = await setup();
    // As an older release left them: its default of `admin` had no `usage.view`, its `user`
    // held it. A superadmin narrowed `admin` further; `user` still equals that default.
    const older = ROLE_DEFAULT_ACTIONS.admin.filter((action) => action !== "usage.view");
    const edited = older.filter((action) => action !== "audit.view");
    await t.expectOk(t.root.id, "roles.update", {
      params: { roleId: "admin" },
      payload: { grants: edited.map(instanceAllow) }
    });
    await t.expectOk(t.root.id, "roles.update", {
      params: { roleId: "user" },
      payload: { grants: [instanceAllow("usage.view")] }
    });
    await withTestSql(async (sql) => {
      await sql`update roles set default_actions = ${JSON.stringify(older)}::text::jsonb where id = 'admin'`;
      await sql`update roles set default_actions = '["usage.view"]'::jsonb where id = 'user'`;
    });

    await migrateDatabase({ databaseUrl: await fileTestDatabaseUrl(), log: () => {} });

    const admin = await role(t, "admin");
    expect(admin.grants.map((grant) => grant.action).sort()).toEqual([...edited].sort());
    expect(admin.pendingActions).toEqual([{ action: "usage.view", change: "added" }]);
    await t.expectRefused(
      t.admin.id,
      "usage.get_summary",
      {},
      t.forbidden("usage.view", "no_grant")
    );
    await t.expectOk(t.root.id, "usage.get_summary");
    // `user` took the release's default, which no longer holds `usage.view`.
    expect(await role(t, "user")).toMatchObject({ grants: [], equalsDefault: true });
    await t.expectRefused(t.kai.id, "usage.get_summary", {}, t.forbidden("usage.view", "no_grant"));
    const reconciled = await auditOf(t, "role.reconciled");
    expect(
      reconciled
        .map((event) => event.metadata ?? {})
        .sort((a, b) => String(a.roleId).localeCompare(String(b.roleId)))
    ).toEqual([
      { roleId: "admin", edited: true, added: ["usage.view"], removed: [] },
      { roleId: "user", edited: false, added: [], removed: ["usage.view"] }
    ]);

    // A second run of the step finds nothing to change.
    await migrateDatabase({ databaseUrl: await fileTestDatabaseUrl(), log: () => {} });
    expect(await auditOf(t, "role.reconciled")).toHaveLength(2);

    await t.expectOk(t.root.id, "roles.pending.decide", {
      params: { roleId: "admin" },
      payload: { action: "usage.view", decision: "apply" }
    });
    expect((await role(t, "admin")).pendingActions).toEqual([]);
    await t.expectOk(t.admin.id, "usage.get_summary");
  });
});

describe("the last superadmin", () => {
  it("is never demoted or deactivated through the API", async () => {
    const t = await setup();
    const last = { status: 422, code: "VALIDATION_FAILED", details: { reason: "last_superadmin" } };
    await t.expectRefused(
      t.root.id,
      "users.update",
      { params: { userId: t.root.id }, payload: { roles: ["user", "admin"] } },
      last
    );
    await t.expectRefused(
      t.root.id,
      "users.update",
      { params: { userId: t.root.id }, payload: { status: "disabled" } },
      last
    );
    // With a second one, either may go.
    await t.expectOk(t.root.id, "users.update", {
      params: { userId: t.admin.id },
      payload: { roles: ["user", "admin", "superadmin"] }
    });
    await t.expectOk(t.root.id, "users.update", {
      params: { userId: t.root.id },
      payload: { roles: ["user", "admin"] }
    });
  });

  it("is never demoted through the CLI", async () => {
    // The CLI reaches user administration only with a personal key, and no key carries
    // `users.manage` or its scope: the call is refused before the operation, and the role stays. A key that
    // did reach it would run the same operation, and so the same check, as the API does.
    const t = await setupPersonalKeyInstance();
    instances.push(t);
    const issued = await t.issue(["agent.read"], t.root.id);
    const cwd = await mkdtemp(join(tmpdir(), "roles-cli-"));
    directories.push(cwd);
    const err: string[] = [];
    const code = await runCli(["call", "users.update", "--instance", "https://catalyst.test"], {
      cwd,
      env: { CATALYST_API_KEY: issued.secret },
      fetchImpl: createTestFetch(t.instance),
      stdin: Readable.from([
        JSON.stringify({ params: { userId: t.root.id }, body: { roles: ["user", "admin"] } })
      ]),
      stdout: () => {},
      stderr: (text) => err.push(text)
    });
    expect(code).not.toBe(0);
    expect(err.join("")).toContain("Missing auth scope 'user_admin:write'");
    const [stored] = await withTestSql(
      (sql) => sql`select roles from product_users where id = ${t.root.id}`
    );
    expect(stored?.roles).toContain("superadmin");
  });
});
