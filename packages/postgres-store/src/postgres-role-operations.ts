import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  AppError,
  ROLE_GRANT_SCOPE_KINDS,
  asClientInstanceId,
  createPlatformId,
  type RoleGrant,
  type RoleRecord,
  type RoleStore
} from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { lockRights } from "./rights-lock";
import { permissionGrants, productUsers, roles } from "./schema";

type RoleRow = typeof roles.$inferSelect;
type GrantRow = typeof permissionGrants.$inferSelect;

/** Roles and the grant rows they hold. Each write takes the rights locks first. */
export function createPostgresRoleStore(db: PostgresConnection): RoleStore {
  return {
    async listRoles(input) {
      const rows = await db
        .select()
        .from(roles)
        .where(eq(roles.clientInstanceId, input.clientInstanceId))
        .orderBy(desc(roles.builtIn), sql`${roles.name} COLLATE "C"`, asc(roles.id));
      return withGrants(db, input.clientInstanceId, rows);
    },

    async getRole(input) {
      const rows = await db
        .select()
        .from(roles)
        .where(and(eq(roles.clientInstanceId, input.clientInstanceId), eq(roles.id, input.roleId)));
      const [role] = await withGrants(db, input.clientInstanceId, rows);
      return role;
    },

    async saveRole(input) {
      return db.transaction(async (tx) => {
        await lockRights(tx, { clientInstanceId: input.clientInstanceId });
        // Every write of a role holds the lock, so no other role takes the name before commit.
        const [named] = await tx
          .select({ id: roles.id })
          .from(roles)
          .where(
            and(
              eq(roles.clientInstanceId, input.clientInstanceId),
              eq(roles.name, input.name),
              ne(roles.id, input.id)
            )
          );
        if (named) {
          throw new AppError("CONFLICT", `A role named '${input.name}' exists already`, {
            reason: "role_name_taken"
          });
        }
        const values = {
          name: input.name,
          description: input.description ?? null,
          defaultActions: input.defaultActions ?? null,
          pendingActions: input.pendingActions,
          updatedAt: new Date()
        };
        const [row] = await tx
          .insert(roles)
          .values({
            clientInstanceId: input.clientInstanceId,
            id: input.id,
            builtIn: input.builtIn,
            ...values
          })
          .onConflictDoUpdate({ target: [roles.clientInstanceId, roles.id], set: values })
          .returning();
        if (!row) throw new AppError("INTERNAL", "The role was not stored");
        await tx.delete(permissionGrants).where(roleGrantsOf(input.clientInstanceId, input.id));
        const grants =
          input.grants.length === 0
            ? []
            : await tx
                .insert(permissionGrants)
                .values(
                  input.grants.map((grant) => ({
                    id: createPlatformId("grant"),
                    clientInstanceId: input.clientInstanceId,
                    holderKind: "role" as const,
                    holderId: input.id,
                    action: grant.action,
                    effect: grant.effect,
                    scopeKind: grant.scopeKind,
                    scopeId: grant.scopeId ?? null,
                    grantedBy: input.grantedBy,
                    createdAt: new Date()
                  }))
                )
                .returning();
        return mapRole(row, grants);
      });
    },

    async deleteRole(input) {
      return db.transaction(async (tx) => {
        await lockRights(tx, { clientInstanceId: input.clientInstanceId });
        const where = and(
          eq(roles.clientInstanceId, input.clientInstanceId),
          eq(roles.id, input.roleId)
        );
        const [existing] = await tx.select().from(roles).where(where);
        if (!existing) return undefined;
        if (!existing.builtIn) {
          // A person who holds a role that is gone would hold nothing through it, without
          // anybody having taken it from them. Who removes the role takes it from them first.
          const [held] = await tx
            .select({ id: productUsers.id })
            .from(productUsers)
            .where(
              and(
                eq(productUsers.clientInstanceId, input.clientInstanceId),
                sql`${productUsers.roles} @> ${JSON.stringify([input.roleId])}::jsonb`
              )
            )
            .limit(1);
          if (held) {
            throw new AppError("CONFLICT", "The role is still held by a person", {
              reason: "role_in_use"
            });
          }
        }
        const grants = await tx
          .delete(permissionGrants)
          .where(roleGrantsOf(input.clientInstanceId, input.roleId))
          .returning();
        await tx.delete(roles).where(where);
        return mapRole(existing, grants);
      });
    }
  };
}

function roleGrantsOf(clientInstanceId: string, roleId: string) {
  return and(
    eq(permissionGrants.clientInstanceId, clientInstanceId),
    eq(permissionGrants.holderKind, "role"),
    eq(permissionGrants.holderId, roleId)
  );
}

/** The roles with their rows, read in one statement for all of them. */
async function withGrants(
  db: PostgresConnection,
  clientInstanceId: string,
  rows: readonly RoleRow[]
): Promise<RoleRecord[]> {
  if (rows.length === 0) return [];
  const grants = await db
    .select()
    .from(permissionGrants)
    .where(
      and(
        eq(permissionGrants.clientInstanceId, clientInstanceId),
        eq(permissionGrants.holderKind, "role"),
        inArray(
          permissionGrants.holderId,
          rows.map((row) => row.id)
        )
      )
    )
    .orderBy(asc(permissionGrants.action), asc(permissionGrants.id));
  return rows.map((row) =>
    mapRole(
      row,
      grants.filter((grant) => grant.holderId === row.id)
    )
  );
}

function mapRole(row: RoleRow, grants: readonly GrantRow[]): RoleRecord {
  return {
    clientInstanceId: asClientInstanceId(row.clientInstanceId),
    id: row.id,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    builtIn: row.builtIn,
    grants: grants.flatMap(mapRoleGrant),
    ...(row.defaultActions === null ? {} : { defaultActions: row.defaultActions }),
    pendingActions: row.pendingActions
  };
}

/** A role's row. Its writer puts none at another scope kind, and such a row holds nothing. */
function mapRoleGrant(row: GrantRow): RoleGrant[] {
  const scopeKind = ROLE_GRANT_SCOPE_KINDS.find((kind) => kind === row.scopeKind);
  if (scopeKind === undefined) return [];
  return [
    {
      action: row.action,
      effect: row.effect,
      scopeKind,
      ...(row.scopeId === null ? {} : { scopeId: row.scopeId })
    }
  ];
}
