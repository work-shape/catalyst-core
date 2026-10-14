import { randomBytes } from "node:crypto";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import {
  AppError,
  LEGACY_LIST_GRANTOR,
  asClientInstanceId,
  createApiCredentialId,
  createApiCredentialSecretMaterial,
  createServicePrincipalId,
  SERVICE_PRINCIPAL_NAME_PATTERN,
  servicePrincipalNameFromLabel,
  type ApiAccessStore,
  type ApiCredentialRecord,
  type CreateApiCredentialInput,
  type CreatedApiCredential,
  type CreateServicePrincipalInput,
  type ResolvedApiCredential,
  type ServicePrincipalRecord,
  type UpdateServicePrincipalInput
} from "@vivd-catalyst/core";
import type { PostgresConnection } from "./postgres-database";
import { mapApiCredential, mapServicePrincipal } from "./rows";
import {
  legacyPermissionListOf,
  legacyPermissionLists,
  principalLegacyKeys,
  writeLegacyPermissionList
} from "./legacy-permission-lists";
import { apiCredentials, permissionGrants, productUsers, servicePrincipals } from "./schema";

export async function listServicePrincipals(
  db: PostgresConnection,
  input: Parameters<ApiAccessStore["listServicePrincipals"]>[0]
): Promise<ServicePrincipalRecord[]> {
  const rows = await db
    .select()
    .from(servicePrincipals)
    .where(eq(servicePrincipals.clientInstanceId, input.clientInstanceId))
    .orderBy(asc(servicePrincipals.displayLabel));
  const lists = await legacyPermissionLists(db, {
    clientInstanceId: input.clientInstanceId,
    holderKind: "service_principal",
    holderIds: rows.map((row) => row.id)
  });
  return rows.map((row) => mapServicePrincipal(row, lists.get(row.id) ?? []));
}

export async function createServicePrincipal(
  db: PostgresConnection,
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
  if (input.name !== undefined && !SERVICE_PRINCIPAL_NAME_PATTERN.test(input.name)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `'${input.name}' is no name of a service principal: lowercase letters, digits and '-', at most 63 characters`
    );
  }
  const now = new Date();
  // A name the caller gave is tried once. A derived one is tried again with another suffix
  // when a create beside this one took it between the look and the insert.
  for (let attempt = 0; ; attempt += 1) {
    const name = input.name ?? (await freeNameFor(db, input, attempt > 0));
    const row = await insertServicePrincipal(db, input, name, now);
    if (row) {
      return mapServicePrincipal(row, await principalList(db, row));
    }
    if (input.name !== undefined || attempt >= DERIVED_NAME_ATTEMPTS) {
      throw new AppError(
        "CONFLICT",
        `A service principal named '${name}' exists on this instance`,
        { reason: "name_taken", name }
      );
    }
  }
}

const DERIVED_NAME_ATTEMPTS = 5;

async function insertServicePrincipal(
  db: PostgresConnection,
  input: CreateServicePrincipalInput,
  name: string,
  now: Date
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(servicePrincipals)
      .values({
        id: createServicePrincipalId(),
        clientInstanceId: input.clientInstanceId,
        name,
        displayLabel: input.displayLabel,
        description: input.description ?? null,
        status: input.status ?? "active",
        permissionRefs: input.permissionRefs ?? [],
        createdByClientInstanceId: input.createdByUserId ? input.clientInstanceId : null,
        createdByUserId: input.createdByUserId ?? null,
        createdAt: now,
        updatedAt: now
      })
      .onConflictDoNothing({ target: [servicePrincipals.clientInstanceId, servicePrincipals.name] })
      .returning();
    if (row) {
      await writeLegacyPermissionList(tx, {
        clientInstanceId: input.clientInstanceId,
        holderKind: "service_principal",
        holderId: row.id,
        entries: input.permissions ?? [],
        grantedBy: input.createdByUserId ?? LEGACY_LIST_GRANTOR
      });
    }
    return row;
  });
}

function principalList(
  db: PostgresConnection,
  row: { clientInstanceId: string; id: string }
): Promise<string[]> {
  return legacyPermissionListOf(db, {
    clientInstanceId: asClientInstanceId(row.clientInstanceId),
    holderKind: "service_principal",
    holderId: row.id
  });
}

/** The label as a slug, or that slug with a short random suffix where a principal has it. */
async function freeNameFor(
  db: PostgresConnection,
  input: Pick<CreateServicePrincipalInput, "clientInstanceId" | "displayLabel">,
  suffixed: boolean
): Promise<string> {
  const base = servicePrincipalNameFromLabel(input.displayLabel);
  const taken =
    suffixed ||
    (await findServicePrincipalByName(db, {
      clientInstanceId: input.clientInstanceId,
      name: base
    })) !== undefined;
  return taken ? `${base}-${randomBytes(3).toString("hex")}` : base;
}

