import { and, eq, inArray, isNull, ne, notInArray, or, sql, type SQLWrapper } from "drizzle-orm";
import {
  AppError,
  LEGACY_PERMISSION_ACTIONS,
  MAIL_SENDER_SYSTEM,
  MAIL_SENDER_USE_ACTION,
  PERMISSIONS,
  asClientInstanceId,
  asUserId,
  createPlatformId,
  userInDeletionError,
  type AccessAdministrationStore,
  type PersistedAccess,
  type PermissionGrant
} from "@work-shape/catalyst-core";
import { scopeAssignments } from "./schema/dataScopes";
import { keysetFilter } from "./paging";
import type { PostgresConnection } from "./postgres-database";
import { lockRights } from "./rights-lock";
import {
  collaborationWorkspaces,
  configAssets,
  permissionGrants,
  productUsers,
  servicePrincipals
} from "./schema";

type GrantRow = typeof permissionGrants.$inferSelect;

/** The actions a legacy key carries: their instance-wide rows are the legacy lists. */
const LEGACY_KEY_ACTIONS: string[] = PERMISSIONS.flatMap((key) => [
  ...LEGACY_PERMISSION_ACTIONS[key]
]);

/** One membership rule for runtime rights and the audience read, against asset/availability aliases. */
function availableThroughMembership(
  clientInstanceId: string,
  userId: string | SQLWrapper,
  workspaceId?: string | null
) {
  return sql`exists (
    select 1 from collaboration_workspace_memberships membership
    join collaboration_workspaces workspace on workspace.id = membership.collaboration_workspace_id
    where membership.client_instance_id = ${clientInstanceId}
      and membership.user_id = ${userId}
      and (${workspaceId === undefined} or membership.collaboration_workspace_id = ${workspaceId ?? null})
      and (availability.mode = 'all'
        or (availability.personal_workspaces and workspace.kind = 'personal')
        or exists (select 1 from config_asset_workspace_availability selected
          where selected.asset_id = asset.id and selected.collaboration_workspace_id = workspace.id))
  )`;
}

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
      const scopeRows = sql<NonNullable<PersistedAccess["scopeAssignments"]>>`coalesce((
        select jsonb_agg(jsonb_build_object('dimension', a.dimension, 'holderKind', a.holder_kind,
          'holderId', a.holder_id, 'effect', a.effect, 'values', a.values))
        from scope_assignments a where a.client_instance_id = ${input.clientInstanceId}
          and ((a.holder_kind = ${input.holder.kind} and a.holder_id = ${input.holder.id})
            or (${input.holder.kind === "user"} and a.holder_kind = 'group' and a.holder_id in (select jsonb_array_elements_text(u.groups) from product_users u where u.client_instance_id = ${input.clientInstanceId} and u.id = ${input.holder.id})))
      ), '[]'::jsonb)`;
      const [holder, grantRows] = await Promise.all([
        input.holder.kind === "user"
          ? db
              .select({
                // A user whose deletion was requested holds nothing any more.
                scopeAssignments: scopeRows,
                status: sql<string>`case when ${productUsers.deletionRequestedAt} is null
                  then ${productUsers.status} else 'deleting' end`,
                // The holder's memberships, read with the holder: one index range, and no
                // statement of its own on a path every call takes.
                memberWorkspaceIds: sql<string[]>`coalesce((
                  select array_agg(membership.collaboration_workspace_id)
                  from collaboration_workspace_memberships membership
                  where membership.client_instance_id = ${input.clientInstanceId}
                    and membership.user_id = ${input.holder.id}
                ), '{}'::text[])`,
                // Availability contributes use through a current workspace membership. Read
                // it with the holder, keeping authorization at two statements per call.
                availableAssets: sql<NonNullable<PersistedAccess["availableAssets"]>>`coalesce((
                  select jsonb_agg(jsonb_build_object('assetId', asset.id, 'kind', asset.kind))
                  from config_assets asset
                  join config_asset_availability availability on availability.asset_id = asset.id
                  where asset.client_instance_id = ${input.clientInstanceId}
                    and availability.client_instance_id = ${input.clientInstanceId}
                    and asset.status = 'active' and asset.kind in ('knowledge_base', 'connection')
                    and ${availableThroughMembership(input.clientInstanceId, input.holder.id, input.workspaceId)}
                ), '[]'::jsonb)`,
                // The holder's roles that have a row; their grants come with the holder's own.
                storedRoleIds: sql<string[]>`coalesce((
                  select array_agg(role.id) from roles role
                  where role.client_instance_id = ${input.clientInstanceId}
                    and ${productUsers.roles} ? role.id
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
                scopeAssignments: scopeRows,
                status: servicePrincipals.status,
                memberWorkspaceIds: sql<string[]>`'{}'::text[]`,
                availableAssets: sql<NonNullable<PersistedAccess["availableAssets"]>>`'[]'::jsonb`,
                storedRoleIds: sql<string[]>`'{}'::text[]`
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
              or(
                and(
                  eq(permissionGrants.holderKind, input.holder.kind),
                  eq(permissionGrants.holderId, input.holder.id)
                ),
                // A person's roles hold rows too, read by the same index in the same statement.
                input.holder.kind === "user"
                  ? and(
                      eq(permissionGrants.holderKind, "role"),
                      sql`${permissionGrants.holderId} in (
                        select jsonb_array_elements_text(holder.roles) from product_users holder
                        where holder.client_instance_id = ${input.clientInstanceId}
                          and holder.id = ${input.holder.id})`
                    )
                  : undefined
              )
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
        memberWorkspaceIds: holder[0]?.memberWorkspaceIds ?? [],
        availableAssets: holder[0]?.availableAssets ?? [],
        scopeAssignments: holder[0]?.scopeAssignments ?? [],
        storedRoleIds: holder[0]?.storedRoleIds ?? []
      };
    },

    async listScopeAssignments({ clientInstanceId, holderKind, holderId }) {
      return db
        .select({
          dimension: scopeAssignments.dimension,
          holderKind: scopeAssignments.holderKind,
          holderId: scopeAssignments.holderId,
          effect: scopeAssignments.effect,
          values: scopeAssignments.values
        })
        .from(scopeAssignments)
        .where(
          and(
            eq(scopeAssignments.clientInstanceId, clientInstanceId),
            eq(scopeAssignments.holderKind, holderKind),
            eq(scopeAssignments.holderId, holderId)
          )
        );
    },
    async setScopeAssignment(input) {
      if (input.holderKind === "user") {
        const [holder] = await db
          .select({ status: productUsers.status, deleting: productUsers.deletionRequestedAt })
          .from(productUsers)
          .where(
            and(
              eq(productUsers.clientInstanceId, input.clientInstanceId),
              eq(productUsers.id, input.holderId)
            )
          )
          .limit(1);
        if (!holder || holder.status !== "active" || holder.deleting)
          throw new AppError("NOT_FOUND", "Active user not found");
      } else if (input.holderKind === "service_principal") {
        const [holder] = await db
          .select({ status: servicePrincipals.status })
          .from(servicePrincipals)
          .where(
            and(
              eq(servicePrincipals.clientInstanceId, input.clientInstanceId),
              eq(servicePrincipals.id, input.holderId)
            )
          )
          .limit(1);
        if (!holder || holder.status !== "active")
          throw new AppError("NOT_FOUND", "Active service principal not found");
      }
      await db
        .insert(scopeAssignments)
        .values(input)
        .onConflictDoUpdate({
          target: [
            scopeAssignments.clientInstanceId,
            scopeAssignments.holderKind,
            scopeAssignments.holderId,
            scopeAssignments.dimension,
            scopeAssignments.effect
          ],
          set: { values: input.values }
        });
    },
    async listAvailabilityMembers(input) {
      const order = [sql`${productUsers.displayLabel} COLLATE "C"`, productUsers.id];
      const members = await db
        .select({ userId: productUsers.id, displayLabel: productUsers.displayLabel })
        .from(productUsers)
        .where(
          and(
            eq(productUsers.clientInstanceId, input.clientInstanceId),
            eq(productUsers.status, "active"),
            isNull(productUsers.deletionRequestedAt),
            // Role-default administrators are already part of every audience, as before.
            sql`not (${productUsers.roles} @> '["admin"]'::jsonb or ${productUsers.roles} @> '["superadmin"]'::jsonb)`,
            sql`exists (select 1 from config_assets asset join config_asset_availability availability on availability.asset_id = asset.id
          where asset.id = ${input.assetId} and asset.client_instance_id = ${input.clientInstanceId}
            and availability.client_instance_id = ${input.clientInstanceId} and asset.status = 'active'
            and ${availableThroughMembership(input.clientInstanceId, productUsers.id)})`,
            keysetFilter(input.page, order, false)
          )
        )
        .orderBy(...order)
        .limit(input.page.limit);
      if (!members.length) return [];
      const rows = await db
        .select()
        .from(permissionGrants)
        .where(
          and(
            eq(permissionGrants.clientInstanceId, input.clientInstanceId),
            eq(permissionGrants.holderKind, "user"),
            inArray(
              permissionGrants.holderId,
              members.map((member) => member.userId)
            ),
            eq(permissionGrants.action, input.action)
          )
        );
      const byUser = new Map<string, PermissionGrant[]>();
      for (const row of rows) {
        const list = byUser.get(row.holderId) ?? [];
        list.push(mapGrant(row));
        byUser.set(row.holderId, list);
      }
      return members.map((member) => ({
        userId: asUserId(member.userId),
        displayLabel: member.displayLabel,
        grants: byUser.get(member.userId) ?? []
      }));
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
        // The mail sender `system` is no config asset: it stands without a row, and the grant
        // write has asked that the instance registers it (MAIL-1).
        const onSystemSender =
          input.action === MAIL_SENDER_USE_ACTION && input.scopeId === MAIL_SENDER_SYSTEM;
        if (input.scopeKind === "asset" && !onSystemSender) {
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
            input.excludeOwnedPrincipalHolders
              ? sql`NOT (${permissionGrants.holderKind} = 'service_principal' AND EXISTS (
                  SELECT 1 FROM ${servicePrincipals}
                  WHERE ${servicePrincipals.clientInstanceId} = ${permissionGrants.clientInstanceId}
                    AND ${servicePrincipals.id} = ${permissionGrants.holderId}
                    AND ${servicePrincipals.ownerKind} IS NOT NULL))`
              : undefined,
            input.excludeLegacyKeyRows
              ? or(
                  ne(permissionGrants.scopeKind, "instance"),
                  notInArray(permissionGrants.action, LEGACY_KEY_ACTIONS)
                )
              : undefined,
            keysetFilter(input.page, order, false)
          )
        )
        .orderBy(...order)
        .limit(input.page?.limit ?? 2147483647);
      return rows.map(mapGrant);
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
    grantedBy: asUserId(row.grantedBy),
    createdAt: row.createdAt.toISOString()
  };
}
