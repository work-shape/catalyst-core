import { and, eq, sql } from "drizzle-orm";
import {
  APP_USER_STORAGE_MAX_BYTES,
  AppError,
  type AppUserStorageKey,
  type AppUserStorageMutation
} from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { appUserStorage } from "./schema/pages";

function ownedBy(input: AppUserStorageKey) {
  return and(
    eq(appUserStorage.clientInstanceId, input.clientInstanceId),
    eq(appUserStorage.appId, input.appId),
    eq(appUserStorage.userId, input.userId)
  );
}

export async function getAppUserStorage(
  db: PostgresConnection,
  input: AppUserStorageKey
): Promise<Record<string, string>> {
  const [row] = await db
    .select({ values: appUserStorage.values })
    .from(appUserStorage)
    .where(ownedBy(input))
    .limit(1);
  return row?.values ?? {};
}

export async function mutateAppUserStorage(
  db: PostgresConnection,
  input: AppUserStorageKey & { mutation: AppUserStorageMutation }
): Promise<void> {
  await db.transaction(async (tx) => {
    // The lock covers one App and person, including the first insert. Two tabs changing
    // different keys cannot replace each other's state.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["app-storage", input.clientInstanceId, input.appId, input.userId])}, 0))`
    );
    const previous = await getAppUserStorage(tx, input);
    const values = new Map(Object.entries(previous));
    const { mutation } = input;
    if (mutation.type === "set") values.set(mutation.key, mutation.value);
    else if (mutation.type === "remove") values.delete(mutation.key);
    else if (mutation.type === "clear") values.clear();
    else {
      if (mutation.clear) values.clear();
      for (const [key, value] of Object.entries(mutation.values)) {
        if (value === null) values.delete(key);
        else values.set(key, value);
      }
    }
    const next = Object.fromEntries(values);
    if (Buffer.byteLength(JSON.stringify(next), "utf8") > APP_USER_STORAGE_MAX_BYTES) {
      throw new AppError(
        "VALIDATION_FAILED",
        `App storage exceeds APP_USER_STORAGE_MAX_BYTES (${APP_USER_STORAGE_MAX_BYTES} bytes). Use a Data Store for business records.`,
        { reason: "storage_quota_exceeded" }
      );
    }
    await tx
      .insert(appUserStorage)
      .values({
        clientInstanceId: input.clientInstanceId,
        appId: input.appId,
        userId: input.userId,
        values: next
      })
      .onConflictDoUpdate({
        target: [appUserStorage.clientInstanceId, appUserStorage.appId, appUserStorage.userId],
        set: { values: next }
      });
  });
}
