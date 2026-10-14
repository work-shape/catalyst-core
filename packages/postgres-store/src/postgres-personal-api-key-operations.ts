import { and, count, desc, eq, gt, isNotNull, isNull, lt, sql } from "drizzle-orm";
import {
  AppError,
  PERSONAL_API_KEYS_PER_USER_MAX,
  asClientInstanceId,
  asUserId,
  createConnectCodeId,
  createPersonalApiKeyMaterial,
  type ConnectCodeRecord,
  type ConnectCodeRedemption,
  type CreatedPersonalApiKey,
  type CreatePersonalApiKeyInput,
  type PersonalApiKeyRecord,
  type PersonalApiKeyStore,
  type ResolvedPersonalApiKey
} from "@vivd-catalyst/core";
import { keysetFilter } from "./paging";
import type { PostgresConnection } from "./postgres-database";
import { mapPersonalApiKey } from "./rows";
import { apiConnectCodes, apiCredentials, productUsers } from "./schema";

/** How long an expired connect code is kept before a new start drops it. */
const EXPIRED_CONNECT_CODE_RETENTION_MS = 24 * 60 * 60 * 1000;

type Input<Method extends keyof PersonalApiKeyStore> = Parameters<PersonalApiKeyStore[Method]>[0];

export async function listPersonalApiKeys(
  db: PostgresConnection,
  input: Input<"listPersonalApiKeys">
): Promise<PersonalApiKeyRecord[]> {
  const rows = await db
    .select({ key: apiCredentials, ownerDisplayLabel: productUsers.displayLabel })
    .from(apiCredentials)
    .leftJoin(
      productUsers,
      and(
        eq(productUsers.clientInstanceId, apiCredentials.clientInstanceId),
        eq(productUsers.id, apiCredentials.ownerUserId)
      )
    )
    .where(
      and(
        eq(apiCredentials.clientInstanceId, input.clientInstanceId),
        input.ownerUserId === undefined
          ? isNotNull(apiCredentials.ownerUserId)
          : eq(apiCredentials.ownerUserId, input.ownerUserId),
        keysetFilter(input.page, [apiCredentials.createdAt, apiCredentials.id], true)
      )
    )
    .orderBy(desc(apiCredentials.createdAt), desc(apiCredentials.id))
    .limit(input.page?.limit ?? PERSONAL_API_KEYS_PER_USER_MAX);
  return rows.map((row) => ({
    ...mapPersonalApiKey(row.key),
    ...(row.ownerDisplayLabel === null ? {} : { ownerDisplayLabel: row.ownerDisplayLabel })
  }));
}

export async function createPersonalApiKey(
  db: PostgresConnection,
  input: CreatePersonalApiKeyInput
): Promise<CreatedPersonalApiKey> {
  return db.transaction(async (tx) => {
    await requireBelowKeyCap(tx, input);
    return insertPersonalApiKey(tx, input);
  });
}

/**
 * Refuses a key beyond the owner's cap. Two creations at once count each other: the count runs
 * under a lock on the owner that lasts to the end of the caller's transaction.
 */
