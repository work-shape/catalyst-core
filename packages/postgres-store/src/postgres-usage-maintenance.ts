import { and, eq, sql as drizzleSql } from "drizzle-orm";
import type { ClientInstanceId, JsonObject } from "@vivd-catalyst/core";
import type { PostgresConnection } from "./postgres-database";
import { modelUsageMaintenance } from "./schema";

/** What a maintenance task of the usage ledger recorded of itself, such as where a backfill stands. */
export async function readModelUsageMaintenance(
  db: PostgresConnection,
  input: { clientInstanceId: ClientInstanceId; task: string }
): Promise<JsonObject | undefined> {
  const [row] = await db
    .select({ state: modelUsageMaintenance.state })
    .from(modelUsageMaintenance)
    .where(
      and(
        eq(modelUsageMaintenance.clientInstanceId, input.clientInstanceId),
        eq(modelUsageMaintenance.task, input.task)
      )
    );
  return row?.state;
}

export async function writeModelUsageMaintenance(
  db: PostgresConnection,
  input: { clientInstanceId: ClientInstanceId; task: string; state: JsonObject }
): Promise<void> {
  await db
    .insert(modelUsageMaintenance)
    .values({ ...input, updatedAt: drizzleSql`now()` })
    .onConflictDoUpdate({
      target: [modelUsageMaintenance.clientInstanceId, modelUsageMaintenance.task],
      set: { state: input.state, updatedAt: drizzleSql`now()` }
    });
}
