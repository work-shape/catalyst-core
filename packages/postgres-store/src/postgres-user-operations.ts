import { keysetFilter } from "./paging";
import {
  AppError,
  type AuditEvent,
  type AuditEventInput,
  type ClientInstanceId,
  type CreateUserInput,
  type DeleteUserInput,
  type DeleteUserIdentityInput,
  type ResolveUserIdentityInput,
  type UpdateUserInput,
  type UpsertUserIdentityInput,
  type UserModelPreference,
  type UserModelPreferenceInput,
  type UserIdentity,
  type UserRecord,
  authenticatedUserFromRecord,
  LEGACY_LIST_GRANTOR,
  createPlatformId,
  createUserId,
  requireUsableUser,
  userInDeletionError,
  type UserStore
} from "@work-shape/catalyst-core";
import { and, desc, eq, inArray, isNotNull, isNull, sql as drizzleSql } from "drizzle-orm";
import { type PostgresConnection, type PostgresTransaction } from "./postgres-database";
import { mapUserIdentity, mapUserRecord, type ProductUserRow, type UserIdentityRow } from "./rows";
import {
  legacyPermissionListOf,
  legacyPermissionLists,
  writeLegacyPermissionList
} from "./legacy-permission-lists";
import { permissionGrants, productUsers, userIdentities } from "./schema";
import { ensurePersonalWorkspaceInTransaction } from "./postgres-collaboration-workspace-operations";
import { lockRights, lockRightsOfUsableUser } from "./rights-lock";
import { appendAuditEvent as appendPostgresAuditEvent } from "./postgres-audit-usage-operations";

