import { and, asc, count, eq, isNull, sql, type SQL } from "drizzle-orm";
import {
  CENTRAL_POLICY_ENTRIES_MAX,
  type CentralPolicySettingStore
} from "@work-shape/catalyst-core";
import type { PostgresConnection, PostgresTransaction } from "./postgres-database";
import { alwaysAllowLocks, centralPolicySettings } from "./schema/policy";

type Input<Method extends keyof CentralPolicySettingStore> = Parameters<
  CentralPolicySettingStore[Method]
>[0];

/**
 * Holds a new setting or lock of one instance back until the one before it is stored, so the
 * count before an insert stays true and no instance passes `CENTRAL_POLICY_ENTRIES_MAX`.
 */
const lockInstance = (tx: PostgresTransaction, id: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`central_policy:${id}`}))`);

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
        );
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
          await lockInstance(tx, input.clientInstanceId);
          const [held] = await tx
            .select({ n: count() })
            .from(centralPolicySettings)
            .where(eq(centralPolicySettings.clientInstanceId, input.clientInstanceId));
          if ((held?.n ?? 0) >= CENTRAL_POLICY_ENTRIES_MAX)
            return { previous: undefined, full: true };
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
        .orderBy(asc(alwaysAllowLocks.operation));
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
      return db.transaction(async (tx) => {
        await lockInstance(tx, input.clientInstanceId);
        const [existing] = await tx
          .select({ operation: alwaysAllowLocks.operation })
          .from(alwaysAllowLocks)
          .where(where)
          .limit(1);
        if (existing) return { wasLocked: true };
        const [held] = await tx
          .select({ n: count() })
          .from(alwaysAllowLocks)
          .where(eq(alwaysAllowLocks.clientInstanceId, input.clientInstanceId));
        if ((held?.n ?? 0) >= CENTRAL_POLICY_ENTRIES_MAX) return { wasLocked: false, full: true };
        await tx.insert(alwaysAllowLocks).values({
          clientInstanceId: input.clientInstanceId,
          operation: input.operation,
          updatedAt: new Date(input.at)
        });
        return { wasLocked: false };
      });
    }
  };
}
