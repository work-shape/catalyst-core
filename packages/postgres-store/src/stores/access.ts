import { and, asc, eq, sql } from "drizzle-orm";
import {
  AppError,
  asClientInstanceId,
  asUserId,
  createPlatformId,
  type AccessAdministrationStore,
  type ClientInstanceId,
  type Namespace,
  type NamespaceUsage,
  type PermissionGrant
} from "@vivd-catalyst/core";
import { keysetFilter } from "../paging";
import type { PostgresConnection, PostgresTransaction } from "../postgres-database";
import {
  configAssets,
  namespaces,
  permissionGrants,
  productUsers,
  servicePrincipals
} from "../schema";

type GrantRow = typeof permissionGrants.$inferSelect;
type NamespaceRow = typeof namespaces.$inferSelect;

export function createPostgresAccessStore(db: PostgresConnection): AccessAdministrationStore {
  return {
    async loadPersistedAccess(input) {
      const [holder, grantRows] = await Promise.all([
        input.holder.kind === "user"
          ? db
              .select({ status: productUsers.status })
              .from(productUsers)
              .where(
                and(
                  eq(productUsers.clientInstanceId, input.clientInstanceId),
                  eq(productUsers.id, input.holder.id)
                )
              )
              .limit(1)
          : db
              .select({ status: servicePrincipals.status })
              .from(servicePrincipals)
              .where(
                and(
                  eq(servicePrincipals.clientInstanceId, input.clientInstanceId),
                  eq(servicePrincipals.id, input.holder.id)
                )
              )
              .limit(1),
        db
          .select()
          .from(permissionGrants)
          .where(
            and(
              eq(permissionGrants.clientInstanceId, input.clientInstanceId),
              eq(permissionGrants.holderKind, input.holder.kind),
              eq(permissionGrants.holderId, input.holder.id)
            )
          )
      ]);
      return {
        // A holder without a record here was vouched for by the sign-in alone and has no status
        // to read; only a record that says otherwise makes a holder inactive.
        holderActive: holder[0] === undefined || holder[0].status === "active",
        grants: grantRows.map(mapGrant)
      };
    },

    async createGrant(input) {
      return db.transaction(async (tx) => {
        await lockAccess(tx, input.clientInstanceId);
        if (input.scopeKind === "namespace") {
          const [registered] = await tx
            .select({ prefix: namespaces.prefix })
            .from(namespaces)
            .where(
              and(
                eq(namespaces.clientInstanceId, input.clientInstanceId),
                eq(namespaces.prefix, input.namespace ?? "")
              )
            )
            .limit(1);
          if (!registered) {
            throw new AppError("VALIDATION_FAILED", "Namespace is not registered", {
              reason: "unknown_namespace"
            });
          }
        }
        const [row] = await tx
          .insert(permissionGrants)
          .values({
            id: createPlatformId("grant"),
            clientInstanceId: input.clientInstanceId,
            holderKind: input.holderKind,
            holderId: input.holderId,
            action: input.action,
            effect: input.effect,
            scopeKind: input.scopeKind,
            scopeId: input.scopeId ?? null,
            namespace: input.namespace ?? null,
            grantedBy: input.grantedBy,
            createdAt: new Date()
          })
          .onConflictDoNothing()
          .returning();
        if (!row) {
          throw new AppError("CONFLICT", "The holder already has a grant row for this scope", {
            reason: "duplicate_grant"
          });
        }
        return mapGrant(row);
      });
    },

    async getGrant(input) {
      const [row] = await db
        .select()
        .from(permissionGrants)
        .where(
          and(
            eq(permissionGrants.clientInstanceId, input.clientInstanceId),
            eq(permissionGrants.id, input.grantId)
          )
        )
        .limit(1);
      return row ? mapGrant(row) : undefined;
    },

    async deleteGrant(input) {
      const [row] = await db
        .delete(permissionGrants)
        .where(
          and(
            eq(permissionGrants.clientInstanceId, input.clientInstanceId),
            eq(permissionGrants.id, input.grantId)
          )
        )
        .returning();
      return row ? mapGrant(row) : undefined;
    },

    async listGrants(input) {
      const order = [
        sql`${permissionGrants.holderId} COLLATE "C"`,
        sql`${permissionGrants.id} COLLATE "C"`
      ];
      const rows = await db
        .select()
        .from(permissionGrants)
        .where(
          and(
            eq(permissionGrants.clientInstanceId, input.clientInstanceId),
            input.holderKind ? eq(permissionGrants.holderKind, input.holderKind) : undefined,
            input.holderId ? eq(permissionGrants.holderId, input.holderId) : undefined,
            input.action ? eq(permissionGrants.action, input.action) : undefined,
            input.scopeKind ? eq(permissionGrants.scopeKind, input.scopeKind) : undefined,
            input.excludeSuperadminHolders
              ? sql`NOT (${permissionGrants.holderKind} = 'user' AND EXISTS (
                  SELECT 1 FROM ${productUsers}
                  WHERE ${productUsers.clientInstanceId} = ${permissionGrants.clientInstanceId}
                    AND ${productUsers.id} = ${permissionGrants.holderId}
                    AND ${productUsers.roles} @> '["superadmin"]'::jsonb))`
              : undefined,
            keysetFilter(input.page, order, false)
          )
        )
        .orderBy(...order)
        .limit(input.page?.limit ?? 2147483647);
      return rows.map(mapGrant);
    },

    async createNamespace(input) {
      return db.transaction(async (tx) => {
        await lockAccess(tx, input.clientInstanceId);
        // Two prefixes overlap when either one starts with the other.
        const [overlapping] = await tx
          .select({ prefix: namespaces.prefix })
          .from(namespaces)
          .where(
            and(
              eq(namespaces.clientInstanceId, input.clientInstanceId),
              sql`(starts_with(${input.prefix}, ${namespaces.prefix}) or starts_with(${namespaces.prefix}, ${input.prefix}))`
            )
          )
          .orderBy(asc(namespaces.prefix))
          .limit(1);
        if (overlapping) {
          throw new AppError(
            "CONFLICT",
            `Namespace '${input.prefix}' overlaps the registered Namespace '${overlapping.prefix}'`,
            { reason: "namespace_overlap", prefix: overlapping.prefix }
          );
        }
        const [row] = await tx
          .insert(namespaces)
          .values({
            clientInstanceId: input.clientInstanceId,
            prefix: input.prefix,
            displayName: input.displayName,
            allowedToolNames: input.allowedToolNames ?? null,
            allowedModelBindingIds: input.allowedModelBindingIds ?? null,
            createdBy: input.createdBy,
            createdAt: new Date()
          })
          .returning();
        if (!row) {
          throw new AppError("INTERNAL", "Namespace was not stored");
        }
        return mapNamespace(row);
      });
    },

    async updateNamespace(input) {
      const set: Partial<typeof namespaces.$inferInsert> = {};
      if (input.displayName !== undefined) set.displayName = input.displayName;
      if (input.allowedToolNames !== undefined) set.allowedToolNames = input.allowedToolNames;
      if (input.allowedModelBindingIds !== undefined)
        set.allowedModelBindingIds = input.allowedModelBindingIds;
      const where = and(
        eq(namespaces.clientInstanceId, input.clientInstanceId),
        eq(namespaces.prefix, input.prefix)
      );
      const [row] =
        Object.keys(set).length === 0
          ? await db.select().from(namespaces).where(where).limit(1)
          : await db.update(namespaces).set(set).where(where).returning();
      return row ? mapNamespace(row) : undefined;
    },

    async deleteNamespace(input) {
      return db.transaction(async (tx) => {
        await lockAccess(tx, input.clientInstanceId);
        const [referenced] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(permissionGrants)
          .where(
            and(
              eq(permissionGrants.clientInstanceId, input.clientInstanceId),
              eq(permissionGrants.namespace, input.prefix)
            )
          );
        const grantCount = referenced?.count ?? 0;
        if (grantCount > 0) {
          throw new AppError(
            "CONFLICT",
            `Namespace '${input.prefix}' is named by ${grantCount} grant row${grantCount === 1 ? "" : "s"}`,
            { reason: "namespace_in_use", grantCount }
          );
        }
        const [row] = await tx
          .delete(namespaces)
          .where(
            and(
              eq(namespaces.clientInstanceId, input.clientInstanceId),
              eq(namespaces.prefix, input.prefix)
            )
          )
          .returning();
        return row ? mapNamespace(row) : undefined;
      });
    },

    async listNamespaces(input) {
      const rows = await db
        .select({
          namespace: namespaces,
          grantCount: sql<number>`(
            select count(*)::int from ${permissionGrants}
            where ${permissionGrants.clientInstanceId} = ${namespaces.clientInstanceId}
              and ${permissionGrants.namespace} = ${namespaces.prefix}
          )`,
          assetCount: sql<number>`(
            select count(*)::int from ${configAssets}
            where ${configAssets.clientInstanceId} = ${namespaces.clientInstanceId}
              and ${configAssets.status} = 'active'
              and starts_with(${configAssets.name}, ${namespaces.prefix})
          )`
        })
        .from(namespaces)
        .where(eq(namespaces.clientInstanceId, input.clientInstanceId))
        .orderBy(sql`${namespaces.prefix} COLLATE "C"`);
      return rows.map((row): NamespaceUsage => ({
        ...mapNamespace(row.namespace),
        grantCount: row.grantCount,
        assetCount: row.assetCount
      }));
    },

    async getGrantableAsset(input) {
      const [row] = await db
        .select({ id: configAssets.id, kind: configAssets.kind, name: configAssets.name })
        .from(configAssets)
        .where(
          and(
            eq(configAssets.clientInstanceId, input.clientInstanceId),
            eq(configAssets.id, input.assetId),
            eq(configAssets.status, "active")
          )
        )
        .limit(1);
      return row;
    }
  };
}