async function resolveUserIdentity(
  db: PostgresConnection,
  input: ResolveUserIdentityInput,
  appendAuditEvent: (input: AuditEventInput) => Promise<AuditEvent>
) {
  const normalizedEmail = input.email?.trim().toLowerCase();
  const emailLinkingEnabled = Boolean(
    input.linkByVerifiedEmail && normalizedEmail && input.emailVerified
  );

  // Ordinary requests refresh only this user's sign-in metadata. If the mapping vanished,
  // finish that transaction (and release its user lock) before taking the access lock.
  const linked = await db.transaction((tx) => refreshLinkedSignIn(tx, input));
  const resolved =
    linked ??
    (await db.transaction(async (tx) => {
      await lockRights(tx, { clientInstanceId: input.clientInstanceId });
      // Another first sign-in or administrator may have linked it after the plain lookup.
      const concurrent = await refreshLinkedSignIn(tx, input);
      if (concurrent) return concurrent;
      const now = new Date();

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

      // A user the session names or a verified email leads to: closed is closed on this way too.
      if (user) {
        await lockRights(tx, { clientInstanceId: input.clientInstanceId, userId: user.id });
        // A direct deletion mark may have committed while the row lock was being acquired.
        user = await tx
          .select()
          .from(productUsers)
          .where(
            and(
              eq(productUsers.clientInstanceId, input.clientInstanceId),
              eq(productUsers.id, user.id)
            )
          )
          .then(([row]) => row);
        if (!user) throw new AppError("NOT_FOUND", "User is not available");
        requireUsableUser(mapUserRecord(user, [], []).status);
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
        if (createdUser) {
          // The list the sign-in brings becomes the new user's rows; nobody granted them.
          await writeLegacyPermissionList(tx, {
            clientInstanceId: input.clientInstanceId,
            holderKind: "user",
            holderId: createdUser.id,
            entries: input.permissions,
            grantedBy: LEGACY_LIST_GRANTOR
          });
        }
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
    }));

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

/**
 * Refreshes an existing sign-in without the instance access lock. It changes no owner, role
 * or grant: user first, then identity, matching rights writers without ever waiting for their
 * advisory lock while holding a user. Re-read the mapping after locking the user because an
 * administrator may have removed it and linked the same external id elsewhere in between.
 * An absent mapping returns to the caller, which ends this transaction before linking it.
 */
async function refreshLinkedSignIn(tx: PostgresTransaction, input: ResolveUserIdentityInput) {
  const address = and(
    eq(userIdentities.clientInstanceId, input.clientInstanceId),
    eq(userIdentities.authSource, input.authSource),
    eq(userIdentities.externalUserId, input.externalUserId)
  );
  const [known] = await tx
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(address)
    .limit(1);
  if (!known) return undefined;
  const userWhere = and(
    eq(productUsers.clientInstanceId, input.clientInstanceId),
    eq(productUsers.id, known.userId)
  );
  const [user] = await tx.select().from(productUsers).where(userWhere).for("update").limit(1);
  if (!user) return undefined;
  const identityWhere = and(address, eq(userIdentities.userId, user.id));
  const [current] = await tx.select().from(userIdentities).where(identityWhere).limit(1);
  if (!current) return undefined;
  requireUsableUser(mapUserRecord(user, [], []).status);

  const now = new Date();
  await tx.update(productUsers).set({ updatedAt: now, lastAuthenticatedAt: now }).where(userWhere);
  const [identity] = await tx
    .update(userIdentities)
    .set({
      displayLabel: input.displayLabel,
      email: input.email ?? null,
      emailVerified: input.emailVerified ?? false,
      updatedAt: now,
      lastAuthenticatedAt: now
    })
    .where(identityWhere)
    .returning();
  if (!identity) throw new AppError("INTERNAL", "The locked sign-in is not available");
  return { userId: user.id, identity: mapUserIdentity(identity), linkedByVerifiedEmail: false };
}

async function listUsers(
  db: PostgresConnection,
  input: Parameters<UserStore["listUsers"]>[0]
): Promise<UserRecord[]> {
  const rows = await db
    .select()
    .from(productUsers)
    .where(
      and(
        eq(productUsers.clientInstanceId, input.clientInstanceId),
        input.text === undefined
          ? undefined
          : drizzleSql`(position(lower(${input.text}) in lower(${productUsers.displayLabel})) > 0
              OR position(lower(${input.text}) in lower(coalesce(${productUsers.email}, ''))) > 0)`,
        input.activeOnly ? eq(productUsers.status, "active") : undefined,
        input.activeOnly ? isNull(productUsers.deletionRequestedAt) : undefined,
        keysetFilter(
          input.page,
          [
            drizzleSql`${productUsers.displayLabel} COLLATE "C"`,
            drizzleSql`${productUsers.id} COLLATE "C"`
          ],
          false
        ),
        input.excludeSuperadmins
          ? drizzleSql`NOT (${productUsers.roles} @> '["superadmin"]'::jsonb)`
          : undefined
      )
    )
    .orderBy(
      drizzleSql`${productUsers.displayLabel} COLLATE "C"`,
      drizzleSql`${productUsers.id} COLLATE "C"`
    )
    .limit(input.page?.limit ?? 2147483647);
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
  const lists = await legacyPermissionLists(db, {
    clientInstanceId: input.clientInstanceId,
    holderKind: "user",
    holderIds: rows.map((row) => row.id)
  });
  return rows.map((row) =>
    mapUserRecord(row, identitiesForUser(row, identityRows), lists.get(row.id) ?? [])
  );
}

async function createUser(db: PostgresConnection, input: CreateUserInput): Promise<UserRecord> {
  return db.transaction(async (tx) => {
    await lockRights(tx, { clientInstanceId: input.clientInstanceId });
    const now = new Date();
    const [row] = await tx
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
    if (!row) throw new AppError("INTERNAL", "Failed to create user");
    await ensurePersonalWorkspaceInTransaction(tx, {
      clientInstanceId: input.clientInstanceId,
      userId: row.id as UserRecord["id"]
    });
    await writeLegacyPermissionList(tx, {
      clientInstanceId: input.clientInstanceId,
      holderKind: "user",
      holderId: row.id,
      entries: input.permissions ?? [],
      grantedBy: input.grantedBy ?? LEGACY_LIST_GRANTOR
    });
    return mapUserRecord(
      row,
      [],
      await legacyPermissionListOf(tx, {
        clientInstanceId: input.clientInstanceId,
        holderKind: "user",
        holderId: row.id
      })
    );
  });
}

async function getUserModelPreference(
  db: PostgresConnection,
  input: UserModelPreferenceInput
): Promise<UserModelPreference | undefined> {
  const [row] = await db
    .select({ modelPreference: productUsers.modelPreference })
    .from(productUsers)
    .where(
      and(
        eq(productUsers.clientInstanceId, input.clientInstanceId),
        eq(productUsers.id, input.userId)
      )
    );
  return row?.modelPreference ?? undefined;
}

async function setUserModelPreference(
  db: PostgresConnection,
  input: UserModelPreferenceInput & { preference: UserModelPreference }
): Promise<void> {
  const rows = await db
    .update(productUsers)
    .set({ modelPreference: input.preference })
    .where(
      and(
        eq(productUsers.clientInstanceId, input.clientInstanceId),
        eq(productUsers.id, input.userId)
      )
    )
    .returning({ id: productUsers.id });
  if (rows.length === 0) {
    throw new AppError("NOT_FOUND", "User is not available");
  }
}

async function updateUser(db: PostgresConnection, input: UpdateUserInput): Promise<UserRecord> {
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
  if (input.locale !== undefined) {
    set.locale = input.locale;
  }

  const row = await db.transaction(async (tx) => {
    await lockRights(tx, input);
    const [updated] = await tx
      .update(productUsers)
      .set(set)
      .where(
        and(
          eq(productUsers.clientInstanceId, input.clientInstanceId),
          eq(productUsers.id, input.userId),
          // In the statement, so a deletion requested since the caller read the user refuses
          // too. The row stays locked until the grant rows are written.
          isNull(productUsers.deletionRequestedAt)
        )
      )
      .returning();
    if (updated && input.permissions !== undefined) {
      await writeLegacyPermissionList(tx, {
        clientInstanceId: input.clientInstanceId,
        holderKind: "user",
        holderId: updated.id,
        entries: input.permissions,
        grantedBy: input.grantedBy ?? LEGACY_LIST_GRANTOR
      });
    }
    return updated;
  });
  if (!row) {
    // No row matched: the user is gone, or the deletion was requested.
    await requireUserRecord(db, input.clientInstanceId, input.userId);
    throw userInDeletionError();
  }
  return requireUserRecord(db, input.clientInstanceId, row.id);
}

async function markUserDeletionRequested(
  db: PostgresConnection,
  input: DeleteUserInput
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockRights(tx, input);
    const marked = await tx
      .update(productUsers)
      .set({ deletionRequestedAt: drizzleSql`now()` })
      .where(
        and(
          eq(productUsers.clientInstanceId, input.clientInstanceId),
          eq(productUsers.id, input.userId),
          isNull(productUsers.deletionRequestedAt)
        )
      )
      .returning({ id: productUsers.id });
    if (marked.length > 0) return true;
    await requireUserRecord(tx, input.clientInstanceId, input.userId);
    return false;
  });
}