async function requireBelowKeyCap(
  db: PostgresConnection,
  input: Pick<CreatePersonalApiKeyInput, "clientInstanceId" | "ownerUserId">
): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`personal_api_keys:${input.clientInstanceId}:${input.ownerUserId}`}, 0))`
  );
  const [usable] = await db
    .select({ count: count() })
    .from(apiCredentials)
    .where(
      and(
        eq(apiCredentials.clientInstanceId, input.clientInstanceId),
        eq(apiCredentials.ownerUserId, input.ownerUserId),
        isNull(apiCredentials.revokedAt),
        gt(apiCredentials.expiresAt, sql`now()`)
      )
    );
  if ((usable?.count ?? 0) >= PERSONAL_API_KEYS_PER_USER_MAX) {
    throw new AppError(
      "CONFLICT",
      `You hold ${PERSONAL_API_KEYS_PER_USER_MAX} usable personal API keys, the most one person may. Revoke one you no longer use`,
      { reason: "personal_key_limit", limit: PERSONAL_API_KEYS_PER_USER_MAX }
    );
  }
}

async function insertPersonalApiKey(
  db: PostgresConnection,
  input: CreatePersonalApiKeyInput
): Promise<CreatedPersonalApiKey> {
  const material = await createPersonalApiKeyMaterial();
  const [row] = await db
    .insert(apiCredentials)
    .values({
      id: material.id,
      clientInstanceId: input.clientInstanceId,
      ownerUserId: input.ownerUserId,
      name: input.name,
      keyPrefix: material.keyPrefix,
      secretHash: material.secretHash,
      scopes: input.scopes,
      createdAt: new Date(),
      expiresAt: new Date(input.expiresAt)
    })
    .returning();
  if (!row) {
    throw new AppError("INTERNAL", "The personal API key was not stored");
  }
  return { key: mapPersonalApiKey(row), secret: material.secret };
}

export async function revokePersonalApiKey(
  db: PostgresConnection,
  input: Input<"revokePersonalApiKey">
): Promise<PersonalApiKeyRecord | undefined> {
  const [row] = await db
    .update(apiCredentials)
    .set({ revokedAt: sql`coalesce(${apiCredentials.revokedAt}, now())` })
    .where(
      and(
        eq(apiCredentials.clientInstanceId, input.clientInstanceId),
        eq(apiCredentials.id, input.keyId),
        input.ownerUserId === undefined
          ? isNotNull(apiCredentials.ownerUserId)
          : eq(apiCredentials.ownerUserId, input.ownerUserId)
      )
    )
    .returning();
  return row ? mapPersonalApiKey(row) : undefined;
}

export async function resolvePersonalApiKey(
  db: PostgresConnection,
  input: Input<"resolvePersonalApiKey">
): Promise<ResolvedPersonalApiKey | undefined> {
  const [row] = await db
    .select()
    .from(apiCredentials)
    .where(
      and(
        eq(apiCredentials.clientInstanceId, input.clientInstanceId),
        eq(apiCredentials.id, input.keyId),
        isNotNull(apiCredentials.ownerUserId)
      )
    )
    .limit(1);
  return row ? { key: mapPersonalApiKey(row), secretHash: row.secretHash } : undefined;
}

export async function markPersonalApiKeyUsed(
  db: PostgresConnection,
  input: Input<"markPersonalApiKeyUsed">
): Promise<void> {
  await db
    .update(apiCredentials)
    .set({ lastUsedAt: sql`greatest(coalesce(${apiCredentials.lastUsedAt}, now()), now())` })
    .where(
      and(
        eq(apiCredentials.clientInstanceId, input.clientInstanceId),
        eq(apiCredentials.id, input.keyId),
        isNotNull(apiCredentials.ownerUserId)
      )
    );
}

export async function startConnectCode(
  db: PostgresConnection,
  input: Input<"startConnectCode">
): Promise<void> {
  const now = new Date();
  await db
    .delete(apiConnectCodes)
    .where(
      and(
        eq(apiConnectCodes.clientInstanceId, input.clientInstanceId),
        lt(apiConnectCodes.expiresAt, new Date(now.getTime() - EXPIRED_CONNECT_CODE_RETENTION_MS))
      )
    );
  // A code that is still in use under the same letters refuses the start; the caller asks
  // for another pair.
  const [row] = await db
    .insert(apiConnectCodes)
    .values({
      id: createConnectCodeId(),
      clientInstanceId: input.clientInstanceId,
      userCodeHash: input.userCodeHash,
      deviceCodeHash: input.deviceCodeHash,
      clientLabel: input.clientLabel ?? null,
      createdAt: now,
      expiresAt: new Date(input.expiresAt)
    })
    .onConflictDoNothing()
    .returning({ id: apiConnectCodes.id });
  if (!row) {
    throw new AppError("CONFLICT", "The connect code is taken", { reason: "code_taken" });
  }
}

export async function findConnectCode(
  db: PostgresConnection,
  input: Input<"findConnectCode">
): Promise<ConnectCodeRecord | undefined> {
  const [row] = await db
    .select()
    .from(apiConnectCodes)
    .where(
      and(
        eq(apiConnectCodes.clientInstanceId, input.clientInstanceId),
        eq(apiConnectCodes.userCodeHash, input.userCodeHash),
        gt(apiConnectCodes.expiresAt, sql`now()`),
        isNull(apiConnectCodes.redeemedAt)
      )
    )
    .limit(1);
  return row ? mapConnectCode(row) : undefined;
}

export async function approveConnectCode(
  db: PostgresConnection,
  input: Input<"approveConnectCode">
): Promise<ConnectCodeRecord | undefined> {
  const [row] = await db
    .update(apiConnectCodes)
    .set({
      approvedAt: sql`now()`,
      ownerUserId: input.ownerUserId,
      keyName: input.name,
      keyScopes: input.scopes,
      keyExpiresAt: new Date(input.keyExpiresAt)
    })
    .where(
      and(
        eq(apiConnectCodes.clientInstanceId, input.clientInstanceId),
        eq(apiConnectCodes.userCodeHash, input.userCodeHash),
        gt(apiConnectCodes.expiresAt, sql`now()`),
        isNull(apiConnectCodes.approvedAt)
      )
    )
    .returning();
  return row ? mapConnectCode(row) : undefined;
}

export async function redeemConnectCode(
  db: PostgresConnection,
  input: Input<"redeemConnectCode">
): Promise<ConnectCodeRedemption> {
  return db.transaction(async (tx) => {
    const [code] = await tx
      .select()
      .from(apiConnectCodes)
      .where(
        and(
          eq(apiConnectCodes.clientInstanceId, input.clientInstanceId),
          eq(apiConnectCodes.deviceCodeHash, input.deviceCodeHash),
          gt(apiConnectCodes.expiresAt, sql`now()`),
          isNull(apiConnectCodes.redeemedAt)
        )
      )
      .for("update")
      .limit(1);
    if (!code) return { status: "invalid" };
    if (!code.approvedAt) return { status: "pending" };
    if (!code.ownerUserId || !code.keyName || !code.keyScopes || !code.keyExpiresAt) {
      throw new AppError("INTERNAL", "An approved connect code lacks its key's fields");
    }
    const owner = {
      clientInstanceId: input.clientInstanceId,
      ownerUserId: asUserId(code.ownerUserId)
    };
    await requireBelowKeyCap(tx, owner);
    const created = await insertPersonalApiKey(tx, {
      ...owner,
      name: code.keyName,
      scopes: code.keyScopes,
      expiresAt: code.keyExpiresAt.toISOString()
    });
    await tx
      .update(apiConnectCodes)
      .set({ redeemedAt: sql`now()`, credentialId: created.key.id })
      .where(eq(apiConnectCodes.id, code.id));
    return { status: "issued", created };
  });
}

function mapConnectCode(row: typeof apiConnectCodes.$inferSelect): ConnectCodeRecord {
  return {
    id: row.id,
    clientInstanceId: asClientInstanceId(row.clientInstanceId),
    ...(row.clientLabel === null ? {} : { clientLabel: row.clientLabel }),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    ...(row.approvedAt === null ? {} : { approvedAt: row.approvedAt.toISOString() })
  };
}
