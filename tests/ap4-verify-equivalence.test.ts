import postgres, { type Sql } from "postgres";
import { afterEach, describe, expect, inject, it } from "vitest";
import { deriveEffectiveServiceGrants } from "@vivd-catalyst/auth";
import {
  ACTIONS,
  PERMISSIONS,
  asApiCredentialId,
  asClientInstanceId,
  asServicePrincipalId,
  asUserId,
  authScopeForPermission,
  createAuthorizer,
  legacyPermissionFor,
  type AccessResource,
  type AuthenticatedIdentity,
  type PermissionGrant
} from "@vivd-catalyst/core";
import { migrateDatabase } from "@vivd-catalyst/postgres-store";
import * as pre from "./support/ap4-verify/pre-ap4-permissions";
import { migrationsUntil } from "./support/migrations-until";
import { PostgresFixtures } from "./support/postgres-fixtures";
import { storesOn } from "./support/upgrade-database";

// AP-4 verifier: an independent check that migration 0072 plus the row-only evaluator answers
// what the evaluator of the commit before AP-4 (a frozen copy in support/ap4-verify) answered
// over the legacy columns, for every registered action, every key and three resources, over a
// random seed written at the migration before AP-4.

const fixtures = new PostgresFixtures(inject("postgresFixturePrefix"));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const INSTANCES = ["ap4-a", "ap4-b"];

function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

async function databaseBeforeAp4() {
  const databaseUrl = await fixtures.database(`ap4-verify:${crypto.randomUUID()}`, false);
  const before = migrationsUntil({ name: "legacy_permission_grants", including: false });
  const sql = postgres(databaseUrl, { max: 1, onnotice() {} });
  cleanups.push(() => fixtures.drop(databaseUrl));
  cleanups.push(() => sql.end());
  cleanups.push(() => before.remove());
  await migrateDatabase({ databaseUrl, migrationsDirectory: before.directory });
  return { databaseUrl, sql };
}

const RESOURCES: (AccessResource | undefined)[] = [
  undefined,
  { kind: "agent", name: "sales-offer", assetId: "asset_1" },
  { kind: "agent", name: "other", assetId: "asset_2", workspaceId: "ws_1" }
];

interface Seeded {
  users: {
    id: string;
    instance: string;
    roles: string[];
    permissions: unknown;
    refs: string[];
    active: boolean;
  }[];
  principals: { id: string; instance: string; permissions: unknown; active: boolean }[];
  credentials: {
    id: string;
    instance: string;
    principalId: string;
    scopes: string[] | undefined;
  }[];
}

