import { and, asc, eq, isNull, type SQL } from "drizzle-orm";
import type { CentralPolicySettingStore } from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { alwaysAllowLocks, centralPolicySettings } from "./schema/policy";

type Input<Method extends keyof CentralPolicySettingStore> = Parameters<
  CentralPolicySettingStore[Method]
>[0];

/**
 * At most so many settings and locks are read at once. Every call reads them, so an instance
 * that needs more has a policy no admin can read either.
 */
const ENTRIES_MAX = 2_000;

/** A column that equals the value, or is null where the value is absent. */
function sameOrNull(
  column: typeof centralPolicySettings.workspaceId | typeof centralPolicySettings.assetKind,
  value: string | undefined
) {
  return value === undefined ? isNull(column) : eq(column, value);
}

export function createPostgresCentralPolicySettingsStore(
  db: PostgresConnection
): CentralPolicySettingStore {
  return {
    async list(input) {
      const rows = await db
        .select()
        .from(centralPolicySettings)
        .where(eq(centralPolicySettings.clientInstanceId, input.clientInstanceId))
        .orderBy(
          asc(centralPolicySettings.operation),
          asc(centralPolicySettings.workspaceId),
          asc(centralPolicySettings.assetKind)
        )
        .limit(ENTRIES_MAX);
      return rows.map((row) => ({
        operation: row.operation,
        value: row.value,
        ...(row.workspaceId === null ? {} : { workspaceId: row.workspaceId }),
        ...(row.assetKind === null ? {} : { assetKind: row.assetKind }),
        updatedAt: row.updatedAt.toISOString()
      }));
    },
    async set(input: Input<"set">) {
      return db.transaction(async (tx) => {
        const where: SQL | undefined = and(
          eq(centralPolicySettings.clientInstanceId, input.clientInstanceId),
          eq(centralPolicySettings.operation, input.operation),
          sameOrNull(centralPolicySettings.workspaceId, input.workspaceId),
          sameOrNull(centralPolicySettings.assetKind, input.assetKind)
        );
        const [before] = await tx
          .select({ value: centralPolicySettings.value })
          .from(centralPolicySettings)
          .where(where)
          .for("update")
          .limit(1);
        const updatedAt = new Date(input.at);
        if (input.value === null) {
          await tx.delete(centralPolicySettings).where(where);
        } else if (before) {
          await tx
            .update(centralPolicySettings)
            .set({ value: input.value, updatedAt })
            .where(where);
        } else {
          await tx.insert(centralPolicySettings).values({
            clientInstanceId: input.clientInstanceId,
            operation: input.operation,
            workspaceId: input.workspaceId ?? null,
            assetKind: input.assetKind ?? null,
            value: input.value,
            updatedAt
          });
        }
        return { previous: before?.value };
      });
    },
    async listLocks(input) {
      const rows = await db
        .select()
        .from(alwaysAllowLocks)
        .where(eq(alwaysAllowLocks.clientInstanceId, input.clientInstanceId))
        .orderBy(asc(alwaysAllowLocks.operation))
        .limit(ENTRIES_MAX);
      return rows.map((row) => ({
        operation: row.operation,
        updatedAt: row.updatedAt.toISOString()
      }));
    },
    async setLock(input: Input<"setLock">) {
      const where = and(
        eq(alwaysAllowLocks.clientInstanceId, input.clientInstanceId),
        eq(alwaysAllowLocks.operation, input.operation)
      );
      if (!input.locked) {
        const removed = await db
          .delete(alwaysAllowLocks)
          .where(where)
          .returning({ operation: alwaysAllowLocks.operation });
        return { wasLocked: removed.length > 0 };
      }
      const inserted = await db
        .insert(alwaysAllowLocks)
        .values({
          clientInstanceId: input.clientInstanceId,
          operation: input.operation,
          updatedAt: new Date(input.at)
        })
        .onConflictDoNothing()
        .returning({ operation: alwaysAllowLocks.operation });
      return { wasLocked: inserted.length === 0 };
    }
  };
}
