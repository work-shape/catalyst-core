import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  AppError,
  asClientInstanceId,
  asUserId,
  createPlatformId,
  userInDeletionError,
  type AccessAdministrationStore,
  type Namespace,
  type NamespaceUsage,
  type PermissionGrant
} from "@work-shape/catalyst-core";
import { keysetFilter } from "./paging";
import type { PostgresConnection } from "./postgres-database";
import { lockRights } from "./rights-lock";
import {
  collaborationWorkspaces,
  configAssets,
  namespaces,
  permissionGrants,
  productUsers,
  servicePrincipals
} from "./schema";

type GrantRow = typeof permissionGrants.$inferSelect;
type NamespaceRow = typeof namespaces.$inferSelect;

/** `inTransaction` is true for the store of a transaction, the only one that holds a lock. */
export function createPostgresAccessStore(
  db: PostgresConnection,
  inTransaction = false
): AccessAdministrationStore {
  return {
    async lockRights(input) {
      if (!inTransaction) {
        throw new AppError("INTERNAL", "The rights are held inside a transaction only");
      }
      await lockRights(db, input);
    },

    async loadPersistedAccess(input) {
      const [holder, grantRows] = await Promise.all([
        input.holder.kind === "user"
          ? db
              .select({
                // A user whose deletion was requested holds nothing any more.
                status: sql<string>`case when ${productUsers.deletionRequestedAt} is null
                  then ${productUsers.status} else 'deleting' end`,
                // The holder's memberships, read with the holder: one index range, and no
                // statement of its own on a path every call takes.
                memberWorkspaceIds: sql<string[]>`coalesce((
                  select array_agg(membership.collaboration_workspace_id)
                  from collaboration_workspace_memberships membership
                  where membership.client_instance_id = ${input.clientInstanceId}
                    and membership.user_id = ${input.holder.id}
                ), '{}'::text[])`
              })
              .from(productUsers)
              .where(
                and(
                  eq(productUsers.clientInstanceId, input.clientInstanceId),
                  eq(productUsers.id, input.holder.id)
                )
              )
              .limit(1)
          : db
              // A service principal is a member of no workspace.
              .select({
                status: servicePrincipals.status,
                memberWorkspaceIds: sql<string[]>`'{}'::text[]`
              })
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
        // A grant row is written for a service principal the instance has and goes with it.
        // One that names a principal without a record answers for nobody.
        grants:
          input.holder.kind === "service_principal" && holder[0] === undefined
            ? []
            : grantRows.map(mapGrant),
        memberWorkspaceIds: holder[0]?.memberWorkspaceIds ?? []
      };
    },

    async createGrant(input) {
      return db.transaction(async (tx) => {
        await lockRights(tx, {
          clientInstanceId: input.clientInstanceId,
          ...(input.holderKind === "user" ? { userId: input.holderId } : {})
        });
        if (input.holderKind === "user") {
          // Held until the row is written: the deletion of the user removes the rows the
          // user holds, so none may appear once it was requested.
          const [holder] = await tx
            .select({ deletionRequestedAt: productUsers.deletionRequestedAt })
            .from(productUsers)
            .where(
              and(
                eq(productUsers.clientInstanceId, input.clientInstanceId),
                eq(productUsers.id, input.holderId)
              )
            );
          if (holder && holder.deletionRequestedAt !== null) throw userInDeletionError();
        }
        if (input.holderKind === "service_principal") {
          // Held until the row is written: the deletion of the principal removes the rows
          // it holds, so none may appear for a principal that is gone.
          const [holder] = await tx
            .select({ id: servicePrincipals.id })
            .from(servicePrincipals)
            .where(
              and(
                eq(servicePrincipals.clientInstanceId, input.clientInstanceId),
                eq(servicePrincipals.id, input.holderId)
              )
            )
            .for("share");
          if (!holder) {
            throw new AppError("NOT_FOUND", "Service principal not found", {
              reason: "unknown_holder"
            });
          }
        }
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
        if (input.scopeKind === "workspace") {
          // What a Shared Workspace owns. A Personal Workspace is one person's and shares
          // nothing. Held until the row is written: the deletion of the workspace removes
          // the rows that name it, so none may appear once it was requested.
          const [workspace] = await tx
            .select({ id: collaborationWorkspaces.id })
            .from(collaborationWorkspaces)
            .where(
              and(
                eq(collaborationWorkspaces.clientInstanceId, input.clientInstanceId),
                eq(collaborationWorkspaces.id, input.scopeId ?? ""),
                eq(collaborationWorkspaces.kind, "shared"),
                isNull(collaborationWorkspaces.deletionRequestedAt)
              )
            )
            .for("share");
          if (!workspace) {
            throw new AppError(
              "VALIDATION_FAILED",
              "The workspace is not a Shared Workspace of this instance",
              { reason: "invalid_scope" }
            );
          }
        }
        if (input.scopeKind === "asset") {
          // Held until the row is written: the deletion of the asset removes the allows on
          // it and waits for this lock, so a row written beside a delete is removed by it,
          // and none is written for an asset that is already gone. The row of a deleted
          // asset is reused by the next asset of that name.
          const [asset] = await tx
            .select({ id: configAssets.id })
            .from(configAssets)
            .where(
              and(
                eq(configAssets.clientInstanceId, input.clientInstanceId),
                eq(configAssets.id, input.scopeId ?? ""),
                eq(configAssets.status, "active")
              )
            )
            .for("share");
          if (!asset) {
            throw new AppError("VALIDATION_FAILED", "The asset is not an asset of this instance", {
              reason: "invalid_scope"
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
      return db.transaction(async (tx) => {
        // Lifting a deny gives as much as an allow does: it waits for and is waited for by
        // every other write of rights, the user's own lock included.
        await lockRights(tx, { clientInstanceId: input.clientInstanceId });
        const where = and(
          eq(permissionGrants.clientInstanceId, input.clientInstanceId),
          eq(permissionGrants.id, input.grantId)
        );
        const [existing] = await tx
          .select({ holderKind: permissionGrants.holderKind, holderId: permissionGrants.holderId })
          .from(permissionGrants)
          .where(where);
        if (existing?.holderKind === "user") {
          await lockRights(tx, {
            clientInstanceId: input.clientInstanceId,
            userId: existing.holderId
          });
        }
        const [row] = await tx.delete(permissionGrants).where(where).returning();
        return row ? mapGrant(row) : undefined;
      });
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
            input.scopeId ? eq(permissionGrants.scopeId, input.scopeId) : undefined,
            input.excludeSuperadminHolders
              ? sql`NOT (${permissionGrants.holderKind} = 'user' AND EXISTS (
                  SELECT 1 FROM ${productUsers}
                  WHERE ${productUsers.clientInstanceId} = ${permissionGrants.clientInstanceId}
                    AND ${productUsers.id} = ${permissionGrants.holderId}
                    AND ${productUsers.roles} @> '["superadmin"]'::jsonb))`
              : undefined,
            input.excludeServicePrincipalHolders
              ? ne(permissionGrants.holderKind, "service_principal")
              : undefined,
            input.excludeInstanceScope ? ne(permissionGrants.scopeKind, "instance") : undefined,
            keysetFilter(input.page, order, false)
          )
        )
        .orderBy(...order)
        .limit(input.page?.limit ?? 2147483647);
      return rows.map(mapGrant);
    },

    async createNamespace(input) {
      return db.transaction(async (tx) => {
        await lockRights(tx, { clientInstanceId: input.clientInstanceId });
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
        await lockRights(tx, { clientInstanceId: input.clientInstanceId });
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

    async listNamespaceRecords(input) {
      const rows = await db
        .select()
        .from(namespaces)
        .where(eq(namespaces.clientInstanceId, input.clientInstanceId))
        .orderBy(sql`${namespaces.prefix} COLLATE "C"`);
      return rows.map(mapNamespace);
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
        .select({
          id: configAssets.id,
          kind: configAssets.kind,
          name: configAssets.name,
          scopeKind: configAssets.scopeKind,
          scopeId: configAssets.scopeId
        })
        .from(configAssets)
        .where(
          and(
            eq(configAssets.clientInstanceId, input.clientInstanceId),
            eq(configAssets.id, input.assetId),
            eq(configAssets.status, "active")
          )
        )
        .limit(1);
      return row && { id: row.id, kind: row.kind, name: row.name, ...assetOwner(row) };
    },

    async listGrantScopeAssets(input) {
      if (input.assetIds.length === 0) {
        return [];
      }
      const rows = await db
        .select({
          id: configAssets.id,
          kind: configAssets.kind,
          name: configAssets.name,
          status: configAssets.status,
          scopeKind: configAssets.scopeKind,
          scopeId: configAssets.scopeId
        })
        .from(configAssets)
        .where(
          and(
            eq(configAssets.clientInstanceId, input.clientInstanceId),
            inArray(configAssets.id, [...new Set(input.assetIds)])
          )
        );
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        name: row.name,
        active: row.status === "active",
        ...assetOwner(row)
      }));
    }
  };
}

/** The workspace that owns an asset, where one does. */
function assetOwner(row: { scopeKind: string; scopeId: string | null }): { workspaceId?: string } {
  return row.scopeKind === "workspace" && row.scopeId !== null ? { workspaceId: row.scopeId } : {};
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
