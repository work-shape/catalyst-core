import postgres from "postgres";
import { z } from "zod";
import { describe, expect, inject, it } from "vitest";
import {
  ApiKeyAccessTokenExchange,
  HmacServiceAccessTokenAuthAdapter
} from "@work-shape/catalyst-auth";
import {
  LEGACY_LIST_GRANTOR,
  PERMISSIONS,
  accessHolderFromIdentity,
  asApiCredentialId,
  asClientInstanceId,
  asServicePrincipalId,
  asUserId,
  createAuthorizer,
  evaluateAccess,
  hasPermission,
  legacyGrantRows,
  type AuthenticatedServicePrincipal,
  type PermissionGrant
} from "@work-shape/catalyst-core";
import { migrateDatabase } from "@work-shape/catalyst-postgres-store";
import {
  LEGACY_KEYS,
  frozenCredentialPermissions,
  frozenHasPermission
} from "../scripts/verify-permissions";
import { migrationsUntil } from "./support/migrations-until";
import { PostgresFixtures } from "./support/postgres-fixtures";
import { fileTestDatabaseUrl } from "./support/test-database";
import { createTestInstance } from "./support/test-instance";
import {
  clientInstanceId as accessClientInstanceId,
  setupAccessInstance
} from "./support/access-instance";

// The rule of the evaluator and of AP-4: no holder gains or loses a right. The frozen copy in
// `scripts/verify-permissions.ts` is what decided rights before the evaluator. Since AP-4 a
// legacy list is the holder's instance-wide grant rows; `access-legacy-migration.test.ts`
// proves the migration and the verification script over a database.

const secret = "a-test-service-access-token-secret-with-enough-length";
const clientInstanceId = asClientInstanceId("legacy-equivalence-test");

const principalStates = {
  none: [],
  read: ["config_assets.read"],
  release: ["config_assets.release"],
  both: ["config_assets.read", "config_assets.release"]
} as const;

const credentialStates: Record<string, string[] | undefined> = {
  "no restriction": undefined,
  "an empty list": [],
  read: ["config_assets:read"],
  release: ["config_assets:release"],
  both: ["config_assets:read", "config_assets:release"],
  "the permission-name form": ["config_assets.read", "config_assets.release"],
  "a scope no principal can hold": ["config_assets:write"],
  // Before AP-4 `*` gave nothing; the migration took it out of every list and gave `["*"]` to
  // each credential without one, so from AP-4 it means no restriction.
  "the wildcard": ["*"]
};

/** The keys a credential's token carried before AP-4, for a list as it is written today. */
function credentialKeysBefore(principalPermissions: string[], scopes: string[] | undefined) {
  return frozenCredentialPermissions({
    principalPermissions,
    credentialScopes: scopes?.includes("*") ? undefined : scopes
  });
}

