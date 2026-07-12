import { and, asc, eq, sql } from "drizzle-orm";
import {
  AppError,
  createApiCredentialId,
  createApiCredentialSecretMaterial,
  createServicePrincipalId,
  type ApiAccessStore,
  type ApiCredentialRecord,
  type CreateApiCredentialInput,
  type CreatedApiCredential,
  type CreateServicePrincipalInput,
  type ResolvedApiCredential,
  type ServicePrincipalRecord,
  type UpdateServicePrincipalInput
} from "@vivd-catalyst/core";
import type { PostgresDatabase } from "./postgres-database";
import { mapApiCredential, mapServicePrincipal } from "./rows";
import { apiCredentials, productUsers, servicePrincipals } from "./schema";

export async function listServicePrincipals(
  db: PostgresDatabase,
  input: Parameters<ApiAccessStore["listServicePrincipals"]>[0]
): Promise<ServicePrincipalRecord[]> {
  const rows = await db
    .select()
    .from(servicePrincipals)
    .where(eq(servicePrincipals.clientInstanceId, input.clientInstanceId))
    .orderBy(asc(servicePrincipals.displayLabel));
  return rows.map(mapServicePrincipal);
}

export async function createServicePrincipal(
  db: PostgresDatabase,
  input: CreateServicePrincipalInput
): Promise<ServicePrincipalRecord> {
  if (input.createdByUserId) {
    const [creator] = await db
      .select({ id: productUsers.id })
      .from(productUsers)
      .where(
        and(
          eq(productUsers.clientInstanceId, input.clientInstanceId),
          eq(productUsers.id, input.createdByUserId)
        )
      )
      .limit(1);
    if (!creator) {
      throw new AppError("NOT_FOUND", "Creator user is not available");
    }
  }
  const now = new Date();
  const [row] = await db
    .insert(servicePrincipals)
    .values({
      id: createServicePrincipalId(),
      clientInstanceId: input.clientInstanceId,
      displayLabel: input.displayLabel,
      description: input.description ?? null,
      status: input.status ?? "active",
      permissionRefs: input.permissionRefs ?? [],
      permissions: input.permissions ?? [],
      createdByClientInstanceId: input.createdByUserId ? input.clientInstanceId : null,
      createdByUserId: input.createdByUserId ?? null,
      createdAt: now,
      updatedAt: now
    })
    .returning();
  return mapServicePrincipal(row);
}

export async function updateServicePrincipal(
  db: PostgresDatabase,
  input: UpdateServicePrincipalInput
): Promise<ServicePrincipalRecord> {
  const set: Partial<typeof servicePrincipals.$inferInsert> = { updatedAt: new Date() };
  if (input.displayLabel !== undefined) {
    set.displayLabel = input.displayLabel;
  }
  if (input.description !== undefined) {
    set.description = input.description;
  }
  if (input.status !== undefined) {
    set.status = input.status;
  }
  if (input.permissionRefs !== undefined) {
    set.permissionRefs = input.permissionRefs;
  }
  if (input.permissions !== undefined) {
    set.permissions = input.permissions;
  }

  const [row] = await db
    .update(servicePrincipals)
    .set(set)
    .where(
      and(
        eq(servicePrincipals.clientInstanceId, input.clientInstanceId),
        eq(servicePrincipals.id, input.servicePrincipalId)
      )
    )
    .returning();
  if (!row) {
    throw new AppError("NOT_FOUND", "Service principal is not available");
  }
  return mapServicePrincipal(row);
}

export async function listApiCredentials(
  db: PostgresDatabase,
  input: Parameters<ApiAccessStore["listApiCredentials"]>[0]
): Promise<ApiCredentialRecord[]> {
  await requireServicePrincipal(db, input.clientInstanceId, input.servicePrincipalId);
  const rows = await db
    .select()
    .from(apiCredentials)
    .where(
      and(
        eq(apiCredentials.clientInstanceId, input.clientInstanceId),
        eq(apiCredentials.servicePrincipalId, input.servicePrincipalId)
      )
    )
    .orderBy(asc(apiCredentials.name));
  return rows.map(mapApiCredential);
}

