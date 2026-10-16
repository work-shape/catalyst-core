import postgres, { type Sql } from "postgres";
import { afterEach, describe, expect, inject, it } from "vitest";
import {
  ApiKeyAccessTokenExchange,
  HmacServiceAccessTokenAuthAdapter
} from "@work-shape/catalyst-auth";
import {
  LEGACY_PERMISSION_ACTIONS,
  PERMISSIONS,
  asApiCredentialId,
  asClientInstanceId,
  asServicePrincipalId,
  asUserId,
  createAuthorizer,
  type AuthenticatedIdentity,
  type PermissionGrant
} from "@work-shape/catalyst-core";
import { migrateDatabase, type PostgresStores } from "@work-shape/catalyst-postgres-store";
import { restoreLegacyColumns } from "../scripts/verify-permissions";
import * as pre from "./support/ap4-verify/pre-ap4-permissions";
import { migrationsUntil } from "./support/migrations-until";
import { PostgresFixtures } from "./support/postgres-fixtures";
import { storesOn } from "./support/upgrade-database";

// AP-4 verifier, second round (PR 50 at 41173b8d).

const fixtures = new PostgresFixtures(inject("postgresFixturePrefix"));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const instance = "ap4-r2";
const clientInstanceId = asClientInstanceId(instance);
const LEGACY_ACTIONS = PERMISSIONS.flatMap((key) => [...LEGACY_PERMISSION_ACTIONS[key]]);
const QUESTIONS = [...PERMISSIONS, ...LEGACY_ACTIONS];

async function databaseBeforeAp4() {
  const databaseUrl = await fixtures.database(`ap4-r2:${crypto.randomUUID()}`, false);
  const before = migrationsUntil({ name: "legacy_permission_grants", including: false });
  const sql = postgres(databaseUrl, { max: 1, onnotice() {} });
  cleanups.push(() => fixtures.drop(databaseUrl));
  cleanups.push(() => sql.end());
  cleanups.push(() => before.remove());
  await migrateDatabase({ databaseUrl, migrationsDirectory: before.directory });
  return { databaseUrl, sql, migrationTag: before.tag };
}

async function seedUser(sql: Sql, id: string, permissions: string[]) {
  await sql`
    insert into product_users (id, client_instance_id, display_label, roles, permission_refs,
      permissions, status, created_at, updated_at)
    values (${id}, ${instance}, ${id}, '["user"]'::jsonb, '[]'::jsonb,
      ${JSON.stringify(permissions)}::text::jsonb, 'active', now(), now())`;
}

async function seedPrincipal(sql: Sql, id: string, permissions: string[]) {
  await sql`
    insert into service_principals (id, client_instance_id, name, display_label, status,
      permission_refs, permissions, created_at, updated_at)
    values (${id}, ${instance}, ${id}, ${id}, 'active', '[]'::jsonb,
      ${JSON.stringify(permissions)}::text::jsonb, now(), now())`;
}

/** The answers of the release before AP-4: column and every row of the holder. */
async function oldAnswers(sql: Sql, kind: "user" | "service_principal", id: string) {
  const table = kind === "user" ? "product_users" : "service_principals";
  const [holder] = await sql<{ permissions: string[] }[]>`
    select permissions from ${sql(table)} where id = ${id}`;
  const rows = await sql<
    {
      id: string;
      action: string;
      effect: PermissionGrant["effect"];
      scope_kind: PermissionGrant["scopeKind"];
    }[]
  >`select id, action, effect, scope_kind from permission_grants
    where holder_kind = ${kind} and holder_id = ${id}`;
  const access = pre.createActorAccess(
    {
      kind,
      id,
      clientInstanceId,
      roles: kind === "user" ? ["user"] : [],
      permissions: holder?.permissions ?? [],
      permissionRefs: []
    },
    {
      holderActive: true,
      grants: rows.map((row) => ({
        id: row.id,
        clientInstanceId,
        holderKind: kind,
        holderId: id,
        action: row.action,
        effect: row.effect,
        scopeKind: row.scope_kind,
        grantedBy: asUserId("x"),
        createdAt: "2026-10-14T00:00:00.000Z"
      })),
      memberWorkspaceIds: []
    }
  );
  return Object.fromEntries(QUESTIONS.map((q) => [q, access.authorize(q).allowed]));
}

/** The answers of this release: rows only. A principal is asked with every key carried. */
async function newAnswers(stores: PostgresStores, kind: "user" | "service_principal", id: string) {
  const actor: AuthenticatedIdentity =
    kind === "user"
      ? {
          id,
          externalUserId: id,
          displayLabel: id,
          roles: ["user"],
          permissionRefs: [],
          permissions: [],
          clientInstanceId,
          authSource: "ap4-r2"
        }
      : {
          kind: "service",
          id: asServicePrincipalId(id),
          credentialId: asApiCredentialId("probe"),
          displayLabel: id,
          permissionRefs: [],
          permissions: [...PERMISSIONS],
          clientInstanceId,
          authSource: "ap4-r2",
          scopes: []
        };
  const access = await createAuthorizer(stores.access).forActor(actor);
  return Object.fromEntries(QUESTIONS.map((q) => [q, access.authorize(q).allowed]));
}

