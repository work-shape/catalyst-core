// Proves that the rights evaluator answers what the legacy permission columns answered.
//
//   DATABASE_URL=postgres://... node --experimental-strip-types scripts/verify-permissions.ts
//
// It reads every user, every service principal and every credential that is not revoked, asks
// a frozen copy of the functions that decided rights before the evaluator, asks the evaluator,
// and prints one line per holder. It exits 1 when any answer differs and 2 when it cannot run.
// It writes nothing. Run it after the migration and the new release are in place and before
// anyone writes a deny row: a deny row is a difference the legacy columns cannot express.
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import {
  asApiCredentialId,
  asClientInstanceId,
  createAuthorizer,
  type AccessStore,
  type ApiAccessStore,
  type AuthenticatedIdentity,
  type UserStore
} from "@vivd-catalyst/core";
import { createPostgresStores } from "@vivd-catalyst/postgres-store";

// ---------------------------------------------------------------------------------------------
// The frozen copy: `packages/core/src/permissions.ts` and `deriveEffectiveServiceGrants` in
// `packages/auth/src/service-access-token.ts` as they stood at the commit before the evaluator.
// It imports nothing from the product, so a later change of the product cannot move it.
// ---------------------------------------------------------------------------------------------

export const LEGACY_KEYS = [
  "agent_skills.approve",
  "config_assets.read",
  "config_assets.write",
  "config_assets.release",
  "usage.view",
  "users.manage",
  "api_access.manage",
  "agent_models.manage",
  "audit.view"
] as const;

export type LegacyKey = (typeof LEGACY_KEYS)[number];

const LEGACY_ROLE_DEFAULTS: Record<string, readonly LegacyKey[]> = {
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
};

const LEGACY_KEY_SCOPES: Partial<Record<LegacyKey, string>> = {
  "config_assets.read": "config_assets:read",
  "config_assets.write": "config_assets:write",
  "config_assets.release": "config_assets:release",
  "usage.view": "governance:read",
  "users.manage": "user_admin:write",
  "api_access.manage": "api_access:write",
  "audit.view": "governance:read"
};

function isLegacyKey(value: string): value is LegacyKey {
  return LEGACY_KEYS.some((key) => key === value);
}

export interface LegacySubject {
  roles?: readonly string[];
  permissions?: readonly string[];
}

/** `resolveEffectivePermissions` and `hasPermission`, frozen. */
export function frozenHasPermission(subject: LegacySubject, key: LegacyKey): boolean {
  const effective = new Set<LegacyKey>();
  const revocations = new Set<LegacyKey>();
  for (const role of subject.roles ?? []) {
    for (const permission of LEGACY_ROLE_DEFAULTS[role] ?? []) {
      effective.add(permission);
    }
  }
  for (const entry of subject.permissions ?? []) {
    const revoked = entry.startsWith("!");
    const permission = revoked ? entry.slice(1) : entry;
    if (!isLegacyKey(permission)) {
      continue;
    }
    if (revoked) {
      revocations.add(permission);
    } else {
      effective.add(permission);
    }
  }
  for (const permission of revocations) {
    effective.delete(permission);
  }
  return effective.has(key);
}

/** `deriveEffectiveServiceGrants`, frozen: the keys a credential's token carries. */
export function frozenCredentialPermissions(input: {
  principalPermissions: readonly string[];
  credentialScopes: readonly string[] | undefined;
}): LegacyKey[] {
  const principalScopes = new Map<string, LegacyKey>();
  for (const key of LEGACY_KEYS) {
    if (!frozenHasPermission({ permissions: input.principalPermissions }, key)) {
      continue;
    }
    const scope = LEGACY_KEY_SCOPES[key];
    if (scope) {
      principalScopes.set(scope, key);
    }
  }
  const restrictions = input.credentialScopes?.map((entry) =>
    isLegacyKey(entry) ? (LEGACY_KEY_SCOPES[entry] ?? entry) : entry
  );
  const selected = restrictions ?? [...principalScopes.keys()];
  return [...new Set(selected)].flatMap((scope) => {
    const key = scope === "*" ? undefined : principalScopes.get(scope);
    return key === undefined ? [] : [key];
  });
}