export async function findServicePrincipalByName(
  db: PostgresConnection,
  input: Parameters<ApiAccessStore["findServicePrincipalByName"]>[0]
): Promise<ServicePrincipalRecord | undefined> {
  const [row] = await db
    .select()
    .from(servicePrincipals)
    .where(
      and(
        eq(servicePrincipals.clientInstanceId, input.clientInstanceId),
        eq(servicePrincipals.name, input.name)
      )
    )
    .limit(1);
  return row ? mapServicePrincipal(row, await principalList(db, row)) : undefined;
}

export async function updateServicePrincipal(
  db: PostgresConnection,
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

  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(servicePrincipals)
      .set(set)
      .where(
        and(
          eq(servicePrincipals.clientInstanceId, input.clientInstanceId),
          eq(servicePrincipals.id, input.servicePrincipalId)
        )
      )
      .returning();
    if (updated && input.permissions !== undefined) {
      await writeLegacyPermissionList(tx, {
        clientInstanceId: input.clientInstanceId,
        holderKind: "service_principal",
        holderId: updated.id,
        entries: input.permissions,
        grantedBy: input.grantedBy ?? LEGACY_LIST_GRANTOR
      });
    }
    return updated;
  });
  if (!row) {
    throw new AppError("NOT_FOUND", "Service principal is not available");
  }
  return mapServicePrincipal(row, await principalList(db, row));
}

/**
 * The principal row goes first. A grant write holds a share lock on it until its row is
 * stored, so this waits for one that is under way and then removes what it wrote; a grant
 * write that comes later finds no principal. The keys go with the row by their foreign key.
 */
export async function deleteServicePrincipal(
  db: PostgresConnection,
  input: Parameters<ApiAccessStore["deleteServicePrincipal"]>[0]
): Promise<ServicePrincipalRecord | undefined> {
  return db.transaction(async (tx) => {
    // What the principal held, for whoever records its deletion.
    const permissions = await legacyPermissionListOf(tx, {
      clientInstanceId: input.clientInstanceId,
      holderKind: "service_principal",
      holderId: input.servicePrincipalId
    });
    const [row] = await tx
      .delete(servicePrincipals)
      .where(
        and(
          eq(servicePrincipals.clientInstanceId, input.clientInstanceId),
          eq(servicePrincipals.id, input.servicePrincipalId)
        )
      )
      .returning();
    if (!row) {
      return undefined;
    }
    await tx
      .delete(permissionGrants)
      .where(
        and(
          eq(permissionGrants.clientInstanceId, input.clientInstanceId),
          eq(permissionGrants.holderKind, "service_principal"),
          eq(permissionGrants.holderId, input.servicePrincipalId)
        )
      );
    return mapServicePrincipal(row, permissions);
  });
}

export async function listApiCredentials(
  db: PostgresConnection,
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
  db: PostgresConnection,
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
      // A credential named no scope has every scope its principal has. That is `*`; a list
      // is never null from this release on.
      scopes: input.scopes ?? ["*"],
      createdAt: new Date(),
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null
    })
    .returning();
  return { credential: mapApiCredential(row), secret: material.secret };
}

export async function revokeApiCredential(
  db: PostgresConnection,
  input: Parameters<ApiAccessStore["revokeApiCredential"]>[0]
): Promise<ApiCredentialRecord> {
  const [row] = await db
    .update(apiCredentials)
    .set({ revokedAt: sql`coalesce(${apiCredentials.revokedAt}, now())` })
    .where(
      and(
        eq(apiCredentials.clientInstanceId, input.clientInstanceId),
        eq(apiCredentials.id, input.credentialId),
        // A personal key is revoked through its own operation.
        isNotNull(apiCredentials.servicePrincipalId)
      )
    )
    .returning();
  if (!row) {
    throw new AppError("NOT_FOUND", "API credential is not available");
  }
  return mapApiCredential(row);
}

export async function resolveApiCredential(
  db: PostgresConnection,
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
  const keys = await principalLegacyKeys(db, {
    clientInstanceId: asClientInstanceId(row.servicePrincipal.clientInstanceId),
    principalId: row.servicePrincipal.id
  });
  return {
    credential: mapApiCredential(row.credential),
    servicePrincipal: mapServicePrincipal(row.servicePrincipal, keys.list),
    heldKeys: keys.held,
    secretHash: row.credential.secretHash
  };
}

export async function updateApiCredentialLastUsed(
  db: PostgresConnection,
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
          eq(apiCredentials.id, input.credentialId),
          isNotNull(apiCredentials.servicePrincipalId)
        )
      )
      .returning();
    if (!credential?.servicePrincipalId) {
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
  db: PostgresConnection,
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