async function seed(sql: Sql, seedNumber: number): Promise<Seeded> {
  const random = prng(seedNumber);
  const pick = <T>(values: readonly T[]): T => {
    const value = values[Math.floor(random() * values.length)];
    if (value === undefined) throw new Error("pick from an empty list");
    return value;
  };
  const entryPool = [
    ...PERMISSIONS,
    ...PERMISSIONS.map((key) => `!${key}`),
    "nonsense",
    "*",
    "!",
    "",
    "!!users.manage",
    " users.manage",
    "USERS.MANAGE",
    "agent.write",
    "ref:demo"
  ];
  const seeded: Seeded = { users: [], principals: [], credentials: [] };
  for (let index = 0; index < 400; index += 1) {
    const instance = pick(INSTANCES);
    const roles = ["user", "admin", "superadmin", "owner"].filter(() => random() < 0.3);
    const permissions = Array.from({ length: Math.floor(random() * 6) }, () => pick(entryPool));
    const refs = random() < 0.2 ? ["demo"] : [];
    const status = random() < 0.1 ? "disabled" : "active";
    const deleting = random() < 0.05;
    const id = `usr_${index}`;
    await sql`
      insert into product_users (id, client_instance_id, display_label, roles, permission_refs,
        permissions, status, deletion_requested_at, created_at, updated_at)
      values (${id}, ${instance}, ${id}, ${JSON.stringify(roles)}::text::jsonb,
        ${JSON.stringify(refs)}::text::jsonb, ${JSON.stringify(permissions)}::text::jsonb,
        ${status}, ${deleting ? new Date() : null}, now(), now())`;
    seeded.users.push({
      id,
      instance,
      roles,
      permissions,
      refs,
      active: status === "active" && !deleting
    });
  }
  for (let index = 0; index < 60; index += 1) {
    const instance = pick(INSTANCES);
    const permissions = Array.from({ length: Math.floor(random() * 5) }, () => pick(entryPool));
    const status = random() < 0.1 ? "disabled" : "active";
    const id = `sp_${index}`;
    await sql`
      insert into service_principals (id, client_instance_id, name, display_label, status,
        permission_refs, permissions, created_at, updated_at)
      values (${id}, ${instance}, ${id}, ${id}, ${status}, '[]'::jsonb,
        ${JSON.stringify(permissions)}::text::jsonb, now(), now())`;
    seeded.principals.push({ id, instance, permissions, active: status === "active" });
    const scopePool = [
      "config_assets:read",
      "config_assets:write",
      "config_assets:release",
      "governance:read",
      "user_admin:write",
      "api_access:write",
      "config_assets.read",
      "users.manage",
      "*"
    ];
    for (let c = 0; c < 4; c += 1) {
      const choice = random();
      const scopes: string | null =
        choice < 0.25
          ? null
          : choice < 0.3
            ? "null"
            : choice < 0.35
              ? "[]"
              : JSON.stringify(
                  Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(scopePool))
                );
      const credentialId = `cred_${index}_${c}`;
      await sql`
        insert into api_credentials (id, client_instance_id, service_principal_id, name,
          key_prefix, secret_hash, scopes, created_at)
        values (${credentialId}, ${instance}, ${id}, ${credentialId}, ${`p-${credentialId}`},
          ${`h-${credentialId}`}, ${scopes}::text::jsonb, now())`;
      const parsed: unknown = scopes === null ? null : JSON.parse(scopes);
      seeded.credentials.push({
        id: credentialId,
        instance,
        principalId: id,
        scopes: Array.isArray(parsed) ? parsed.map(String) : undefined
      });
    }
  }
  // Rows written before AP-4 at every scope kind, on any action, for some holders.
  const seen = new Set<string>();
  for (const holder of [
    ...seeded.users.map((user) => ({ kind: "user", id: user.id, instance: user.instance })),
    ...seeded.principals.map((sp) => ({
      kind: "service_principal",
      id: sp.id,
      instance: sp.instance
    }))
  ]) {
    const count = random() < 0.4 ? Math.floor(random() * 4) : 0;
    for (let index = 0; index < count; index += 1) {
      const action =
        random() < 0.7
          ? pick(
              ACTIONS.filter((a) => {
                try {
                  legacyPermissionFor(a);
                  return true;
                } catch {
                  return false;
                }
              })
            )
          : pick(ACTIONS);
      // No release before AP-4 wrote a row at instance scope: the Access page refused it
      // (`invalid_scope`). A user's row there is still compared; a service principal's is not,
      // because once migration 0072 merged it with a key of the list nothing tells the two
      // apart, and a credential's scopes cap the list's keys but did not cap such a row.
      const scopeKind = pick(
        holder.kind === "user"
          ? (["instance", "namespace", "asset", "workspace"] as const)
          : (["namespace", "asset", "workspace"] as const)
      );
      const scopeId = scopeKind === "asset" ? "asset_1" : scopeKind === "workspace" ? "ws_1" : null;
      const namespace = scopeKind === "namespace" ? "sales-" : null;
      const key = `${holder.instance}|${holder.kind}|${holder.id}|${action}|${scopeKind}|${scopeId}|${namespace}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await sql`
        insert into permission_grants (id, client_instance_id, holder_kind, holder_id, action,
          scope_kind, scope_id, namespace, effect, granted_by, created_at)
        values (${`g_${seen.size}`}, ${holder.instance}, ${holder.kind}, ${holder.id}, ${action},
          ${scopeKind}, ${scopeId}, ${namespace}, ${random() < 0.5 ? "allow" : "deny"}, 'usr_x', now())`;
    }
  }
  return seeded;
}

async function snapshotGrants(sql: Sql): Promise<PermissionGrant[]> {
  const rows = await sql<
    {
      id: string;
      client_instance_id: string;
      holder_kind: PermissionGrant["holderKind"];
      holder_id: string;
      action: string;
      effect: PermissionGrant["effect"];
      scope_kind: PermissionGrant["scopeKind"];
      scope_id: string | null;
      namespace: string | null;
    }[]
  >`select * from permission_grants`;
  return rows.map((row) => ({
    id: row.id,
    clientInstanceId: asClientInstanceId(row.client_instance_id),
    holderKind: row.holder_kind,
    holderId: row.holder_id,
    action: row.action,
    effect: row.effect,
    scopeKind: row.scope_kind,
    ...(row.scope_id === null ? {} : { scopeId: row.scope_id }),
    ...(row.namespace === null ? {} : { namespace: row.namespace }),
    grantedBy: asUserId("usr_x"),
    createdAt: new Date().toISOString()
  }));
}

/** `deriveEffectiveServiceGrants` at the commit before AP-4, over the columns. */
function preDerive(principalPermissions: string[], credentialScopes: string[] | undefined) {
  const principalScopes = new Map<string, string>();
  for (const permission of pre.resolveEffectivePermissions({ permissions: principalPermissions })) {
    const scope = pre.authScopeForPermission(permission);
    if (scope) principalScopes.set(scope, permission);
  }
  const restrictions = credentialScopes?.map((entry) =>
    pre.isPermission(entry) ? (pre.authScopeForPermission(entry) ?? entry) : entry
  );
  const selected = restrictions ?? [...principalScopes.keys()];
  const scopes = [...new Set(selected)].filter((s) => s !== "*" && principalScopes.has(s));
  return {
    scopes,
    permissions: scopes.flatMap((scope) => {
      const permission = principalScopes.get(scope);
      return permission === undefined ? [] : [permission];
    })
  };
}

const QUESTIONS = [...ACTIONS, ...PERMISSIONS, "ref:demo"];

/** The legacy key behind an action, or none. */
function legacyKeyOf(action: (typeof ACTIONS)[number]) {
  try {
    return legacyPermissionFor(action);
  } catch {
    return undefined;
  }
}

function asList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

describe("AP-4 verifier: rights before and after migration 0072", () => {
  for (const seedNumber of [1, 2, 3]) {
    it(`users answer the same for every action, key and resource (seed ${seedNumber})`, async () => {
      const { databaseUrl, sql } = await databaseBeforeAp4();
      const seeded = await seed(sql, seedNumber);
      const grantsBefore = await snapshotGrants(sql);
      await migrateDatabase({ databaseUrl });
      const stores = await storesOn(databaseUrl);
      cleanups.push(() => stores.close());
      const authorizer = createAuthorizer(stores.access);
      const differences: string[] = [];
      for (const user of seeded.users) {
        const clientInstanceId = asClientInstanceId(user.instance);
        const before = pre.createActorAccess(
          {
            kind: "user",
            id: user.id,
            clientInstanceId,
            roles: user.roles,
            permissions: asList(user.permissions),
            permissionRefs: user.refs
          },
          {
            holderActive: user.active,
            grants: grantsBefore.filter(
              (grant) =>
                grant.clientInstanceId === clientInstanceId &&
                grant.holderKind === "user" &&
                grant.holderId === user.id
            ),
            memberWorkspaceIds: []
          }
        );
        const actor: AuthenticatedIdentity = {
          id: user.id,
          externalUserId: user.id,
          displayLabel: user.id,
          roles: user.roles,
          permissionRefs: user.refs,
          permissions: [],
          clientInstanceId,
          authSource: "ap4-verify"
        };
        const after = await authorizer.forActor(actor);
        for (const question of QUESTIONS) {
          for (const resource of RESOURCES) {
            const was = before.authorize(question, resource).allowed;
            const now = after.authorize(question, resource).allowed;
            if (was !== now) {
              differences.push(
                `${user.id} roles=${JSON.stringify(user.roles)} list=${JSON.stringify(user.permissions)} ${question} ${JSON.stringify(resource)}: before ${was}, after ${now}`
              );
            }
          }
        }
      }
      expect(differences.slice(0, 20)).toEqual([]);
    });
  }

  it("a service principal's API key holds the same rights through its token", async () => {
    const { databaseUrl, sql } = await databaseBeforeAp4();
    const seeded = await seed(sql, 7);
    const grantsBefore = await snapshotGrants(sql);
    await migrateDatabase({ databaseUrl });
    const stores = await storesOn(databaseUrl);
    cleanups.push(() => stores.close());
    const authorizer = createAuthorizer(stores.access);
    const scopeDifferences: string[] = [];
    const gated: string[] = [];
    const ungated: string[] = [];
    for (const credential of seeded.credentials) {
      const principal = seeded.principals.find((sp) => sp.id === credential.principalId);
      if (!principal || !principal.active) continue;
      const clientInstanceId = asClientInstanceId(credential.instance);
      const old = preDerive(asList(principal.permissions), credential.scopes);
      const resolved = await stores.apiAccess.resolveApiCredential({
        clientInstanceId,
        credentialId: asApiCredentialId(credential.id)
      });
      const now = resolved
        ? deriveEffectiveServiceGrants(resolved)
        : { scopes: [], permissions: [] };
      if ([...old.scopes].sort().join() !== [...now.scopes].sort().join()) {
        scopeDifferences.push(
          `${credential.id} list=${JSON.stringify(principal.permissions)} scopes=${JSON.stringify(credential.scopes)}: token scopes before ${JSON.stringify(old.scopes)}, after ${JSON.stringify(now.scopes)}`
        );
      }
      const before = pre.createActorAccess(
        {
          kind: "service_principal",
          id: principal.id,
          clientInstanceId,
          roles: [],
          permissions: old.permissions,
          permissionRefs: []
        },
        {
          holderActive: true,
          grants: grantsBefore.filter(
            (grant) =>
              grant.clientInstanceId === clientInstanceId &&
              grant.holderKind === "service_principal" &&
              grant.holderId === principal.id
          ),
          memberWorkspaceIds: []
        }
      );
      const after = await authorizer.forActor({
        kind: "service",
        id: asServicePrincipalId(principal.id),
        credentialId: asApiCredentialId(credential.id),
        displayLabel: principal.id,
        permissionRefs: [],
        permissions: now.permissions,
        clientInstanceId,
        authSource: "service-access-token",
        scopes: now.scopes
      });
      for (const question of QUESTIONS) {
        const was = before.authorize(question).allowed;
        const is = after.authorize(question).allowed;
        if (was === is) continue;
        const action = ACTIONS.find((candidate) => candidate === question);
        const key =
          PERMISSIONS.find((candidate) => candidate === question) ??
          (action === undefined ? undefined : legacyKeyOf(action));
        const scope = key === undefined ? undefined : authScopeForPermission(key);
        const line = `${credential.id} list=${JSON.stringify(principal.permissions)} scopes=${JSON.stringify(credential.scopes)} token=${JSON.stringify(now.scopes)} ${question}: before ${was}, after ${is}`;
        if (scope !== undefined && now.scopes.some((held) => held === scope)) gated.push(line);
        else ungated.push(line);
      }
    }
    expect({ scopeDifferences, gated: gated.slice(0, 10), ungated: ungated.slice(0, 15) }).toEqual({
      scopeDifferences: [],
      gated: [],
      ungated: []
    });
  });
});