/** The check a tool call made on a reference before the evaluator. */
export function frozenHasPermissionRef(permissionRefs: readonly string[], ref: string): boolean {
  return permissionRefs.includes(ref);
}

// ---------------------------------------------------------------------------------------------
// The comparison.
// ---------------------------------------------------------------------------------------------

export interface LegacyFunctions {
  hasPermission: typeof frozenHasPermission;
  credentialPermissions: typeof frozenCredentialPermissions;
  hasPermissionRef: typeof frozenHasPermissionRef;
}

export const frozenLegacyFunctions: LegacyFunctions = {
  hasPermission: frozenHasPermission,
  credentialPermissions: frozenCredentialPermissions,
  hasPermissionRef: frozenHasPermissionRef
};

export interface HolderComparison {
  /** `user <id>`, `service_principal <id>` or `credential <id> of <principal id>`. */
  holder: string;
  status: string;
  /** The legacy keys the evaluator allows. */
  keys: string[];
  /** The references the evaluator allows. */
  refs: string[];
  /** One entry per answer that differs. Empty when the holder's rights are unchanged. */
  differences: string[];
}

export interface VerifyStores {
  users: Pick<UserStore, "listUsers">;
  apiAccess: Pick<ApiAccessStore, "listServicePrincipals" | "listApiCredentials">;
  access: AccessStore;
}

/**
 * A holder that is not active could not sign in before and holds nothing now, so the expected
 * answer for it is "no" throughout.
 */
async function compareHolder(input: {
  holder: string;
  status: string;
  stores: VerifyStores;
  actor: AuthenticatedIdentity;
  legacySubject: LegacySubject;
  legacy: LegacyFunctions;
}): Promise<HolderComparison> {
  const access = await createAuthorizer(input.stores.access).forActor(input.actor);
  const active = input.status === "active";
  const comparison: HolderComparison = {
    holder: input.holder,
    status: input.status,
    keys: [],
    refs: [],
    differences: []
  };
  for (const key of LEGACY_KEYS) {
    const before = active && input.legacy.hasPermission(input.legacySubject, key);
    const now = access.authorize(key).allowed;
    if (now) comparison.keys.push(key);
    if (before !== now) {
      comparison.differences.push(`${key}: legacy ${String(before)}, evaluator ${String(now)}`);
    }
  }
  for (const ref of input.actor.permissionRefs) {
    const before = active && input.legacy.hasPermissionRef(input.actor.permissionRefs, ref);
    const now = access.authorize(`ref:${ref}`).allowed;
    if (now) comparison.refs.push(ref);
    if (before !== now) {
      comparison.differences.push(`ref:${ref}: legacy ${String(before)}, evaluator ${String(now)}`);
    }
  }
  return comparison;
}

