import { and, asc, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import {
  AppError,
  type AuditEvent,
  type AuditEventInput,
  type ClientInstanceId,
  type CreateUserInput,
  type DeleteUserIdentityInput,
  type ResolveUserIdentityInput,
  type UpdateUserInput,
  type UpsertUserIdentityInput,
  type UserIdentity,
  type UserRecord,
  authenticatedUserFromRecord,
  createPlatformId,
  createUserId
} from "@vivd-catalyst/core";
import type { PostgresDatabase, PostgresTransaction } from "./postgres-database";
import {
  mapUserIdentity,
  mapUserRecord,
  type ProductUserRow,
  type UserIdentityRow
} from "./rows";
import { productUsers, userIdentities } from "./schema";

export async function resolveUserIdentity(
  db: PostgresDatabase,
  input: ResolveUserIdentityInput,
  appendAuditEvent: (input: AuditEventInput) => Promise<AuditEvent>
) {
  const normalizedEmail = input.email?.trim().toLowerCase();
  const emailLinkingEnabled = Boolean(
    input.linkByVerifiedEmail && normalizedEmail && input.emailVerified
  );

  const resolved = await db.transaction(async (tx) => {
    const now = new Date();
    await acquireResolveLock(
      tx,
      `identity:${input.clientInstanceId}:${input.authSource}:${input.externalUserId}`
    );
    if (emailLinkingEnabled) {
      await acquireResolveLock(tx, `identity-email:${input.clientInstanceId}:${normalizedEmail}`);
    }

    const [existingIdentity] = await tx
      .select()
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.clientInstanceId, input.clientInstanceId),
          eq(userIdentities.authSource, input.authSource),
          eq(userIdentities.externalUserId, input.externalUserId)
        )
      )
      .limit(1);

    if (existingIdentity) {
      const [user] = await tx
        .select()
        .from(productUsers)
        .where(
          and(
            eq(productUsers.clientInstanceId, input.clientInstanceId),
            eq(productUsers.id, existingIdentity.userId)
          )
        )
        .limit(1);
      if (!user) {
        throw new AppError("INTERNAL", "User identity mapping points to a missing user");
      }
      if (user.status !== "active") {
        throw new AppError("FORBIDDEN", "User is disabled");
      }

      const [updatedIdentity] = await tx
        .update(userIdentities)
        .set({
          displayLabel: input.displayLabel,
          email: input.email ?? null,
          emailVerified: input.emailVerified ?? false,
          updatedAt: now,
          lastAuthenticatedAt: now
        })
        .where(
          and(
            eq(userIdentities.clientInstanceId, input.clientInstanceId),
            eq(userIdentities.authSource, input.authSource),
            eq(userIdentities.externalUserId, input.externalUserId)
          )
        )
        .returning();
      await tx
        .update(productUsers)
        .set({
          updatedAt: now,
          lastAuthenticatedAt: now
        })
        .where(
          and(
            eq(productUsers.clientInstanceId, input.clientInstanceId),
            eq(productUsers.id, existingIdentity.userId)
          )
        );

      return {
        userId: existingIdentity.userId,
        identity: mapUserIdentity(updatedIdentity),
        linkedByVerifiedEmail: false
      };
    }

    let user: ProductUserRow | undefined;
    if (input.sourceUserId) {
      const [existingUser] = await tx
        .select()
        .from(productUsers)
        .where(
          and(
            eq(productUsers.clientInstanceId, input.clientInstanceId),
            eq(productUsers.id, input.sourceUserId)
          )
        )
        .limit(1);
      user = existingUser;
    }

    let linkedByVerifiedEmail = false;
    if (!user && emailLinkingEnabled && normalizedEmail) {
      user = await findSingleUserByVerifiedEmail(tx, input.clientInstanceId, normalizedEmail);
      linkedByVerifiedEmail = user !== undefined;
    }

    if (user?.status === "disabled") {
      throw new AppError("FORBIDDEN", "User is disabled");
    }

    if (!user) {
      const [createdUser] = await tx
        .insert(productUsers)
        .values({
          id: createUserId(),
          clientInstanceId: input.clientInstanceId,
          displayLabel: input.displayLabel,
          email: input.email ?? null,
          roles: input.roles,
          permissionRefs: input.permissionRefs,
          status: "active",
          createdAt: now,
          updatedAt: now,
          lastAuthenticatedAt: now
        })
        .returning();
      user = createdUser;
    } else {
      const [updatedUser] = await tx
        .update(productUsers)
        .set({
          updatedAt: now,
          lastAuthenticatedAt: now
        })
        .where(
          and(
            eq(productUsers.clientInstanceId, input.clientInstanceId),
            eq(productUsers.id, user.id)
          )
        )
        .returning();
      user = updatedUser;
    }

    if (!user) {
      throw new AppError("INTERNAL", "Failed to resolve user identity");
    }

    const [identity] = await tx
      .insert(userIdentities)
      .values({
        clientInstanceId: input.clientInstanceId,
        userId: user.id,
        authSource: input.authSource,
        externalUserId: input.externalUserId,
        displayLabel: input.displayLabel,
        email: input.email ?? null,
        emailVerified: input.emailVerified ?? false,
        createdAt: now,
        updatedAt: now,
        lastAuthenticatedAt: now
      })
      .onConflictDoUpdate({
        target: [
          userIdentities.clientInstanceId,
          userIdentities.authSource,
          userIdentities.externalUserId
        ],
        set: {
          userId: user.id,
          displayLabel: input.displayLabel,
          email: input.email ?? null,
          emailVerified: input.emailVerified ?? false,
          updatedAt: now,
          lastAuthenticatedAt: now
        }
      })
      .returning();

    return {
      userId: user.id,
      identity: mapUserIdentity(identity),
      linkedByVerifiedEmail
    };
  });

  if (resolved.linkedByVerifiedEmail) {
    await appendAuditEvent({
      clientInstanceId: input.clientInstanceId,
      type: "user.identity_linked",
      status: "success",
      subject: resolved.userId,
      correlationId: input.correlationId ?? createPlatformId("corr"),
      metadata: {
        authSource: input.authSource,
        externalUserId: input.externalUserId,
        matchedBy: "verified-email"
      }
    });
  }

  const user = await getUserRecord(db, input.clientInstanceId, resolved.userId);
  if (!user) {
    throw new AppError("INTERNAL", "Resolved user is not available");
  }
  return authenticatedUserFromRecord({
    user,
    identity: resolved.identity,
    correlationId: input.correlationId
  });
}

