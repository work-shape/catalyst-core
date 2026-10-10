import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { describe, expect, inject, it } from "vitest";
import { ApiKeyAccessTokenExchange, HmacServiceAccessTokenAuthAdapter } from "@vivd-catalyst/auth";
import {
  PERMISSIONS,
  accessHolderFromIdentity,
  asApiCredentialId,
  asClientInstanceId,
  asServicePrincipalId,
  asUserId,
  createAuthorizer,
  evaluateAccess,
  hasPermission,
  type AuthenticatedServicePrincipal
} from "@vivd-catalyst/core";
import { migrateDatabase } from "@vivd-catalyst/postgres-store";
import {
  LEGACY_KEYS,
  frozenCredentialPermissions,
  frozenHasPermission,
  frozenLegacyFunctions,
  runVerifyPermissions
} from "../scripts/verify-permissions";
import { PostgresFixtures } from "./support/postgres-fixtures";
import { fileTestDatabaseUrl } from "./support/test-database";
import { createTestInstance } from "./support/test-instance";

// The rule of this slice: no holder gains or loses a right. The frozen copy in
// `scripts/verify-permissions.ts` is what decided rights before the evaluator.

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
  "the wildcard": ["*"]
};

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
        const expectedKeys = frozenCredentialPermissions({
          principalPermissions,
          credentialScopes: scopes
        });
        // The actor at the exchange and the actor a later request presents hold the same keys.
        expect(issued.principal.permissions, credentialState).toEqual(expectedKeys);
        expect(verified.permissions, credentialState).toEqual(expectedKeys);

        for (const actor of [issued.principal, verified]) {
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

  it("answers every legacy key as before for every role set and column", () => {
    for (const roles of roleSets) {
      for (const permissions of columns) {
        const holder = accessHolderFromIdentity({
          id: "usr_equivalence",
          externalUserId: "equivalence",
          displayLabel: "Equivalence",
          roles,
          permissions,
          permissionRefs: [],
          clientInstanceId,
          authSource: "test"
        });
        for (const key of LEGACY_KEYS) {
          const decision = evaluateAccess({
            holder,
            persisted: { holderActive: true, grants: [] },
            action: key
          });
          expect(decision.allowed, `${roles.join("+")} [${permissions.join(",")}] ${key}`).toBe(
            frozenHasPermission({ roles, permissions }, key)
          );
        }
      }
    }
  });

  it("answers a user without the legacy column as one with an empty column", () => {
    const holder = accessHolderFromIdentity({
      id: "usr_equivalence",
      externalUserId: "equivalence",
      displayLabel: "Equivalence",
      roles: ["user", "admin"],
      permissionRefs: [],
      clientInstanceId,
      authSource: "test"
    });
    expect(holder.permissions).toEqual([]);
  });
});

