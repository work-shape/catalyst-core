// Proves that the rights evaluator answers what the legacy permission columns answered.
//
//   DATABASE_URL=postgres://... node --experimental-strip-types scripts/verify-permissions.ts
//   DATABASE_URL=postgres://... node --experimental-strip-types scripts/verify-permissions.ts --restore-legacy-columns
//
// It reads every user, every service principal and every credential that is not revoked, asks
// a frozen copy of the functions that decided rights before the evaluator, asks the evaluator,
// and prints one line per holder. It exits 1 when any answer differs and 2 when it cannot run.
// It writes nothing. Run it after the migration and the new release are in place and before
// anyone changes a right: the legacy columns keep what they held when the migration moved them
// into grant rows (AP-4), and every later change is a difference.
//
// The frozen copy reads the columns as they are in the database. The evaluator reads the grant
// rows the migration wrote from them. A credential the migration gave `["*"]` had no list
// before, and is read so; one given `*` by hand had it taken out by the migration.
//
// `--restore-legacy-columns` is the way back to a release before AP-4, which reads the columns
// and every grant row: it writes each holder's instance-wide rows back into its column as the
// legacy list and removes those rows, turns every `["*"]` back to null and marks the restore in
// `legacy_permission_restores`, so the next migration step moves the lists into rows again. It
// prints what it changed and checks nothing. Run it with the new release stopped and start the
// old release after it.
import { pathToFileURL } from "node:url";
import postgres, { type Sql } from "postgres";
import { deriveEffectiveServiceGrants } from "@vivd-catalyst/auth";
import {
  LEGACY_PERMISSION_ACTIONS,
  asApiCredentialId,
  asClientInstanceId,
  asServicePrincipalId,
  createAuthorizer,
  createPlatformId,
  isPermission,
  legacyPermissionList,
  type AccessStore,
  type ApiAccessStore,
  type AuthenticatedIdentity,
  type PermissionGrant
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

/**
 * The keys a request's token carried: the scopes `deriveEffectiveServiceGrants` left of the
 * credential's list, each read as its first key, as `HmacServiceAccessTokenAuthAdapter` read
 * them (`permissionForAuthScope`), frozen. `governance:read` was `usage.view`.
 */
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
    const key =
      scope === "*" || !principalScopes.has(scope)
        ? undefined
        : LEGACY_KEYS.find((candidate) => LEGACY_KEY_SCOPES[candidate] === scope);
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
  apiAccess: Pick<ApiAccessStore, "resolveApiCredential">;
  access: AccessStore;
}

/** A user as the database holds it, the legacy column included. */
interface UserColumns {
  id: string;
  client_instance_id: string;
  display_label: string;
  roles: string[];
  permissions: string[];
  permission_refs: string[];
  status: string;
}

/** A service principal as the database holds it, the legacy column included. */
interface PrincipalColumns {
  id: string;
  client_instance_id: string;
  display_label: string;
  permissions: string[];
  permission_refs: string[];
  status: string;
}

/** A credential that is not revoked, with its list as the database holds it. */
interface CredentialColumns {
  id: string;
  client_instance_id: string;
  service_principal_id: string;
  scopes: string[] | null;
}

/** What the migration gave a credential that had no list. */
function listBeforeBackfill(scopes: string[] | null): string[] | undefined {
  return scopes === null || (scopes.length === 1 && scopes[0] === "*") ? undefined : scopes;
}

/**
 * A holder that is not active could not sign in before and holds nothing now, so the expected
 * answer for it is "no" throughout. Each key is asked as a key and as each action it stands
 * for, so a row the migration left out or wrote with the wrong effect is found by its action.
 */