export async function listUsers(
  db: PostgresDatabase,
  input: { clientInstanceId: ClientInstanceId }
): Promise<UserRecord[]> {
  const rows = await db
    .select()
    .from(productUsers)
    .where(eq(productUsers.clientInstanceId, input.clientInstanceId))
    .orderBy(asc(productUsers.displayLabel));
  if (rows.length === 0) {
    return [];
  }

  const identityRows = await db
    .select()
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.clientInstanceId, input.clientInstanceId),
        inArray(
          userIdentities.userId,
          rows.map((row) => row.id)
        )
      )
    );
  return rows.map((row) => mapUserRecord(row, identitiesForUser(row, identityRows)));
}

export async function createUser(
  db: PostgresDatabase,
  input: CreateUserInput
): Promise<UserRecord> {
  const now = new Date();
  const [row] = await db
    .insert(productUsers)
    .values({
      id: createUserId(),
      clientInstanceId: input.clientInstanceId,
      displayLabel: input.displayLabel,
      email: input.email ?? null,
      roles: input.roles ?? ["user"],
      permissionRefs: input.permissionRefs ?? [],
      status: input.status ?? "active",
      createdAt: now,
      updatedAt: now
    })
    .returning();
  return mapUserRecord(row, []);
}

export async function updateUser(
  db: PostgresDatabase,
  input: UpdateUserInput
): Promise<UserRecord> {
  const set: Partial<typeof productUsers.$inferInsert> = {
    updatedAt: new Date()
  };
  if (input.displayLabel !== undefined) {
    set.displayLabel = input.displayLabel;
  }
  if (input.email !== undefined) {
    set.email = input.email;
  }
  if (input.roles !== undefined) {
    set.roles = input.roles;
  }
  if (input.permissionRefs !== undefined) {
    set.permissionRefs = input.permissionRefs;
  }
  if (input.status !== undefined) {
    set.status = input.status;
  }

  const [row] = await db
    .update(productUsers)
    .set(set)
    .where(
      and(eq(productUsers.clientInstanceId, input.clientInstanceId), eq(productUsers.id, input.userId))
    )
    .returning();
  if (!row) {
    throw new AppError("NOT_FOUND", "User is not available");
  }
  return requireUserRecord(db, input.clientInstanceId, row.id);
}

