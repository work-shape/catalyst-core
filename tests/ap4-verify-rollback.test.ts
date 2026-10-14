import postgres, { type Sql } from "postgres";
import { afterEach, describe, expect, inject, it } from "vitest";
import {
  asClientInstanceId,
  asUserId,
  createAuthorizer,
  type AuthenticatedIdentity,
  type PermissionGrant
} from "@vivd-catalyst/core";
import { migrateDatabase } from "@vivd-catalyst/postgres-store";
import { restoreLegacyColumns } from "../scripts/verify-permissions";
import * as pre from "./support/ap4-verify/pre-ap4-permissions";
import { migrationsUntil } from "./support/migrations-until";
import { PostgresFixtures } from "./support/postgres-fixtures";
import { storesOn } from "./support/upgrade-database";

// AP-4 verifier: the way back. `--restore-legacy-columns` writes the rows into the columns and
// the release before AP-4 starts. That release reads the column AND every grant row, so the rows
// migration 0073 wrote keep answering under it.

const fixtures = new PostgresFixtures(inject("postgresFixturePrefix"));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const instance = "ap4-rollback";
const clientInstanceId = asClientInstanceId(instance);

async function databaseBeforeAp4() {
  const databaseUrl = await fixtures.database(`ap4-rollback:${crypto.randomUUID()}`, false);
  const before = migrationsUntil({ name: "legacy_permission_grants", including: false });
  const sql = postgres(databaseUrl, { max: 1, onnotice() {} });
  cleanups.push(() => fixtures.drop(databaseUrl));
  cleanups.push(() => sql.end());
  cleanups.push(() => before.remove());
  await migrateDatabase({ databaseUrl, migrationsDirectory: before.directory });
  return { databaseUrl, sql };
}

async function seedUser(sql: Sql, id: string, permissions: string[]) {
  await sql`
    insert into product_users (id, client_instance_id, display_label, roles, permission_refs,
      permissions, status, created_at, updated_at)
    values (${id}, ${instance}, ${id}, '["user"]'::jsonb, '[]'::jsonb,
      ${JSON.stringify(permissions)}::text::jsonb, 'active', now(), now())`;
}

/** What the release before AP-4 decides for a user: its column, its roles and every row. */
async function preAp4Decision(sql: Sql, userId: string, action: string): Promise<boolean> {
  const [user] = await sql<{ roles: string[]; permissions: string[] }[]>`
    select roles, permissions from product_users where id = ${userId}`;
  const rows = await sql<
    {
      id: string;
      action: string;
      effect: PermissionGrant["effect"];
      scope_kind: PermissionGrant["scopeKind"];
    }[]
  >`select id, action, effect, scope_kind from permission_grants
    where holder_kind = 'user' and holder_id = ${userId}`;
  const access = pre.createActorAccess(
    {
      kind: "user",
      id: userId,
      clientInstanceId,
      roles: user?.roles ?? [],
      permissions: user?.permissions ?? [],
      permissionRefs: []
    },
    {
      holderActive: true,
      grants: rows.map((row) => ({
        id: row.id,
        clientInstanceId,
        holderKind: "user" as const,
        holderId: userId,
        action: row.action,
        effect: row.effect,
        scopeKind: row.scope_kind,
        grantedBy: asUserId("x"),
        createdAt: "2026-10-14T00:00:00.000Z"
      })),
      memberWorkspaceIds: []
    }
  );
  return access.authorize(action).allowed;
}

describe("AP-4 verifier: rollback", () => {
  it("a key the release before AP-4 takes away after the rollback is gone", async () => {
    const { databaseUrl, sql } = await databaseBeforeAp4();
    await seedUser(sql, "usr_manager", ["users.manage"]);
    expect(await preAp4Decision(sql, "usr_manager", "users.manage")).toBe(true);

    await migrateDatabase({ databaseUrl });
    const lines: string[] = [];
    await restoreLegacyColumns({ sql, write: (line) => lines.push(line) });
    // Restored, the old release answers what it answered before the migration.
    expect(await preAp4Decision(sql, "usr_manager", "users.manage")).toBe(true);

    // On the old release an admin unticks users.manage: the old store writes the column only.
    await sql`update product_users set permissions = '[]'::jsonb where id = 'usr_manager'`;

    // The old release still allows it: migration 0073's instance-wide rows are still there.
    expect(await preAp4Decision(sql, "usr_manager", "users.manage")).toBe(false);
  });

  it("restoring twice changes nothing the second time", async () => {
    const { databaseUrl, sql } = await databaseBeforeAp4();
    await seedUser(sql, "usr_a", ["users.manage", "!audit.view", "nonsense"]);
    await sql`
      insert into service_principals (id, client_instance_id, name, display_label, status,
        permission_refs, permissions, created_at, updated_at)
      values ('sp_a', ${instance}, 'sp_a', 'sp_a', 'active', '[]'::jsonb,
        '["config_assets.read"]'::jsonb, now(), now())`;
    await sql`
      insert into api_credentials (id, client_instance_id, service_principal_id, name,
        key_prefix, secret_hash, scopes, created_at)
      values ('cred_a', ${instance}, 'sp_a', 'cred_a', 'p', 'h', null, now())`;
    await migrateDatabase({ databaseUrl });
    const first = await restoreLegacyColumns({ sql, write: () => undefined });
    const second = await restoreLegacyColumns({ sql, write: () => undefined });
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
    const [credential] = await sql<{ scopes: unknown }[]>`select scopes from api_credentials`;
    expect(credential?.scopes).toBeNull();
  });

  it("a right changed on the old release after a rollback survives the next upgrade", async () => {
    const { databaseUrl, sql } = await databaseBeforeAp4();
    await seedUser(sql, "usr_manager", ["users.manage"]);
    await migrateDatabase({ databaseUrl });
    await restoreLegacyColumns({ sql, write: () => undefined });
    // On the old release: users.manage is taken away, audit.view is given.
    await sql`update product_users set permissions = '["audit.view"]'::jsonb where id = 'usr_manager'`;
    // Upgrade again: the restore left a marker, so the migrate step moves the lists again.
    expect(await migrateDatabase({ databaseUrl })).toEqual([
      expect.stringMatching(/_legacy_permission_grants$/u)
    ]);
    const stores = await storesOn(databaseUrl);
    cleanups.push(() => stores.close());
    const actor: AuthenticatedIdentity = {
      id: "usr_manager",
      externalUserId: "usr_manager",
      displayLabel: "usr_manager",
      roles: ["user"],
      permissionRefs: [],
      permissions: [],
      clientInstanceId,
      authSource: "ap4-verify"
    };
    const access = await createAuthorizer(stores.access).forActor(actor);
    expect({
      "users.manage": access.authorize("users.manage").allowed,
      "audit.view": access.authorize("audit.view").allowed
    }).toEqual({ "users.manage": false, "audit.view": true });
  });
});
