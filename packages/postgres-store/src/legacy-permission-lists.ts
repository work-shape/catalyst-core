import { and, eq, inArray, sql } from "drizzle-orm";
import {
  LEGACY_PERMISSION_ACTIONS,
  PERMISSIONS,
  createPlatformId,
  legacyGrantChange,
  legacyPermissionList,
  type ClientInstanceId,
  type PermissionGrant
} from "@vivd-catalyst/core";
import type { PostgresConnection, PostgresTransaction } from "./postgres-database";
import { permissionGrants } from "./schema";

// The legacy permission list of a user or a service principal is a view of the holder's
// instance-wide grant rows. The rows are the one source; the columns `permissions` of
// `product_users` and `service_principals` keep what they held when the rows were written
// from them, are no longer written, and stay for one release so that the previous release
// can still be rolled back to (`scripts/verify-permissions.ts --restore-legacy-columns`).

type LegacyHolderKind = Extract<PermissionGrant["holderKind"], "user" | "service_principal">;

const LEGACY_ACTIONS: string[] = PERMISSIONS.flatMap((key) => [...LEGACY_PERMISSION_ACTIONS[key]]);

/** The legacy list of each holder, by id. A holder without rows has an empty list. */
export async function legacyPermissionLists(
  db: PostgresConnection | PostgresTransaction,
  input: { clientInstanceId: ClientInstanceId; holderKind: LegacyHolderKind; holderIds: string[] }
): Promise<Map<string, string[]>> {
  const lists = new Map<string, string[]>();
  if (input.holderIds.length === 0) return lists;
  const rows = await db
    .select({
      holderId: permissionGrants.holderId,
      action: permissionGrants.action,
      effect: permissionGrants.effect,
      scopeKind: permissionGrants.scopeKind
    })
    .from(permissionGrants)
    .where(
      and(
        eq(permissionGrants.clientInstanceId, input.clientInstanceId),
        eq(permissionGrants.holderKind, input.holderKind),
        inArray(permissionGrants.holderId, [...new Set(input.holderIds)]),
        eq(permissionGrants.scopeKind, "instance"),
        inArray(permissionGrants.action, LEGACY_ACTIONS)
      )
    );
  for (const holderId of input.holderIds) {
    lists.set(holderId, legacyPermissionList(rows.filter((row) => row.holderId === holderId)));
  }
  return lists;
}

/** The legacy list of one holder. */
export async function legacyPermissionListOf(
  db: PostgresConnection | PostgresTransaction,
  input: { clientInstanceId: ClientInstanceId; holderKind: LegacyHolderKind; holderId: string }
): Promise<string[]> {
  const lists = await legacyPermissionLists(db, { ...input, holderIds: [input.holderId] });
  return lists.get(input.holderId) ?? [];
}

/**
 * Writes the rows a submitted legacy list stands for, in the caller's transaction. Only the
 * keys whose state the list changes are rewritten, so an unchanged right keeps who granted it
 * and when. An entry that is not a key is not a right and writes nothing.
 */
export async function writeLegacyPermissionList(
  tx: PostgresTransaction,
  input: {
    clientInstanceId: ClientInstanceId;
    holderKind: LegacyHolderKind;
    holderId: string;
    entries: readonly string[];
    grantedBy: string;
  }
): Promise<void> {
  // One writer of a holder's rows at a time, so two saves of one list cannot both add a row.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`access:${input.clientInstanceId}`}, 0))`
  );
  const rows = await tx
    .select({
      action: permissionGrants.action,
      effect: permissionGrants.effect,
      scopeKind: permissionGrants.scopeKind
    })
    .from(permissionGrants)
    .where(
      and(
        eq(permissionGrants.clientInstanceId, input.clientInstanceId),
        eq(permissionGrants.holderKind, input.holderKind),
        eq(permissionGrants.holderId, input.holderId),
        eq(permissionGrants.scopeKind, "instance"),
        inArray(permissionGrants.action, LEGACY_ACTIONS)
      )
    );
  const change = legacyGrantChange(rows, input.entries);
  if (change.remove.length > 0) {
    await tx
      .delete(permissionGrants)
      .where(
        and(
          eq(permissionGrants.clientInstanceId, input.clientInstanceId),
          eq(permissionGrants.holderKind, input.holderKind),
          eq(permissionGrants.holderId, input.holderId),
          eq(permissionGrants.scopeKind, "instance"),
          inArray(permissionGrants.action, change.remove)
        )
      );
  }
  if (change.add.length > 0) {
    const createdAt = new Date();
    await tx.insert(permissionGrants).values(
      change.add.map((row) => ({
        id: createPlatformId("grant"),
        clientInstanceId: input.clientInstanceId,
        holderKind: input.holderKind,
        holderId: input.holderId,
        action: row.action,
        effect: row.effect,
        scopeKind: "instance" as const,
        scopeId: null,
        namespace: null,
        grantedBy: input.grantedBy,
        createdAt
      }))
    );
  }
}