export async function upsertUserIdentity(
  db: PostgresDatabase,
  input: UpsertUserIdentityInput
): Promise<UserRecord> {
  const user = await getUserRecord(db, input.clientInstanceId, input.userId);
  if (!user) {
    throw new AppError("NOT_FOUND", "User is not available");
  }

  const now = new Date();
  await db
    .insert(userIdentities)
    .values({
      clientInstanceId: input.clientInstanceId,
      userId: input.userId,
      authSource: input.authSource,
      externalUserId: input.externalUserId,
      displayLabel: input.displayLabel ?? null,
      email: input.email ?? null,
      emailVerified: input.emailVerified ?? false,
      createdAt: now,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: [
        userIdentities.clientInstanceId,
        userIdentities.authSource,
        userIdentities.externalUserId
      ],
      set: {
        userId: input.userId,
        displayLabel: input.displayLabel ?? null,
        email: input.email ?? null,
        emailVerified: input.emailVerified ?? false,
        updatedAt: now
      }
    });
  await db
    .update(productUsers)
    .set({ updatedAt: now })
    .where(
      and(eq(productUsers.clientInstanceId, input.clientInstanceId), eq(productUsers.id, input.userId))
    );
  return requireUserRecord(db, input.clientInstanceId, input.userId);
}

export async function deleteUserIdentity(
  db: PostgresDatabase,
  input: DeleteUserIdentityInput
): Promise<UserRecord> {
  const user = await getUserRecord(db, input.clientInstanceId, input.userId);
  if (!user) {
    throw new AppError("NOT_FOUND", "User is not available");
  }

  const rows = await db
    .delete(userIdentities)
    .where(
      and(
        eq(userIdentities.clientInstanceId, input.clientInstanceId),
        eq(userIdentities.userId, input.userId),
        eq(userIdentities.authSource, input.authSource),
        eq(userIdentities.externalUserId, input.externalUserId)
      )
    )
    .returning();
  if (rows.length === 0) {
    throw new AppError("NOT_FOUND", "User identity mapping is not available");
  }
  await db
    .update(productUsers)
    .set({ updatedAt: new Date() })
    .where(
      and(eq(productUsers.clientInstanceId, input.clientInstanceId), eq(productUsers.id, input.userId))
    );
  return requireUserRecord(db, input.clientInstanceId, input.userId);
}

export async function getUserRecord(
  db: PostgresDatabase,
  clientInstanceId: ClientInstanceId,
  userId: string
): Promise<UserRecord | undefined> {
  const [row] = await db
    .select()
    .from(productUsers)
    .where(and(eq(productUsers.clientInstanceId, clientInstanceId), eq(productUsers.id, userId)))
    .limit(1);
  if (!row) {
    return undefined;
  }
  const identityRows = await db
    .select()
    .from(userIdentities)
    .where(and(eq(userIdentities.clientInstanceId, clientInstanceId), eq(userIdentities.userId, userId)));
  return mapUserRecord(row, identityRows.map(mapUserIdentity));
}

export async function requireUserRecord(
  db: PostgresDatabase,
  clientInstanceId: ClientInstanceId,
  userId: string
): Promise<UserRecord> {
  const user = await getUserRecord(db, clientInstanceId, userId);
  if (!user) {
    throw new AppError("NOT_FOUND", "User is not available");
  }
  return user;
}

async function acquireResolveLock(tx: PostgresTransaction, key: string): Promise<void> {
  await tx.execute(drizzleSql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

async function findSingleUserByVerifiedEmail(
  tx: PostgresTransaction,
  clientInstanceId: ClientInstanceId,
  normalizedEmail: string
): Promise<ProductUserRow | undefined> {
  const identityMatches = await tx
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.clientInstanceId, clientInstanceId),
        eq(userIdentities.emailVerified, true),
        drizzleSql`lower(${userIdentities.email}) = ${normalizedEmail}`
      )
    );
  const userMatches = await tx
    .select()
    .from(productUsers)
    .where(
      and(
        eq(productUsers.clientInstanceId, clientInstanceId),
        drizzleSql`lower(${productUsers.email}) = ${normalizedEmail}`
      )
    );

  const candidateIds = new Set<string>([
    ...identityMatches.map((match) => match.userId),
    ...userMatches.map((match) => match.id)
  ]);
  if (candidateIds.size !== 1) {
    return undefined;
  }

  const candidateId = [...candidateIds][0];
  if (!candidateId) {
    return undefined;
  }
  const matchedUser = userMatches.find((match) => match.id === candidateId);
  if (matchedUser) {
    return matchedUser;
  }

  const [row] = await tx
    .select()
    .from(productUsers)
    .where(and(eq(productUsers.clientInstanceId, clientInstanceId), eq(productUsers.id, candidateId)))
    .limit(1);
  return row;
}

function identitiesForUser(user: ProductUserRow, identities: UserIdentityRow[]): UserIdentity[] {
  return identities
    .filter((identity) => identity.userId === user.id)
    .map(mapUserIdentity)
    .sort((left, right) =>
      `${left.authSource}:${left.externalUserId}`.localeCompare(`${right.authSource}:${right.externalUserId}`)
    );
}
