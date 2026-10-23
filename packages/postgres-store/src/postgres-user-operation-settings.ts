import { and, asc, eq } from "drizzle-orm";
import type { UserOperationSettingStore } from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { userOperationSettings } from "./schema/users";

type Input<Method extends keyof UserOperationSettingStore> = Parameters<
  UserOperationSettingStore[Method]
>[0];

/** At most so many settings of one person are read at once: one per operation they set. */
const SETTINGS_MAX = 1_000;

// A person's own confirmation settings (OP-6), read and written for that person alone.

function ofPerson(input: { clientInstanceId: string; userId: string }) {
  return and(
    eq(userOperationSettings.clientInstanceId, input.clientInstanceId),
    eq(userOperationSettings.userId, input.userId)
  );
}

export function createPostgresUserOperationSettingsStore(
  db: PostgresConnection
): UserOperationSettingStore {
  return {
    async list(input) {
      const rows = await db
        .select()
        .from(userOperationSettings)
        .where(ofPerson(input))
        .orderBy(asc(userOperationSettings.operation))
        .limit(SETTINGS_MAX);
      return rows.map((row) => ({
        operation: row.operation,
        value: row.value,
        updatedAt: row.updatedAt.toISOString()
      }));
    },
    async get(input: Input<"get">) {
      const [row] = await db
        .select({ value: userOperationSettings.value })
        .from(userOperationSettings)
        .where(and(ofPerson(input), eq(userOperationSettings.operation, input.operation)))
        .limit(1);
      return row?.value;
    },
    async set(input: Input<"set">) {
      return db.transaction(async (tx) => {
        const where = and(ofPerson(input), eq(userOperationSettings.operation, input.operation));
        const [before] = await tx
          .select({ value: userOperationSettings.value })
          .from(userOperationSettings)
          .where(where)
          .for("update")
          .limit(1);
        if (input.value === null) {
          await tx.delete(userOperationSettings).where(where);
        } else {
          const updatedAt = new Date(input.at);
          await tx
            .insert(userOperationSettings)
            .values({
              clientInstanceId: input.clientInstanceId,
              userId: input.userId,
              operation: input.operation,
              value: input.value,
              updatedAt
            })
            .onConflictDoUpdate({
              target: [
                userOperationSettings.clientInstanceId,
                userOperationSettings.userId,
                userOperationSettings.operation
              ],
              set: { value: input.value, updatedAt }
            });
        }
        return { previous: before?.value };
      });
    }
  };
}