describe("legacy equivalence: service tokens", () => {
  it("keeps the frozen key list equal to the product's", () => {
    expect([...LEGACY_KEYS]).toEqual([...PERMISSIONS]);
  });

  it.each(Object.entries(principalStates))(
    "answers every legacy key as before for a principal holding %s",
    async (principalState, held) => {
      const principalPermissions = [...held];
      const { stores } = await createTestInstance();
      const options = { secret, clientInstanceId, apiAccessStore: stores.apiAccess };
      const exchange = new ApiKeyAccessTokenExchange(options);
      const adapter = new HmacServiceAccessTokenAuthAdapter(options);
      const authorizer = createAuthorizer(stores.access);
      const servicePrincipal = await stores.apiAccess.createServicePrincipal({
        clientInstanceId,
        displayLabel: `Principal ${principalState}`,
        permissions: principalPermissions
      });

      for (const [credentialState, scopes] of Object.entries(credentialStates)) {
        const created = await stores.apiAccess.createApiCredential({
          clientInstanceId,
          servicePrincipalId: servicePrincipal.id,
          name: credentialState,
          scopes
        });
        const issued = await exchange.exchange(created.secret);
        const verified = await adapter.authenticate({
          headers: { authorization: `Bearer ${issued.accessToken}` },
          clientInstanceId,
          correlationId: "corr_legacy_equivalence"
        });
        const expectedKeys = credentialKeysBefore(principalPermissions, scopes);
        // The actor at the exchange and the actor a later request presents hold the same keys.
        expect(issued.identity.permissions, credentialState).toEqual(expectedKeys);
        expect(verified.permissions, credentialState).toEqual(expectedKeys);

        for (const actor of [issued.identity, verified]) {
          // The credential's scopes cap the principal's rows: the evaluator answers what the
          // token held before AP-4, without a route's scope check in front of it.
          const access = await authorizer.forActor(actor);
          for (const key of LEGACY_KEYS) {
            const before = frozenHasPermission({ permissions: actor.permissions }, key);
            expect(hasPermission(actor, key), `${credentialState} ${key} product copy`).toBe(
              before
            );
            expect(access.authorize(key).allowed, `${credentialState} ${key}`).toBe(before);
            // A credential can only narrow what its principal holds.
            if (before) expect(principalPermissions).toContain(key);
          }
        }
      }
    }
  );

  it("gives a credential with an empty list nothing and one without a restriction all of the principal's", async () => {
    expect(
      frozenCredentialPermissions({
        principalPermissions: principalStates.both,
        credentialScopes: []
      })
    ).toEqual([]);
    expect(
      frozenCredentialPermissions({
        principalPermissions: principalStates.both,
        credentialScopes: undefined
      })
    ).toEqual(["config_assets.read", "config_assets.release"]);
    expect(
      frozenCredentialPermissions({
        principalPermissions: principalStates.read,
        credentialScopes: ["config_assets:release"]
      })
    ).toEqual([]);
  });
});

describe("legacy equivalence: users", () => {
  const roleSets = [
    [],
    ["user"],
    ["user", "admin"],
    ["user", "admin", "superadmin"],
    ["superadmin"],
    ["owner"]
  ];
  const columns = [
    [],
    ["usage.view"],
    ["config_assets.release"],
    ["!users.manage"],
    ["users.manage", "!users.manage"],
    ["!config_assets.write", "config_assets.read"],
    ["api_access.manage", "agent_models.manage", "nonsense", "!nonsense"],
    [...PERMISSIONS],
    PERMISSIONS.map((permission) => `!${permission}`)
  ];

  it("answers every legacy key as before for every role set and column, from the rows the column became", () => {
    for (const roles of roleSets) {
      for (const permissions of columns) {
        const holder = accessHolderFromIdentity({
          id: "usr_equivalence",
          externalUserId: "equivalence",
          displayLabel: "Equivalence",
          roles,
          permissionRefs: [],
          clientInstanceId,
          authSource: "test"
        });
        const grants: PermissionGrant[] = legacyGrantRows(permissions).map((row, index) => ({
          id: `grant_${index}`,
          clientInstanceId,
          holderKind: "user",
          holderId: "usr_equivalence",
          action: row.action,
          effect: row.effect,
          scopeKind: "instance",
          grantedBy: asUserId(LEGACY_LIST_GRANTOR),
          createdAt: "2026-10-14T00:00:00.000Z"
        }));
        for (const key of LEGACY_KEYS) {
          const decision = evaluateAccess({
            holder,
            persisted: { holderActive: true, grants },
            action: key
          });
          expect(decision.allowed, `${roles.join("+")} [${permissions.join(",")}] ${key}`).toBe(
            frozenHasPermission({ roles, permissions }, key)
          );
        }
      }
    }
  });
});