describe("legacy equivalence: the verification script", () => {
  async function seedHolders() {
    const { stores } = await createTestInstance();
    const admin = await stores.users.createUser({
      clientInstanceId,
      displayLabel: "Admin",
      roles: ["user", "admin"],
      permissions: ["!usage.view", "config_assets.release"],
      permissionRefs: ["demo-tools"]
    });
    const plain = await stores.users.createUser({
      clientInstanceId,
      displayLabel: "Plain",
      roles: ["user"],
      permissions: [],
      permissionRefs: []
    });
    const disabled = await stores.users.createUser({
      clientInstanceId,
      displayLabel: "Disabled",
      roles: ["user", "admin", "superadmin"],
      permissions: [],
      permissionRefs: ["demo-tools"]
    });
    await stores.users.updateUser({ clientInstanceId, userId: disabled.id, status: "disabled" });
    const principal = await stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      displayLabel: "CLI",
      permissions: ["config_assets.read", "config_assets.release"]
    });
    const scoped = await stores.apiAccess.createApiCredential({
      clientInstanceId,
      servicePrincipalId: principal.id,
      name: "scoped",
      scopes: ["config_assets:read"]
    });
    const unscoped = await stores.apiAccess.createApiCredential({
      clientInstanceId,
      servicePrincipalId: principal.id,
      name: "unscoped"
    });
    const revoked = await stores.apiAccess.createApiCredential({
      clientInstanceId,
      servicePrincipalId: principal.id,
      name: "revoked"
    });
    await stores.apiAccess.revokeApiCredential({
      clientInstanceId,
      credentialId: revoked.credential.id
    });
    return { stores, admin, plain, disabled, principal, scoped, unscoped, revoked };
  }

  it("prints one line per holder and exits 0 when every right is unchanged", async () => {
    const seeded = await seedHolders();
    const lines: string[] = [];
    const exitCode = await runVerifyPermissions({
      databaseUrl: await fileTestDatabaseUrl(),
      write: (line) => lines.push(line)
    });

    expect(exitCode).toBe(0);
    expect(lines.at(-1)).toBe("6 holders, every right unchanged");
    const holderLines = lines.slice(0, -1);
    expect(holderLines).toHaveLength(6);
    expect(holderLines.every((line) => line.startsWith("same "))).toBe(true);
    expect(holderLines.find((line) => line.includes(`user ${seeded.admin.id} `))).toContain(
      "keys=[agent_skills.approve,config_assets.read,config_assets.write,config_assets.release,users.manage,audit.view] refs=[demo-tools]"
    );
    expect(holderLines.find((line) => line.includes(`user ${seeded.plain.id} `))).toContain(
      "keys=[] refs=[]"
    );
    expect(holderLines.find((line) => line.includes(`user ${seeded.disabled.id} `))).toContain(
      "(disabled) keys=[] refs=[]"
    );
    expect(
      holderLines.find((line) => line.includes(`service_principal ${seeded.principal.id} `))
    ).toContain("keys=[config_assets.read,config_assets.release]");
    expect(
      holderLines.find((line) => line.includes(`credential ${seeded.scoped.credential.id} `))
    ).toContain("keys=[config_assets.read] ");
    expect(
      holderLines.find((line) => line.includes(`credential ${seeded.unscoped.credential.id} `))
    ).toContain("keys=[config_assets.read,config_assets.release]");
    expect(lines.join("\n")).not.toContain(seeded.revoked.credential.id);
    // Nothing a line prints is a secret.
    for (const created of [seeded.scoped, seeded.unscoped, seeded.revoked]) {
      expect(lines.join("\n")).not.toContain(created.secret);
    }
  });

  it("exits 1 and names the holder and the key when the frozen copy is tampered with", async () => {
    const seeded = await seedHolders();
    const lines: string[] = [];
    const exitCode = await runVerifyPermissions({
      databaseUrl: await fileTestDatabaseUrl(),
      write: (line) => lines.push(line),
      legacy: {
        ...frozenLegacyFunctions,
        hasPermission: (subject, key) =>
          key === "audit.view" ? false : frozenHasPermission(subject, key)
      }
    });

    expect(exitCode).toBe(1);
    expect(lines.at(-1)).toBe("1 of 6 holders differ");
    expect(lines.filter((line) => line.startsWith("DIFFERENT"))).toEqual([
      expect.stringContaining(
        `user ${seeded.admin.id} (active) keys=[agent_skills.approve,config_assets.read,config_assets.write,config_assets.release,users.manage,audit.view] refs=[demo-tools] :: audit.view: legacy false, evaluator true`
      )
    ]);
  });

  it("exits 1 when a tampered reference check or credential derivation disagrees", async () => {
    await seedHolders();
    const databaseUrl = await fileTestDatabaseUrl();
    const refLines: string[] = [];
    expect(
      await runVerifyPermissions({
        databaseUrl,
        write: (line) => refLines.push(line),
        legacy: { ...frozenLegacyFunctions, hasPermissionRef: () => false }
      })
    ).toBe(1);
    expect(refLines.join("\n")).toContain("ref:demo-tools: legacy false, evaluator true");

    // The admin, the principal and its unrestricted credential hold the release key.
    const credentialLines: string[] = [];
    expect(
      await runVerifyPermissions({
        databaseUrl,
        write: (line) => credentialLines.push(line),
        legacy: {
          ...frozenLegacyFunctions,
          hasPermission: (subject, key) =>
            key === "config_assets.release" ? false : frozenHasPermission(subject, key)
        }
      })
    ).toBe(1);
    expect(credentialLines.at(-1)).toBe("3 of 6 holders differ");
  });

  it("exits 1 once a deny row narrows a right the legacy column still grants", async () => {
    const seeded = await seedHolders();
    await seeded.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: seeded.admin.id,
      action: "agent.write",
      effect: "deny",
      scopeKind: "instance",
      grantedBy: asUserId(seeded.admin.id)
    });
    const lines: string[] = [];
    const exitCode = await runVerifyPermissions({
      databaseUrl: await fileTestDatabaseUrl(),
      write: (line) => lines.push(line)
    });
    expect(exitCode).toBe(1);
    expect(lines.filter((line) => line.startsWith("DIFFERENT"))).toEqual([
      expect.stringContaining("config_assets.write: legacy true, evaluator false")
    ]);
  });
});

describe("legacy equivalence: the migration", () => {
  const migrationsDirectory = resolve("packages/postgres-store/migrations");
  const journal: { entries: { tag: string }[] } = JSON.parse(
    readFileSync(join(migrationsDirectory, "meta/_journal.json"), "utf8")
  );
  const accessMigration = journal.entries.findIndex((entry) =>
    entry.tag.endsWith("_access_grants_namespaces")
  );

  it("leaves every user, service principal and credential row as it was", async () => {
    expect(accessMigration).toBeGreaterThan(0);
    const fixtures = new PostgresFixtures(inject("postgresFixturePrefix"));
    const databaseUrl = await fixtures.database("legacy-equivalence:migration", false);
    const before = mkdtempSync(join(tmpdir(), "catalyst-access-migration-"));
    cpSync(migrationsDirectory, before, { recursive: true });
    writeFileSync(
      join(before, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, accessMigration) })
    );
    const sql = postgres(databaseUrl, { max: 1, onnotice() {} });
    try {
      await migrateDatabase({ databaseUrl, migrationsDirectory: before });
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

      const applied = await migrateDatabase({ databaseUrl });
      expect(applied).toContain(journal.entries[accessMigration]?.tag);
      expect(await read()).toEqual(rowsBefore);

      // The migration writes no row: nobody holds a grant or a Namespace through it.
      const [grants] = await sql`select count(*)::int as count from permission_grants`;
      const [registered] = await sql`select count(*)::int as count from namespaces`;
      expect(grants).toEqual({ count: 0 });
      expect(registered).toEqual({ count: 0 });
    } finally {
      await sql.end();
      await fixtures.drop(databaseUrl);
      rmSync(before, { recursive: true, force: true });
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