async function compareHolder(input: {
  holder: string;
  status: string;
  authorizer: ReturnType<typeof createAuthorizer>;
  actor: AuthenticatedIdentity;
  legacySubject: LegacySubject;
  legacy: LegacyFunctions;
}): Promise<HolderComparison> {
  const access = await input.authorizer.forActor(input.actor);
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
      continue;
    }
    for (const action of LEGACY_PERMISSION_ACTIONS[key]) {
      const actionNow = access.authorize(action).allowed;
      if (actionNow !== before) {
        comparison.differences.push(
          `${action} (${key}): legacy ${String(before)}, evaluator ${String(actionNow)}`
        );
      }
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
  sql: Sql;
  stores: VerifyStores;
  legacy?: LegacyFunctions;
}): Promise<HolderComparison[]> {
  const legacy = input.legacy ?? frozenLegacyFunctions;
  const { sql, stores } = input;
  const authorizer = createAuthorizer(stores.access);
  const comparisons: HolderComparison[] = [];
  const users = await sql<UserColumns[]>`
    select id, client_instance_id, display_label, roles, permissions, permission_refs,
      case when deletion_requested_at is null then status else 'deleting' end as status
    from product_users order by client_instance_id, display_label, id
  `;
  for (const user of users) {
    const clientInstanceId = asClientInstanceId(user.client_instance_id);
    comparisons.push(
      await compareHolder({
        holder: `user ${user.id}`,
        status: user.status,
        authorizer,
        legacy,
        legacySubject: { roles: user.roles, permissions: user.permissions },
        actor: {
          id: user.id,
          externalUserId: user.id,
          displayLabel: user.display_label,
          roles: user.roles,
          permissionRefs: user.permission_refs,
          clientInstanceId,
          authSource: "verify-permissions"
        }
      })
    );
  }
  const principals = await sql<PrincipalColumns[]>`
    select id, client_instance_id, display_label, permissions, permission_refs, status
    from service_principals order by client_instance_id, display_label, id
  `;
  const credentials = await sql<CredentialColumns[]>`
    select id, client_instance_id, service_principal_id, scopes
    from api_credentials where revoked_at is null order by name, id
  `;
  for (const principal of principals) {
    const clientInstanceId = asClientInstanceId(principal.client_instance_id);
    const actor = {
      kind: "service" as const,
      id: asServicePrincipalId(principal.id),
      displayLabel: principal.display_label,
      permissionRefs: principal.permission_refs,
      permissions: [],
      clientInstanceId,
      authSource: "verify-permissions",
      scopes: []
    };
    // What the principal itself holds, before any credential narrows it: an actor no token
    // stands behind (a Workflow run's), so only its rows decide.
    comparisons.push(
      await compareHolder({
        holder: `service_principal ${principal.id}`,
        status: principal.status,
        authorizer,
        legacy,
        legacySubject: { permissions: principal.permissions },
        actor: {
          ...actor,
          workflowRunId: createPlatformId<"WorkflowRunId">("wfr")
        }
      })
    );
    const owned = credentials.filter(
      (credential) =>
        credential.service_principal_id === principal.id &&
        credential.client_instance_id === principal.client_instance_id
    );
    for (const credential of owned) {
      const credentialId = asApiCredentialId(credential.id);
      const resolved = await stores.apiAccess.resolveApiCredential({
        clientInstanceId,
        credentialId
      });
      // The token the product issues now, from the rows behind the principal's list: what it
      // is allowed is compared, not what a route's scope check would let through to the
      // evaluator, so a right the token's scopes do not cap is found.
      const token = resolved
        ? deriveEffectiveServiceGrants(resolved)
        : { scopes: [], permissions: [] };
      comparisons.push(
        await compareHolder({
          holder: `credential ${credential.id} of ${principal.id}`,
          status: principal.status,
          authorizer,
          legacy,
          legacySubject: {
            permissions: legacy.credentialPermissions({
              principalPermissions: principal.permissions,
              credentialScopes: listBeforeBackfill(credential.scopes)
            })
          },
          actor: { ...actor, credentialId, scopes: token.scopes, permissions: token.permissions }
        })
      );
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
  const stores = await createPostgresStores({ databaseUrl: input.databaseUrl, poolSize: 2 });
  try {
    const comparisons = await verifyPermissions({
      sql,
      stores,
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
    await sql.end();
  }
}

// ---------------------------------------------------------------------------------------------
// The way back to a release that reads the columns.
// ---------------------------------------------------------------------------------------------

type InstanceRow = Pick<PermissionGrant, "action" | "effect" | "scopeKind"> & {
  holder_kind: string;
  holder_id: string;
  client_instance_id: string;
};

function sameEntries(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

/**
 * The way back to a release before AP-4, in one transaction. That release reads each holder's
 * column and every grant row, so the column takes the legacy list the holder's instance-wide
 * rows say, and the rows the list now stands for are removed. Every `["*"]` turns back to null,
 * and a row of `legacy_permission_restores` marks the restore: the next migration step moves
 * the lists the old release kept into rows again, whatever migrations are recorded. Run a
 * second time before that step, it finds the mark and changes nothing. Returns the number of
 * rows it changed.
 */
export async function restoreLegacyColumns(input: {
  sql: Sql;
  write: (line: string) => void;
}): Promise<number> {
  return input.sql.begin(async (tx) => {
    const [restored] = await tx<{ restored_at: Date }[]>`
      select restored_at from legacy_permission_restores order by restored_at limit 1
    `;
    if (restored !== undefined) {
      input.write(
        `The lists were written back into the columns at ${restored.restored_at.toISOString()}; the next migration step moves them into rows again`
      );
      return 0;
    }
    const rows = await tx<InstanceRow[]>`
      select holder_kind, holder_id, client_instance_id, action, effect,
        scope_kind as "scopeKind"
      from permission_grants
      where scope_kind = 'instance' and holder_kind in ('user', 'service_principal')
    `;
    let changed = 0;
    for (const [table, kind] of [
      ["product_users", "user"],
      ["service_principals", "service_principal"]
    ] as const) {
      const holders = await tx<{ id: string; client_instance_id: string; permissions: string[] }[]>`
        select id, client_instance_id, permissions from ${tx(table)}
        where ${table === "product_users" ? tx`deletion_requested_at is null` : tx`true`}
        order by id
      `;
      for (const holder of holders) {
        const list = legacyPermissionList(
          rows.filter(
            (row) =>
              row.holder_kind === kind &&
              row.holder_id === holder.id &&
              row.client_instance_id === holder.client_instance_id
          )
        );
        if (!sameEntries(list, holder.permissions)) {
          await tx`
            update ${tx(table)} set permissions = ${tx.json(list)}
            where id = ${holder.id} and client_instance_id = ${holder.client_instance_id}
          `;
          changed += 1;
          input.write(
            `restored   ${kind} ${holder.id} [${holder.permissions.join(",")}] -> [${list.join(",")}]`
          );
        }
        const listed = list.flatMap((entry) => {
          const key = entry.startsWith("!") ? entry.slice(1) : entry;
          return isPermission(key) ? [...LEGACY_PERMISSION_ACTIONS[key]] : [];
        });
        if (listed.length === 0) continue;
        const removed = await tx`
          delete from permission_grants
          where client_instance_id = ${holder.client_instance_id} and holder_kind = ${kind}
            and holder_id = ${holder.id} and scope_kind = 'instance' and action in ${tx(listed)}
        `;
        changed += removed.count;
      }
    }
    const credentials = await tx<{ id: string }[]>`
      update api_credentials set scopes = null where scopes = '["*"]'::jsonb returning id
    `;
    for (const credential of credentials) {
      input.write(`restored   credential ${credential.id} ["*"] -> null`);
    }
    changed += credentials.length;
    await tx`insert into legacy_permission_restores (restored_at) values (now())`;
    input.write(
      `${changed} rows restored for a release that reads the legacy columns; the next migration step moves the lists into rows again`
    );
    return changed;
  });
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write("verify-permissions needs DATABASE_URL\n");
    process.exit(2);
  }
  const write = (line: string) => process.stdout.write(`${line}\n`);
  try {
    if (process.argv.includes("--restore-legacy-columns")) {
      const sql = postgres(databaseUrl, { max: 1, onnotice() {} });
      try {
        await restoreLegacyColumns({ sql, write });
        process.exitCode = 0;
      } finally {
        await sql.end();
      }
    } else {
      process.exitCode = await runVerifyPermissions({ databaseUrl, write });
    }
  } catch (error) {
    // The message of a connection error can repeat the connection string.
    const name = error instanceof Error ? error.name : "UnknownError";
    const code =
      typeof error === "object" && error !== null && "code" in error ? String(error.code) : "none";
    process.stderr.write(`verify-permissions could not run (${name}, code ${code})\n`);
    process.exit(2);
  }
}