describe("legacy equivalence: the lists the Users and API access screens write", () => {
  async function rowsOf(holderId: string) {
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice() {} });
    try {
      return await sql<
        { id: string; action: string; effect: string; scope_kind: string; granted_by: string }[]
      >`
        select id, action, effect, scope_kind, granted_by from permission_grants
        where holder_id = ${holderId} order by action`;
    } finally {
      await sql.end();
    }
  }

  async function columnOf(table: "product_users" | "service_principals", id: string) {
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice() {} });
    try {
      const [row] = await sql<{ permissions: string[] }[]>`
        select permissions from ${sql(table)} where id = ${id}`;
      return row?.permissions;
    } finally {
      await sql.end();
    }
  }

  it("writes a user's list as rows, reads it back from them and leaves the column alone", async () => {
    const { stores } = await createTestInstance();
    const created = await stores.users.createUser({
      clientInstanceId,
      displayLabel: "Listed",
      roles: ["user"],
      permissions: ["!usage.view", "nonsense", "config_assets.release"],
      permissionRefs: [],
      grantedBy: asUserId("usr_boss")
    });
    // The rows in the order of the keys; an entry that is no key is no right.
    expect(created.permissions).toEqual(["config_assets.release", "!usage.view"]);
    expect(await rowsOf(created.id)).toEqual([
      expect.objectContaining({
        action: "assets.release",
        effect: "allow",
        granted_by: "usr_boss"
      }),
      expect.objectContaining({ action: "usage.view", effect: "deny", granted_by: "usr_boss" })
    ]);
    expect(await columnOf("product_users", created.id)).toEqual([]);
    const [kept] = await rowsOf(created.id);

    const updated = await stores.users.updateUser({
      clientInstanceId,
      userId: created.id,
      permissions: ["config_assets.release", "audit.view"],
      grantedBy: asUserId("usr_other")
    });
    expect(updated.permissions).toEqual(["config_assets.release", "audit.view"]);
    // An unchanged key keeps its row, and who wrote it.
    expect(await rowsOf(created.id)).toEqual([
      kept,
      expect.objectContaining({ action: "audit.view", effect: "allow", granted_by: "usr_other" })
    ]);
    expect(
      (await stores.users.getUser({ clientInstanceId, userId: created.id }))?.permissions
    ).toEqual(["config_assets.release", "audit.view"]);
    expect(
      (await stores.users.listUsers({ clientInstanceId })).find((user) => user.id === created.id)
        ?.permissions
    ).toEqual(["config_assets.release", "audit.view"]);

    // Without a grantor the rows say they came from a list.
    const seeded = await stores.users.createUser({
      clientInstanceId,
      displayLabel: "Seeded",
      roles: ["user"],
      permissions: ["usage.view"],
      permissionRefs: []
    });
    expect(await rowsOf(seeded.id)).toEqual([
      expect.objectContaining({ action: "usage.view", granted_by: LEGACY_LIST_GRANTOR })
    ]);
  });

  it("keeps a row the list cannot show until the list names its key", async () => {
    const { stores } = await createTestInstance();
    const user = await stores.users.createUser({
      clientInstanceId,
      displayLabel: "Narrowed",
      roles: ["user", "admin"],
      permissions: [],
      permissionRefs: []
    });
    await stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: user.id,
      action: "skill.write",
      effect: "deny",
      scopeKind: "instance",
      grantedBy: asUserId("usr_boss")
    });
    expect(
      (await stores.users.getUser({ clientInstanceId, userId: user.id }))?.permissions
    ).toEqual([]);
    await stores.users.updateUser({
      clientInstanceId,
      userId: user.id,
      permissions: ["usage.view"],
      grantedBy: asUserId("usr_other")
    });
    expect((await rowsOf(user.id)).map((row) => [row.action, row.effect])).toEqual([
      ["skill.write", "deny"],
      ["usage.view", "allow"]
    ]);
    await stores.users.updateUser({
      clientInstanceId,
      userId: user.id,
      permissions: ["usage.view", "!config_assets.write"],
      grantedBy: asUserId("usr_other")
    });
    expect((await rowsOf(user.id)).map((row) => [row.action, row.effect, row.granted_by])).toEqual([
      ["agent.delete", "deny", "usr_other"],
      ["agent.write", "deny", "usr_other"],
      ["skill.delete", "deny", "usr_other"],
      ["skill.write", "deny", "usr_other"],
      ["usage.view", "allow", "usr_other"]
    ]);
  });

  it("writes a service principal's list as rows granted by whoever created or changed it", async () => {
    const { stores } = await createTestInstance();
    const creator = await stores.users.createUser({
      clientInstanceId,
      displayLabel: "Creator",
      roles: ["user", "admin", "superadmin"],
      permissions: [],
      permissionRefs: []
    });
    const principal = await stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      displayLabel: "Release bot",
      permissions: ["config_assets.read"],
      createdByUserId: creator.id
    });
    expect(principal.permissions).toEqual(["config_assets.read"]);
    expect((await rowsOf(principal.id)).map((row) => [row.action, row.granted_by])).toEqual([
      ["agent.read", creator.id],
      ["skill.read", creator.id]
    ]);
    const updated = await stores.apiAccess.updateServicePrincipal({
      clientInstanceId,
      servicePrincipalId: principal.id,
      permissions: ["config_assets.read", "config_assets.release"],
      grantedBy: asUserId("usr_other")
    });
    expect(updated.permissions).toEqual(["config_assets.read", "config_assets.release"]);
    expect((await rowsOf(principal.id)).map((row) => [row.action, row.granted_by])).toEqual([
      ["agent.read", creator.id],
      ["assets.release", "usr_other"],
      ["skill.read", creator.id]
    ]);
    expect(await columnOf("service_principals", principal.id)).toEqual([]);
  });

  it('stores `["*"]` for a credential created without a list and reads it as no restriction', async () => {
    const { stores } = await createTestInstance();
    const principal = await stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      displayLabel: "Unrestricted",
      permissions: ["config_assets.read"]
    });
    const created = await stores.apiAccess.createApiCredential({
      clientInstanceId,
      servicePrincipalId: principal.id,
      name: "unrestricted"
    });
    expect(created.credential.scopes).toBeUndefined();
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice() {} });
    try {
      expect(
        await sql`select scopes from api_credentials where id = ${created.credential.id}`
      ).toEqual([{ scopes: ["*"] }]);
    } finally {
      await sql.end();
    }
  });
});