/**
 * One writer at a time per client instance for what must hold across rows: prefixes do not
 * overlap, and a grant names a registered Namespace.
 */
async function lockAccess(tx: PostgresTransaction, clientInstanceId: ClientInstanceId) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`access:${clientInstanceId}`}, 0))`
  );
}

function mapGrant(row: GrantRow): PermissionGrant {
  return {
    id: row.id,
    clientInstanceId: asClientInstanceId(row.clientInstanceId),
    holderKind: row.holderKind,
    holderId: row.holderId,
    action: row.action,
    effect: row.effect,
    scopeKind: row.scopeKind,
    ...(row.scopeId === null ? {} : { scopeId: row.scopeId }),
    ...(row.namespace === null ? {} : { namespace: row.namespace }),
    grantedBy: asUserId(row.grantedBy),
    createdAt: row.createdAt.toISOString()
  };
}

function mapNamespace(row: NamespaceRow): Namespace {
  return {
    clientInstanceId: asClientInstanceId(row.clientInstanceId),
    prefix: row.prefix,
    displayName: row.displayName,
    ...(row.allowedToolNames === null ? {} : { allowedToolNames: row.allowedToolNames }),
    ...(row.allowedModelBindingIds === null
      ? {}
      : { allowedModelBindingIds: row.allowedModelBindingIds }),
    createdBy: asUserId(row.createdBy),
    createdAt: row.createdAt.toISOString()
  };
}