async function deleteUser(db: PostgresConnection, input: DeleteUserInput): Promise<UserRecord> {
  const user = await getUserRecord(db, input.clientInstanceId, input.userId);
  if (!user) {
    throw new AppError("NOT_FOUND", "User is not available");
  }

  // The user's grant rows go with the user: a row left behind would answer for whoever
  // carried the id next.
  const rows = await db.transaction(async (tx) => {
    await lockRights(tx, input);
    await tx
      .delete(permissionGrants)
      .where(
        and(
          eq(permissionGrants.clientInstanceId, input.clientInstanceId),
          eq(permissionGrants.holderKind, "user"),
          eq(permissionGrants.holderId, input.userId)
        )
      );
    return tx
      .delete(productUsers)
      .where(
        and(
          eq(productUsers.clientInstanceId, input.clientInstanceId),
          eq(productUsers.id, input.userId)
        )
      )
      .returning();
  });
  if (rows.length === 0) {
    throw new AppError("NOT_FOUND", "User is not available");
  }
  return user;
}

async function upsertUserIdentity(
  connection: PostgresConnection,
  input: UpsertUserIdentityInput
): Promise<UserRecord> {
  return connection.transaction(async (db) => {
    await lockRightsOfUsableUser(db, input);
    return upsertLockedUserIdentity(db, input);
  });
}

async function upsertLockedUserIdentity(
  db: PostgresTransaction,
  input: UpsertUserIdentityInput
): Promise<UserRecord> {
  const now = new Date();
  const [identity] = await db
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
      // A mapping may be edited on its current account, never silently reassigned. A move
      // would change both accounts and has no product workflow; neither owner is changed.
      setWhere: eq(userIdentities.userId, input.userId),
      set: {
        displayLabel: input.displayLabel ?? null,
        email: input.email ?? null,
        emailVerified: input.emailVerified ?? false,
        updatedAt: now
      }
    })
    .returning({ userId: userIdentities.userId });
  if (!identity) {
    throw new AppError("CONFLICT", "This sign-in is already linked to another user", {
      reason: "identity_already_linked"
    });
  }
  await db
    .update(productUsers)
    .set({ updatedAt: now })
    .where(
      and(
        eq(productUsers.clientInstanceId, input.clientInstanceId),
        eq(productUsers.id, input.userId)
      )
    );
  return requireUserRecord(db, input.clientInstanceId, input.userId);
}

async function deleteUserIdentity(
  connection: PostgresConnection,
  input: DeleteUserIdentityInput
): Promise<UserRecord> {
  return connection.transaction(async (db) => {
    await lockRightsOfUsableUser(db, input);
    return deleteLockedUserIdentity(db, input);
  });
}