describe("AP-4 r2: rollback round trip with edits on both releases", () => {
  it("keeps every right through upgrade, edit, restore, edit, upgrade", async () => {
    const { databaseUrl, sql, migrationTag } = await databaseBeforeAp4();
    await seedUser(sql, "usr_a", ["config_assets.read", "users.manage"]);
    await seedUser(sql, "usr_b", ["!audit.view", "usage.view"]);
    await seedPrincipal(sql, "sp_a", ["config_assets.read", "config_assets.release"]);

    // AP-4's migration among them: a later migration of main is applied with it.
    expect(await migrateDatabase({ databaseUrl })).toContain(migrationTag);
    let stores = await storesOn(databaseUrl);
    // Edits on the new release, through the product's stores.
    await stores.users.updateUser({
      clientInstanceId,
      userId: asUserId("usr_a"),
      permissions: ["config_assets.read", "audit.view"],
      grantedBy: asUserId("usr_boss")
    });
    await stores.users.updateUser({
      clientInstanceId,
      userId: asUserId("usr_b"),
      permissions: ["usage.view"],
      grantedBy: asUserId("usr_boss")
    });
    await stores.apiAccess.updateServicePrincipal({
      clientInstanceId,
      servicePrincipalId: asServicePrincipalId("sp_a"),
      permissions: ["config_assets.release", "!config_assets.write"]
    });
    const onNew = {
      usr_a: await newAnswers(stores, "user", "usr_a"),
      usr_b: await newAnswers(stores, "user", "usr_b"),
      sp_a: await newAnswers(stores, "service_principal", "sp_a")
    };
    await stores.close();

    await restoreLegacyColumns({ sql, write: () => undefined });
    // The old release answers what the new one answered before the rollback.
    expect({
      usr_a: await oldAnswers(sql, "user", "usr_a"),
      usr_b: await oldAnswers(sql, "user", "usr_b"),
      sp_a: await oldAnswers(sql, "service_principal", "sp_a")
    }).toEqual(onNew);

    // Edits on the old release: a removal, a revocation removed, a key added.
    await sql`update product_users set permissions = '["audit.view"]'::jsonb where id = 'usr_a'`;
    await sql`update product_users set permissions = '["!usage.view"]'::jsonb where id = 'usr_b'`;
    await sql`update service_principals set permissions = '["config_assets.read"]'::jsonb where id = 'sp_a'`;
    const onOld = {
      usr_a: await oldAnswers(sql, "user", "usr_a"),
      usr_b: await oldAnswers(sql, "user", "usr_b"),
      sp_a: await oldAnswers(sql, "service_principal", "sp_a")
    };

    // All later migrations already ran; only the restored lists must be replayed.
    expect(await migrateDatabase({ databaseUrl })).toEqual([migrationTag]);
    stores = await storesOn(databaseUrl);
    cleanups.push(() => stores.close());
    expect({
      usr_a: await newAnswers(stores, "user", "usr_a"),
      usr_b: await newAnswers(stores, "user", "usr_b"),
      sp_a: await newAnswers(stores, "service_principal", "sp_a")
    }).toEqual(onOld);
  });
});

describe("AP-4 r2: the token a request carries", () => {
  // Before AP-4 the request path (`HmacServiceAccessTokenAuthAdapter.authenticate`) set the
  // actor's keys to `permissionForAuthScope(scope)`, the first key of a scope: `governance:read`
  // gave `usage.view`, whatever the principal held. The evaluator read only those keys.
  it("a principal with only audit.view keeps what its key could do before AP-4", async () => {
    const { databaseUrl, sql } = await databaseBeforeAp4();
    await seedPrincipal(sql, "sp_audit", ["audit.view"]);
    await migrateDatabase({ databaseUrl });
    const stores = await storesOn(databaseUrl);
    cleanups.push(() => stores.close());
    const created = await stores.apiAccess.createApiCredential({
      clientInstanceId,
      servicePrincipalId: asServicePrincipalId("sp_audit"),
      name: "key"
    });
    const options = {
      secret: "x".repeat(40),
      clientInstanceId,
      apiAccessStore: stores.apiAccess
    };
    const issued = await new ApiKeyAccessTokenExchange(options).exchange(created.secret);
    const requestActor = await new HmacServiceAccessTokenAuthAdapter(options).authenticate({
      headers: { authorization: `Bearer ${issued.accessToken}` },
      clientInstanceId,
      correlationId: "probe"
    });
    const access = await createAuthorizer(stores.access).forActor(requestActor);
    const atRequest = {
      "usage.view": access.authorize("usage.view").allowed,
      "audit.view": access.authorize("audit.view").allowed
    };
    // What the release before AP-4 answered on the same request: actor keys ["usage.view"].
    const before = pre.createActorAccess(
      {
        kind: "service_principal",
        id: "sp_audit",
        clientInstanceId,
        roles: [],
        permissions: ["usage.view"],
        permissionRefs: []
      },
      { holderActive: true, grants: [], memberWorkspaceIds: [] }
    );
    expect(atRequest).toEqual({
      "usage.view": before.authorize("usage.view").allowed,
      "audit.view": before.authorize("audit.view").allowed
    });
  });

  it("the token the exchange describes is the token a request carries", async () => {
    const { databaseUrl, sql } = await databaseBeforeAp4();
    await seedPrincipal(sql, "sp_gov", ["usage.view", "audit.view"]);
    await migrateDatabase({ databaseUrl });
    const stores = await storesOn(databaseUrl);
    cleanups.push(() => stores.close());
    const created = await stores.apiAccess.createApiCredential({
      clientInstanceId,
      servicePrincipalId: asServicePrincipalId("sp_gov"),
      name: "key"
    });
    const options = { secret: "x".repeat(40), clientInstanceId, apiAccessStore: stores.apiAccess };
    const issued = await new ApiKeyAccessTokenExchange(options).exchange(created.secret);
    const requestActor = await new HmacServiceAccessTokenAuthAdapter(options).authenticate({
      headers: { authorization: `Bearer ${issued.accessToken}` },
      clientInstanceId,
      correlationId: "probe"
    });
    // verify-permissions and access-legacy-migration.test.ts model the exchange's token.
    expect(requestActor.permissions).toEqual(issued.identity.permissions);
  });
});