export async function createApiCredential(
  db: PostgresDatabase,
  input: CreateApiCredentialInput
): Promise<CreatedApiCredential> {
  await requireServicePrincipal(db, input.clientInstanceId, input.servicePrincipalId);
  const id = createApiCredentialId();
  const material = await createApiCredentialSecretMaterial(id);
  const [row] = await db
    .insert(apiCredentials)
    .values({
      id,
      clientInstanceId: input.clientInstanceId,
      servicePrincipalId: input.servicePrincipalId,
      name: input.name,
      keyPrefix: material.keyPrefix,
      secretHash: material.secretHash,
      scopes: input.scopes ?? null,
      createdAt: new Date(),
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null
    })
    .returning();
  return { credential: mapApiCredential(row), secret: material.secret };
}

export async function revokeApiCredential(
  db: PostgresDatabase,
  input: Parameters<ApiAccessStore["revokeApiCredential"]>[0]
): Promise<ApiCredentialRecord> {
  const [row] = await db
    .update(apiCredentials)
    .set({ revokedAt: sql`coalesce(${apiCredentials.revokedAt}, now())` })
    .where(
      and(
        eq(apiCredentials.clientInstanceId, input.clientInstanceId),
        eq(apiCredentials.id, input.credentialId)
      )
    )
    .returning();
  if (!row) {
    throw new AppError("NOT_FOUND", "API credential is not available");
  }
  return mapApiCredential(row);
}

export async function resolveApiCredential(
  db: PostgresDatabase,
  input: Parameters<ApiAccessStore["resolveApiCredential"]>[0]
): Promise<ResolvedApiCredential | undefined> {
  const [row] = await db
    .select({ credential: apiCredentials, servicePrincipal: servicePrincipals })
    .from(apiCredentials)
    .innerJoin(
      servicePrincipals,
      and(
        eq(servicePrincipals.id, apiCredentials.servicePrincipalId),
        eq(servicePrincipals.clientInstanceId, apiCredentials.clientInstanceId)
      )
    )
    .where(
      and(
        eq(apiCredentials.clientInstanceId, input.clientInstanceId),
        eq(apiCredentials.id, input.credentialId)
      )
    )
    .limit(1);
  if (!row) {
    return undefined;
  }
  return {
    credential: mapApiCredential(row.credential),
    servicePrincipal: mapServicePrincipal(row.servicePrincipal),
    secretHash: row.credential.secretHash
  };
}

export async function updateApiCredentialLastUsed(
  db: PostgresDatabase,
  input: Parameters<ApiAccessStore["updateApiCredentialLastUsed"]>[0]
): Promise<ApiCredentialRecord> {
  return db.transaction(async (tx) => {
    const usedAt = input.usedAt ?? new Date().toISOString();
    const [credential] = await tx
      .update(apiCredentials)
      .set({
        lastUsedAt: sql`greatest(coalesce(${apiCredentials.lastUsedAt}, ${usedAt}::timestamptz), ${usedAt}::timestamptz)`
      })
      .where(
        and(
          eq(apiCredentials.clientInstanceId, input.clientInstanceId),
          eq(apiCredentials.id, input.credentialId)
        )
      )
      .returning();
    if (!credential) {
      throw new AppError("NOT_FOUND", "API credential is not available");
    }
    const [principal] = await tx
      .update(servicePrincipals)
      .set({
        lastUsedAt: sql`greatest(coalesce(${servicePrincipals.lastUsedAt}, ${usedAt}::timestamptz), ${usedAt}::timestamptz)`
      })
      .where(
        and(
          eq(servicePrincipals.clientInstanceId, input.clientInstanceId),
          eq(servicePrincipals.id, credential.servicePrincipalId)
        )
      )
      .returning({ id: servicePrincipals.id });
    if (!principal) {
      throw new AppError("INTERNAL", "API credential points to a missing service principal");
    }
    return mapApiCredential(credential);
  });
}

async function requireServicePrincipal(
  db: PostgresDatabase,
  clientInstanceId: ServicePrincipalRecord["clientInstanceId"],
  servicePrincipalId: ServicePrincipalRecord["id"]
) {
  const [row] = await db
    .select()
    .from(servicePrincipals)
    .where(
      and(
        eq(servicePrincipals.clientInstanceId, clientInstanceId),
        eq(servicePrincipals.id, servicePrincipalId)
      )
    )
    .limit(1);
  if (!row) {
    throw new AppError("NOT_FOUND", "Service principal is not available");
  }
  return row;
}