async function deleteLockedUserIdentity(
  db: PostgresTransaction,
  input: DeleteUserIdentityInput
): Promise<UserRecord> {
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
      and(
        eq(productUsers.clientInstanceId, input.clientInstanceId),
        eq(productUsers.id, input.userId)
      )
    );
  return requireUserRecord(db, input.clientInstanceId, input.userId);
}

async function getUserRecord(
  db: PostgresConnection,
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
    .where(
      and(eq(userIdentities.clientInstanceId, clientInstanceId), eq(userIdentities.userId, userId))
    );
  return mapUserRecord(
    row,
    identityRows.map(mapUserIdentity),
    await legacyPermissionListOf(db, { clientInstanceId, holderKind: "user", holderId: userId })
  );
}

export async function requireUserRecord(
  db: PostgresConnection,
  clientInstanceId: ClientInstanceId,
  userId: string
): Promise<UserRecord> {
  const user = await getUserRecord(db, clientInstanceId, userId);
  if (!user) {
    throw new AppError("NOT_FOUND", "User is not available");
  }
  return user;
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
    .where(
      and(eq(productUsers.clientInstanceId, clientInstanceId), eq(productUsers.id, candidateId))
    )
    .limit(1);
  return row;
}

function identitiesForUser(user: ProductUserRow, identities: UserIdentityRow[]): UserIdentity[] {
  return identities
    .filter((identity) => identity.userId === user.id)
    .map(mapUserIdentity)
    .sort((left, right) =>
      `${left.authSource}:${left.externalUserId}`.localeCompare(
        `${right.authSource}:${right.externalUserId}`
      )
    );
}

export function createPostgresUsersStore(db: PostgresConnection): UserStore {
  return {
    async resolveUserIdentity(input: ResolveUserIdentityInput) {
      return resolveUserIdentity(db, input, (event) => appendPostgresAuditEvent(db, event));
    },
    async getUser(input: Parameters<UserStore["getUser"]>[0]): Promise<UserRecord | undefined> {
      return getUserRecord(db, input.clientInstanceId, input.userId);
    },
    async countActiveUsers({ clientInstanceId }) {
      const [row] = await db
        .select({ count: drizzleSql<number>`count(*)::integer` })
        .from(productUsers)
        .where(
          and(
            eq(productUsers.clientInstanceId, clientInstanceId),
            eq(productUsers.status, "active"),
            isNull(productUsers.deletionRequestedAt)
          )
        );
      return row?.count ?? 0;
    },
    async listUsers(input: Parameters<UserStore["listUsers"]>[0]): Promise<UserRecord[]> {
      return listUsers(db, input);
    },
    async getInstanceAdminName({ clientInstanceId }) {
      // The existing product_users_client_idx bounds the lookup to this instance. Read only
      // the name: listUsers also loads identities and grants that help text must not need.
      const [admin] = await db
        .select({ displayLabel: productUsers.displayLabel })
        .from(productUsers)
        .where(
          and(
            eq(productUsers.clientInstanceId, clientInstanceId),
            drizzleSql`${productUsers.roles} ?| array['admin', 'superadmin']`,
            eq(productUsers.status, "active"),
            isNull(productUsers.deletionRequestedAt),
            isNotNull(productUsers.lastAuthenticatedAt)
          )
        )
        .orderBy(
          desc(productUsers.lastAuthenticatedAt),
          drizzleSql`${productUsers.displayLabel} COLLATE "C"`,
          drizzleSql`${productUsers.id} COLLATE "C"`
        )
        .limit(1);
      return admin?.displayLabel;
    },
    async createUser(input: CreateUserInput): Promise<UserRecord> {
      return createUser(db, input);
    },
    async updateUser(input: UpdateUserInput): Promise<UserRecord> {
      return updateUser(db, input);
    },
    async markUserDeletionRequested(input: DeleteUserInput): Promise<boolean> {
      return markUserDeletionRequested(db, input);
    },
    async deleteUser(input: DeleteUserInput): Promise<UserRecord> {
      return deleteUser(db, input);
    },
    async upsertUserIdentity(input: UpsertUserIdentityInput): Promise<UserRecord> {
      return upsertUserIdentity(db, input);
    },
    async deleteUserIdentity(input: DeleteUserIdentityInput): Promise<UserRecord> {
      return deleteUserIdentity(db, input);
    },
    async getUserModelPreference(
      input: UserModelPreferenceInput
    ): Promise<UserModelPreference | undefined> {
      return getUserModelPreference(db, input);
    },
    async setUserModelPreference(
      input: UserModelPreferenceInput & {
        preference: UserModelPreference;
      }
    ): Promise<void> {
      return setUserModelPreference(db, input);
    }
  };
}