describe("legacy equivalence: the Access page leaves a legacy list alone", () => {
  it("leaves out an instance-wide row of a legacy list and refuses to revoke it", async () => {
    const t = await setupAccessInstance();
    await t.stores.users.updateUser({
      clientInstanceId: accessClientInstanceId,
      userId: t.kai.id,
      permissions: ["usage.view"]
    });
    const [row] = await t.stores.access.listGrants({
      clientInstanceId: accessClientInstanceId,
      holderId: t.kai.id
    });
    expect(row).toMatchObject({ action: "usage.view", scopeKind: "instance" });
    const listed = z
      .object({ items: z.array(z.object({ id: z.string() }).loose()) })
      .parse((await t.expectOk(t.root.id, "permissions.list")).json());
    expect(listed.items).toEqual([]);
    const refusal = await t.expectRefused(
      t.root.id,
      "permissions.revoke",
      { params: { grantId: row?.id ?? "" } },
      { status: 422, code: "VALIDATION_FAILED", details: { reason: "invalid_scope" } }
    );
    expect(refusal.message).toBe(
      "An instance-wide right is changed on the page of the user or the service principal"
    );
    expect(await t.stores.access.listGrants({ clientInstanceId: accessClientInstanceId })).toEqual([
      row
    ]);
  });
});