export async function verifyPermissions(input: {
  stores: VerifyStores;
  clientInstanceIds: readonly string[];
  legacy?: LegacyFunctions;
}): Promise<HolderComparison[]> {
  const legacy = input.legacy ?? frozenLegacyFunctions;
  const { stores } = input;
  const comparisons: HolderComparison[] = [];
  for (const id of input.clientInstanceIds) {
    const clientInstanceId = asClientInstanceId(id);
    for (const user of await stores.users.listUsers({ clientInstanceId })) {
      comparisons.push(
        await compareHolder({
          holder: `user ${user.id}`,
          status: user.status,
          stores,
          legacy,
          legacySubject: { roles: user.roles, permissions: user.permissions },
          actor: {
            id: user.id,
            externalUserId: user.id,
            displayLabel: user.displayLabel,
            roles: user.roles,
            permissions: user.permissions,
            permissionRefs: user.permissionRefs,
            clientInstanceId,
            authSource: "verify-permissions"
          }
        })
      );
    }
    for (const principal of await stores.apiAccess.listServicePrincipals({ clientInstanceId })) {
      const actor = {
        kind: "service" as const,
        id: principal.id,
        displayLabel: principal.displayLabel,
        permissionRefs: principal.permissionRefs,
        clientInstanceId,
        authSource: "verify-permissions",
        scopes: []
      };
      const credentials = await stores.apiAccess.listApiCredentials({
        clientInstanceId,
        servicePrincipalId: principal.id
      });
      // What the principal itself holds, before any credential narrows it.
      comparisons.push(
        await compareHolder({
          holder: `service_principal ${principal.id}`,
          status: principal.status,
          stores,
          legacy,
          legacySubject: { permissions: principal.permissions },
          actor: {
            ...actor,
            credentialId: asApiCredentialId("verify-permissions"),
            permissions: principal.permissions
          }
        })
      );
      for (const credential of credentials) {
        if (credential.revokedAt) {
          continue;
        }
        const permissions = legacy.credentialPermissions({
          principalPermissions: principal.permissions,
          credentialScopes: credential.scopes
        });
        comparisons.push(
          await compareHolder({
            holder: `credential ${credential.id} of ${principal.id}`,
            status: principal.status,
            stores,
            legacy,
            legacySubject: { permissions },
            actor: { ...actor, credentialId: credential.id, permissions }
          })
        );
      }
    }
  }
  return comparisons;
}

export function formatComparison(comparison: HolderComparison): string {
  const rights = `keys=[${comparison.keys.join(",")}] refs=[${comparison.refs.join(",")}]`;
  return comparison.differences.length === 0
    ? `same       ${comparison.holder} (${comparison.status}) ${rights}`
    : `DIFFERENT  ${comparison.holder} (${comparison.status}) ${rights} :: ${comparison.differences.join("; ")}`;
}

/** Returns the exit code: 0 when every holder's rights are unchanged, 1 otherwise. */
export async function runVerifyPermissions(input: {
  databaseUrl: string;
  write: (line: string) => void;
  legacy?: LegacyFunctions;
}): Promise<number> {
  const sql = postgres(input.databaseUrl, { max: 1, onnotice() {} });
  let clientInstanceIds: string[];
  try {
    const rows = await sql<{ id: string }[]>`
      select client_instance_id as id from product_users
      union
      select client_instance_id as id from service_principals
      order by id
    `;
    clientInstanceIds = rows.map((row) => row.id);
  } finally {
    await sql.end();
  }
  const stores = await createPostgresStores({ databaseUrl: input.databaseUrl, poolSize: 2 });
  try {
    const comparisons = await verifyPermissions({
      stores,
      clientInstanceIds,
      ...(input.legacy === undefined ? {} : { legacy: input.legacy })
    });
    for (const comparison of comparisons) {
      input.write(formatComparison(comparison));
    }
    const different = comparisons.filter((comparison) => comparison.differences.length > 0);
    input.write(
      different.length === 0
        ? `${comparisons.length} holders, every right unchanged`
        : `${different.length} of ${comparisons.length} holders differ`
    );
    return different.length === 0 ? 0 : 1;
  } finally {
    await stores.close();
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write("verify-permissions needs DATABASE_URL\n");
    process.exit(2);
  }
  try {
    process.exitCode = await runVerifyPermissions({
      databaseUrl,
      write: (line) => process.stdout.write(`${line}\n`)
    });
  } catch (error) {
    // The message of a connection error can repeat the connection string.
    const name = error instanceof Error ? error.name : "UnknownError";
    const code =
      typeof error === "object" && error !== null && "code" in error ? String(error.code) : "none";
    process.stderr.write(`verify-permissions could not run (${name}, code ${code})\n`);
    process.exit(2);
  }
}