describe("legacy equivalence: the AP-1 migration", () => {
  it("leaves every user, service principal and credential row as it was", async () => {
    const fixtures = new PostgresFixtures(inject("postgresFixturePrefix"));
    const databaseUrl = await fixtures.database("legacy-equivalence:migration", false);
    const before = migrationsUntil({ name: "access_grants_namespaces", including: false });
    const through = migrationsUntil({ name: "access_grants_namespaces", including: true });
    const sql = postgres(databaseUrl, { max: 1, onnotice() {} });
    try {
      await migrateDatabase({ databaseUrl, migrationsDirectory: before.directory });
      await sql`
        insert into product_users (id, client_instance_id, display_label, roles, permission_refs, permissions, status, created_at, updated_at)
        values
          ('usr_admin', 'migration-test', 'Admin', '["user","admin"]'::jsonb, '["demo-tools"]'::jsonb, '["!usage.view"]'::jsonb, 'active', now(), now()),
          ('usr_plain', 'migration-test', 'Plain', '["user"]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'disabled', now(), now())
      `;
      await sql`
        insert into service_principals (id, client_instance_id, display_label, status, permission_refs, permissions, created_at, updated_at)
        values ('sp_cli', 'migration-test', 'CLI', 'active', '[]'::jsonb, '["config_assets.read","config_assets.release"]'::jsonb, now(), now())
      `;
      await sql`
        insert into api_credentials (id, client_instance_id, service_principal_id, name, key_prefix, secret_hash, scopes, created_at)
        values
          ('cred_scoped', 'migration-test', 'sp_cli', 'scoped', 'prefix-1', 'hash-1', '["config_assets:read"]'::jsonb, now()),
          ('cred_empty', 'migration-test', 'sp_cli', 'empty', 'prefix-2', 'hash-2', '[]'::jsonb, now()),
          ('cred_unscoped', 'migration-test', 'sp_cli', 'unscoped', 'prefix-3', 'hash-3', null, now())
      `;
      const read = async () => ({
        users:
          await sql`select id, roles, permissions, permission_refs, status from product_users order by id`,
        principals:
          await sql`select id, permissions, permission_refs, status from service_principals order by id`,
        credentials: await sql`select id, scopes from api_credentials order by id`
      });
      const rowsBefore = await read();
      expect(rowsBefore.credentials).toEqual([
        { id: "cred_empty", scopes: [] },
        { id: "cred_scoped", scopes: ["config_assets:read"] },
        { id: "cred_unscoped", scopes: null }
      ]);

      // Up to and with the access migration: AP-4 later turns the lists into rows.
      const applied = await migrateDatabase({
        databaseUrl,
        migrationsDirectory: through.directory
      });
      expect(applied).toEqual([before.tag]);
      expect(await read()).toEqual(rowsBefore);

      // The migration writes no row: nobody holds a grant or a Namespace through it.
      const [grants] = await sql`select count(*)::int as count from permission_grants`;
      const [registered] = await sql`select count(*)::int as count from namespaces`;
      expect(grants).toEqual({ count: 0 });
      expect(registered).toEqual({ count: 0 });
    } finally {
      await sql.end();
      await fixtures.drop(databaseUrl);
      before.remove();
      through.remove();
    }
  });
});

// A service actor is never read as a person: it has no role, whatever its record says.
describe("legacy equivalence: a service actor has no role", () => {
  it("answers nothing from role defaults for a service principal", () => {
    const actor: AuthenticatedServicePrincipal & { roles: string[] } = {
      kind: "service",
      id: asServicePrincipalId("sp_roles"),
      credentialId: asApiCredentialId("cred_roles"),
      displayLabel: "Service",
      permissionRefs: [],
      permissions: [],
      clientInstanceId,
      authSource: "test",
      scopes: [],
      roles: ["user", "admin", "superadmin"]
    };
    const holder = accessHolderFromIdentity(actor);
    expect(holder.roles).toEqual([]);
    for (const key of LEGACY_KEYS) {
      expect(
        evaluateAccess({
          holder,
          persisted: { holderActive: true, grants: [] },
          action: key
        }).allowed
      ).toBe(false);
    }
  });
});
