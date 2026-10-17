import { and, asc, eq, ilike, inArray, isNull, or, sql as drizzleSql, type SQL } from "drizzle-orm";
import {
  AppError,
  asCollaborationWorkspaceId,
  asUserId,
  type ClientInstanceId,
  type CollaborationWorkspace,
  type CollaborationWorkspaceId,
  type CollaborationWorkspaceStore,
  type CollaborationWorkspaceWithRole,
  type CreateWorkspaceInput,
  type UpdateWorkspaceInput,
  type UserId,
  type WorkspaceAccessRequest,
  type WorkspaceMemberCandidate,
  type WorkspaceMembership,
  createCollaborationWorkspaceId,
  createWorkspaceAccessRequestId,
  validateWorkspaceCreation,
  type WorkspaceInDeletion
} from "@work-shape/catalyst-core";
import { lockRights } from "./rights-lock";
import { containsPattern } from "./like-pattern";
import { deleteWorkspaceOwnedAssets } from "./postgres-config-asset-operations";
import { type PostgresConnection, type PostgresTransaction } from "./postgres-database";
import { requireNoPendingConversationCleanup } from "./postgres-pending-cleanup";
import {
  mapCollaborationWorkspace,
  mapCollaborationWorkspaceWithRole,
  mapWorkspaceAccessRequest,
  mapWorkspaceMembership
} from "./rows";
import {
  collaborationWorkspaceAccessRequests,
  collaborationWorkspaceMemberships,
  collaborationWorkspaces,
  conversations,
  productUsers,
  userIdentities
} from "./schema";

type WorkspaceDatabase = PostgresConnection;

async function createWorkspace(
  db: PostgresConnection,
  input: CreateWorkspaceInput
): Promise<CollaborationWorkspace> {
  validateWorkspaceCreation(input);
  return db.transaction(async (tx) => createWorkspaceRecords(tx, input));
}

/** The condition every read carries: a workspace whose deletion was requested is closed. */
export const notInDeletion = isNull(collaborationWorkspaces.deletionRequestedAt);

async function getWorkspace(
  db: WorkspaceDatabase,
  clientInstanceId: ClientInstanceId,
  collaborationWorkspaceId: CollaborationWorkspaceId
): Promise<CollaborationWorkspace | undefined> {
  const [row] = await db
    .select()
    .from(collaborationWorkspaces)
    .where(
      and(
        eq(collaborationWorkspaces.clientInstanceId, clientInstanceId),
        eq(collaborationWorkspaces.id, collaborationWorkspaceId),
        notInDeletion
      )
    )
    .limit(1);
  return row ? mapCollaborationWorkspace(row) : undefined;
}

async function listWorkspacesForUser(
  db: PostgresConnection,
  input: Parameters<CollaborationWorkspaceStore["listWorkspacesForUser"]>[0]
): Promise<CollaborationWorkspaceWithRole[]> {
  const rows = await db
    .select({ workspace: collaborationWorkspaces, role: collaborationWorkspaceMemberships.role })
    .from(collaborationWorkspaceMemberships)
    .innerJoin(
      collaborationWorkspaces,
      and(
        eq(collaborationWorkspaces.id, collaborationWorkspaceMemberships.collaborationWorkspaceId),
        eq(
          collaborationWorkspaces.clientInstanceId,
          collaborationWorkspaceMemberships.clientInstanceId
        )
      )
    )
    .where(
      and(
        eq(collaborationWorkspaceMemberships.clientInstanceId, input.clientInstanceId),
        eq(collaborationWorkspaceMemberships.userId, input.userId),
        notInDeletion
      )
    )
    .orderBy(asc(collaborationWorkspaces.createdAt), asc(collaborationWorkspaces.id));
  return rows.map(mapCollaborationWorkspaceWithRole);
}

async function listDiscoverableWorkspaces(
  db: PostgresConnection,
  input: Parameters<CollaborationWorkspaceStore["listDiscoverableWorkspaces"]>[0]
): Promise<CollaborationWorkspace[]> {
  const rows = await db
    .select()
    .from(collaborationWorkspaces)
    .where(
      and(
        eq(collaborationWorkspaces.clientInstanceId, input.clientInstanceId),
        eq(collaborationWorkspaces.kind, "shared"),
        eq(collaborationWorkspaces.visibility, "discoverable"),
        notInDeletion
      )
    )
    .orderBy(asc(collaborationWorkspaces.createdAt), asc(collaborationWorkspaces.id));
  return rows.map(mapCollaborationWorkspace);
}

async function listSharedWorkspaces(
  db: PostgresConnection,
  input: Parameters<CollaborationWorkspaceStore["listSharedWorkspaces"]>[0]
): Promise<CollaborationWorkspace[]> {
  const rows = await db
    .select()
    .from(collaborationWorkspaces)
    .where(
      and(
        eq(collaborationWorkspaces.clientInstanceId, input.clientInstanceId),
        eq(collaborationWorkspaces.kind, "shared"),
        notInDeletion
      )
    )
    .orderBy(asc(collaborationWorkspaces.createdAt), asc(collaborationWorkspaces.id));
  return rows.map(mapCollaborationWorkspace);
}

async function updateWorkspace(
  db: PostgresConnection,
  input: UpdateWorkspaceInput
): Promise<CollaborationWorkspace> {
  const workspace = await requireWorkspace(
    db,
    input.clientInstanceId,
    input.collaborationWorkspaceId
  );
  if (workspace.kind === "personal") {
    if (input.name !== undefined) {
      throw new AppError("VALIDATION_FAILED", "A Personal Workspace cannot be renamed");
    }
    if (input.visibility !== undefined && input.visibility !== "private") {
      throw new AppError("VALIDATION_FAILED", "A Personal Workspace must remain private");
    }
    if (input.defaultConversationVisibility === "private") {
      throw new AppError(
        "VALIDATION_FAILED",
        "A Personal Workspace cannot default to private conversations"
      );
    }
  }

  const set: Partial<typeof collaborationWorkspaces.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) set.name = input.name;
  if (input.description !== undefined) set.description = input.description;
  if (input.visibility !== undefined) set.visibility = input.visibility;
  if (input.defaultConversationVisibility !== undefined) {
    set.defaultConversationVisibility = input.defaultConversationVisibility;
  }
  if (input.emoji !== undefined) set.emoji = input.emoji;
  if (input.accentColor !== undefined) set.accentColor = input.accentColor;
  const [row] = await db
    .update(collaborationWorkspaces)
    .set(set)
    .where(
      and(
        eq(collaborationWorkspaces.clientInstanceId, input.clientInstanceId),
        eq(collaborationWorkspaces.id, input.collaborationWorkspaceId)
      )
    )
    .returning();
  return mapCollaborationWorkspace(row);
}

async function ensurePersonalWorkspace(
  db: PostgresConnection,
  input: Parameters<CollaborationWorkspaceStore["ensurePersonalWorkspace"]>[0]
): Promise<CollaborationWorkspace> {
  return db.transaction(async (tx) => ensurePersonalWorkspaceInTransaction(tx, input));
}

export async function ensurePersonalWorkspaceInTransaction(
  db: PostgresTransaction,
  input: Parameters<CollaborationWorkspaceStore["ensurePersonalWorkspace"]>[0]
): Promise<CollaborationWorkspace> {
  const existing = await getPersonalWorkspace(db, input.clientInstanceId, input.userId);
  if (existing) return existing;
  await lockRights(db, input);
  const concurrent = await getPersonalWorkspace(db, input.clientInstanceId, input.userId);
  if (concurrent) return concurrent;

  const id = createCollaborationWorkspaceId();
  const now = new Date();
  const [created] = await db
    .insert(collaborationWorkspaces)
    .values({
      id,
      clientInstanceId: input.clientInstanceId,
      kind: "personal",
      name: "Personal workspace",
      description: null,
      visibility: "private",
      emoji: null,
      accentColor: null,
      personalUserId: input.userId,
      createdAt: now,
      updatedAt: now
    })
    .onConflictDoNothing()
    .returning();
  const workspace = created
    ? mapCollaborationWorkspace(created)
    : await getPersonalWorkspace(db, input.clientInstanceId, input.userId);
  if (!workspace) {
    throw new AppError("INTERNAL", "Failed to provision Personal Workspace");
  }
  await db
    .insert(collaborationWorkspaceMemberships)
    .values({
      collaborationWorkspaceId: workspace.id,
      clientInstanceId: input.clientInstanceId,
      userId: input.userId,
      role: "owner",
      createdAt: now,
      updatedAt: now
    })
    .onConflictDoNothing();
  return workspace;
}

async function addMembership(
  db: PostgresConnection,
  input: Parameters<CollaborationWorkspaceStore["addMembership"]>[0]
): Promise<WorkspaceMembership> {
  return db.transaction(async (tx) => {
    await lockRights(tx, input);
    const workspace = await requireWorkspace(
      tx,
      input.clientInstanceId,
      input.collaborationWorkspaceId
    );
    if (workspace.kind === "personal") {
      throw new AppError("VALIDATION_FAILED", "A Personal Workspace cannot gain members");
    }
    if (await getMembership(tx, input)) {
      throw new AppError("CONFLICT", "Workspace Membership already exists");
    }
    const now = new Date();
    const [row] = await tx
      .insert(collaborationWorkspaceMemberships)
      .values({ ...input, createdAt: now, updatedAt: now })
      .returning();
    return mapWorkspaceMembership(row);
  });
}

async function updateMembershipRole(
  db: PostgresConnection,
  input: Parameters<CollaborationWorkspaceStore["updateMembershipRole"]>[0]
): Promise<WorkspaceMembership> {
  return db.transaction(async (tx) => {
    await lockRights(tx, input);
    const workspace = await requireWorkspace(
      tx,
      input.clientInstanceId,
      input.collaborationWorkspaceId
    );
    if (workspace.kind === "personal") {
      throw new AppError("VALIDATION_FAILED", "A Personal Workspace membership cannot change");
    }
    const [row] = await tx
      .update(collaborationWorkspaceMemberships)
      .set({ role: input.role, updatedAt: new Date() })
      .where(membershipWhere(input))
      .returning();
    if (!row) throw new AppError("NOT_FOUND", "Workspace Membership is not available");
    return mapWorkspaceMembership(row);
  });
}

async function removeMembership(
  db: PostgresConnection,
  input: Parameters<CollaborationWorkspaceStore["removeMembership"]>[0]
): Promise<WorkspaceMembership> {
  return db.transaction(async (tx) => {
    await lockRights(tx, input);
    const workspace = await requireWorkspace(
      tx,
      input.clientInstanceId,
      input.collaborationWorkspaceId
    );
    if (workspace.kind === "personal") {
      throw new AppError("VALIDATION_FAILED", "A Personal Workspace membership cannot be removed");
    }
    const [row] = await tx
      .delete(collaborationWorkspaceMemberships)
      .where(membershipWhere(input))
      .returning();
    if (!row) throw new AppError("NOT_FOUND", "Workspace Membership is not available");
    return mapWorkspaceMembership(row);
  });
}

async function listMemberships(
  db: PostgresConnection,
  input: Parameters<CollaborationWorkspaceStore["listMemberships"]>[0]
): Promise<WorkspaceMembership[]> {
  await requireWorkspace(db, input.clientInstanceId, input.collaborationWorkspaceId);
  const rows = await db
    .select()
    .from(collaborationWorkspaceMemberships)
    .where(
      and(
        eq(collaborationWorkspaceMemberships.clientInstanceId, input.clientInstanceId),
        eq(
          collaborationWorkspaceMemberships.collaborationWorkspaceId,
          input.collaborationWorkspaceId
        )
      )
    )
    .orderBy(
      asc(collaborationWorkspaceMemberships.createdAt),
      asc(collaborationWorkspaceMemberships.userId)
    );
  return rows.map(mapWorkspaceMembership);
}

async function countMembersOfWorkspaces(
  db: PostgresConnection,
  input: Parameters<CollaborationWorkspaceStore["countMembersOfWorkspaces"]>[0]
): Promise<{ id: CollaborationWorkspaceId; name: string; members: number }[]> {
  if (input.collaborationWorkspaceIds.length === 0) return [];
  const rows = await db
    .select({
      id: collaborationWorkspaces.id,
      name: collaborationWorkspaces.name,
      members: drizzleSql<number>`count(${collaborationWorkspaceMemberships.userId})::int`
    })
    .from(collaborationWorkspaces)
    .leftJoin(
      collaborationWorkspaceMemberships,
      and(
        eq(
          collaborationWorkspaceMemberships.clientInstanceId,
          collaborationWorkspaces.clientInstanceId
        ),
        eq(collaborationWorkspaceMemberships.collaborationWorkspaceId, collaborationWorkspaces.id)
      )
    )
    .where(
      and(
        eq(collaborationWorkspaces.clientInstanceId, input.clientInstanceId),
        inArray(collaborationWorkspaces.id, [...input.collaborationWorkspaceIds]),
        notInDeletion
      )
    )
    .groupBy(collaborationWorkspaces.id, collaborationWorkspaces.name);
  return rows.map((row) => ({
    id: asCollaborationWorkspaceId(row.id),
    name: row.name,
    members: row.members
  }));
}

async function searchMemberCandidates(
  db: PostgresConnection,
  input: Parameters<CollaborationWorkspaceStore["searchMemberCandidates"]>[0]
): Promise<WorkspaceMemberCandidate[]> {
  await requireWorkspace(db, input.clientInstanceId, input.collaborationWorkspaceId);
  const pattern = containsPattern(input.query);
  const effectiveEmail = drizzleSql<string | null>`coalesce(
    ${productUsers.email},
    (
      select min(${userIdentities.email})
      from ${userIdentities}
      where ${userIdentities.clientInstanceId} = ${productUsers.clientInstanceId}
        and ${userIdentities.userId} = ${productUsers.id}
        and ${userIdentities.emailVerified} = true
        and ${userIdentities.email} is not null
    )
  )`;
  const hasPendingAccessRequest = drizzleSql<boolean>`exists (
    select 1
    from ${collaborationWorkspaceAccessRequests}
    where ${collaborationWorkspaceAccessRequests.clientInstanceId} = ${input.clientInstanceId}
      and ${collaborationWorkspaceAccessRequests.collaborationWorkspaceId} = ${input.collaborationWorkspaceId}
      and ${collaborationWorkspaceAccessRequests.userId} = ${productUsers.id}
  )`;
  const verifiedIdentityEmailMatches = drizzleSql<boolean>`exists (
    select 1
    from ${userIdentities}
    where ${userIdentities.clientInstanceId} = ${productUsers.clientInstanceId}
      and ${userIdentities.userId} = ${productUsers.id}
      and ${userIdentities.emailVerified} = true
      and ${userIdentities.email} ilike ${pattern}
  )`;
  const rows = await db
    .select({
      userId: productUsers.id,
      displayLabel: productUsers.displayLabel,
      email: effectiveEmail,
      hasPendingAccessRequest
    })
    .from(productUsers)
    .leftJoin(
      collaborationWorkspaceMemberships,
      and(
        eq(collaborationWorkspaceMemberships.clientInstanceId, productUsers.clientInstanceId),
        eq(
          collaborationWorkspaceMemberships.collaborationWorkspaceId,
          input.collaborationWorkspaceId
        ),
        eq(collaborationWorkspaceMemberships.userId, productUsers.id)
      )
    )
    .where(
      and(
        eq(productUsers.clientInstanceId, input.clientInstanceId),
        eq(productUsers.status, "active"),
        isNull(productUsers.deletionRequestedAt),
        isNull(collaborationWorkspaceMemberships.userId),
        drizzleSql`${effectiveEmail} is not null`,
        or(
          ilike(productUsers.displayLabel, pattern),
          ilike(productUsers.email, pattern),
          verifiedIdentityEmailMatches
        )
      )
    )
    .orderBy(
      asc(drizzleSql`lower(${productUsers.displayLabel})`),
      asc(drizzleSql`lower(${effectiveEmail})`),
      asc(productUsers.id)
    )
    .limit(input.limit);
  return rows.map((row) => {
    if (row.email === null) throw new Error("Workspace candidate email is missing");
    return {
      userId: asUserId(row.userId),
      displayLabel: row.displayLabel,
      email: row.email,
      hasPendingAccessRequest: row.hasPendingAccessRequest
    };
  });
}

async function getMembership(
  db: WorkspaceDatabase,
  input: Parameters<CollaborationWorkspaceStore["getMembership"]>[0]
): Promise<WorkspaceMembership | undefined> {
  const [row] = await db
    .select({ membership: collaborationWorkspaceMemberships })
    .from(collaborationWorkspaceMemberships)
    .innerJoin(
      collaborationWorkspaces,
      and(
        eq(collaborationWorkspaces.id, collaborationWorkspaceMemberships.collaborationWorkspaceId),
        eq(
          collaborationWorkspaces.clientInstanceId,
          collaborationWorkspaceMemberships.clientInstanceId
        )
      )
    )
    .where(and(membershipWhere(input), notInDeletion))
    .limit(1);
  return row ? mapWorkspaceMembership(row.membership) : undefined;
}

async function createAccessRequest(
  db: PostgresConnection,
  input: Parameters<CollaborationWorkspaceStore["createAccessRequest"]>[0]
): Promise<WorkspaceAccessRequest> {
  const workspace = await requireWorkspace(
    db,
    input.clientInstanceId,
    input.collaborationWorkspaceId
  );
  if (workspace.kind !== "shared" || workspace.visibility !== "discoverable") {
    throw new AppError(
      "VALIDATION_FAILED",
      "Access requests require a Discoverable Shared Workspace"
    );
  }
  if (await getMembership(db, input)) {
    throw new AppError("CONFLICT", "User is already a workspace member");
  }
  if (await getAccessRequest(db, input)) {
    throw new AppError("CONFLICT", "Workspace Access Request already exists");
  }
  const [row] = await db
    .insert(collaborationWorkspaceAccessRequests)
    .values({
      id: createWorkspaceAccessRequestId(),
      ...input,
      createdAt: new Date()
    })
    .returning();
  return mapWorkspaceAccessRequest(row);
}

async function deleteAccessRequest(
  db: PostgresConnection,
  input: Parameters<CollaborationWorkspaceStore["deleteAccessRequest"]>[0]
): Promise<WorkspaceAccessRequest> {
  const [row] = await db
    .delete(collaborationWorkspaceAccessRequests)
    .where(accessRequestWhere(input))
    .returning();
  if (!row) throw new AppError("NOT_FOUND", "Workspace Access Request is not available");
  return mapWorkspaceAccessRequest(row);
}

async function listAccessRequestsForWorkspace(
  db: PostgresConnection,
  input: Parameters<CollaborationWorkspaceStore["listAccessRequestsForWorkspace"]>[0]
): Promise<WorkspaceAccessRequest[]> {
  await requireWorkspace(db, input.clientInstanceId, input.collaborationWorkspaceId);
  const rows = await db
    .select()
    .from(collaborationWorkspaceAccessRequests)
    .where(
      and(
        eq(collaborationWorkspaceAccessRequests.clientInstanceId, input.clientInstanceId),
        eq(
          collaborationWorkspaceAccessRequests.collaborationWorkspaceId,
          input.collaborationWorkspaceId
        )
      )
    )
    .orderBy(
      asc(collaborationWorkspaceAccessRequests.createdAt),
      asc(collaborationWorkspaceAccessRequests.id)
    );
  return rows.map(mapWorkspaceAccessRequest);
}

async function getAccessRequest(
  db: WorkspaceDatabase,
  input: Parameters<CollaborationWorkspaceStore["getAccessRequest"]>[0]
): Promise<WorkspaceAccessRequest | undefined> {
  const [row] = await db
    .select()
    .from(collaborationWorkspaceAccessRequests)
    .where(accessRequestWhere(input))
    .limit(1);
  return row ? mapWorkspaceAccessRequest(row) : undefined;
}

async function deleteAccessRequestsForUser(
  db: PostgresConnection,
  input: Parameters<CollaborationWorkspaceStore["deleteAccessRequestsForUser"]>[0]
): Promise<number> {
  const rows = await db
    .delete(collaborationWorkspaceAccessRequests)
    .where(
      and(
        eq(collaborationWorkspaceAccessRequests.clientInstanceId, input.clientInstanceId),
        eq(collaborationWorkspaceAccessRequests.userId, input.userId)
      )
    )
    .returning({ id: collaborationWorkspaceAccessRequests.id });
  return rows.length;
}

async function removeMembershipsForUser(
  db: PostgresConnection,
  input: Parameters<CollaborationWorkspaceStore["removeMembershipsForUser"]>[0]
): Promise<number> {
  const sharedWorkspaceRows = await db
    .select({ id: collaborationWorkspaces.id })
    .from(collaborationWorkspaces)
    .where(
      and(
        eq(collaborationWorkspaces.clientInstanceId, input.clientInstanceId),
        eq(collaborationWorkspaces.kind, "shared")
      )
    );
  if (sharedWorkspaceRows.length === 0) return 0;
  const rows = await db
    .delete(collaborationWorkspaceMemberships)
    .where(
      and(
        eq(collaborationWorkspaceMemberships.clientInstanceId, input.clientInstanceId),
        eq(collaborationWorkspaceMemberships.userId, input.userId),
        inArray(
          collaborationWorkspaceMemberships.collaborationWorkspaceId,
          sharedWorkspaceRows.map((row) => row.id)
        )
      )
    )
    .returning({ userId: collaborationWorkspaceMemberships.userId });
  return rows.length;
}

async function deletePersonalWorkspaceForUser(
  db: PostgresConnection,
  input: Parameters<CollaborationWorkspaceStore["deletePersonalWorkspaceForUser"]>[0]
): Promise<CollaborationWorkspace> {
  return db.transaction(async (tx) => {
    await lockWorkspaceForHardDelete(
      tx,
      and(
        eq(collaborationWorkspaces.clientInstanceId, input.clientInstanceId),
        eq(collaborationWorkspaces.kind, "personal"),
        eq(collaborationWorkspaces.personalUserId, input.userId)
      )
    );
    const workspace = await getPersonalWorkspace(tx, input.clientInstanceId, input.userId);
    if (!workspace) {
      throw new AppError("NOT_FOUND", "Personal Workspace is not available");
    }
    const [activeConversation] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.clientInstanceId, input.clientInstanceId),
          eq(conversations.collaborationWorkspaceId, workspace.id),
          eq(conversations.status, "active")
        )
      )
      .limit(1);
    if (activeConversation) {
      throw new AppError("CONFLICT", "Personal Workspace still has active conversations");
    }
    await requireNoPendingConversationCleanup(tx, workspace);
    await tx
      .delete(conversations)
      .where(
        and(
          eq(conversations.clientInstanceId, input.clientInstanceId),
          eq(conversations.collaborationWorkspaceId, workspace.id)
        )
      );
    await deleteWorkspaceOwnedAssets(tx, {
      clientInstanceId: input.clientInstanceId,
      collaborationWorkspaceId: workspace.id
    });
    await tx
      .delete(collaborationWorkspaces)
      .where(
        and(
          eq(collaborationWorkspaces.clientInstanceId, input.clientInstanceId),
          eq(collaborationWorkspaces.id, workspace.id),
          eq(collaborationWorkspaces.kind, "personal")
        )
      );
    return workspace;
  });
}

async function createWorkspaceRecords(
  db: PostgresTransaction,
  input: CreateWorkspaceInput
): Promise<CollaborationWorkspace> {
  await lockRights(db, { clientInstanceId: input.clientInstanceId, userId: input.creatorUserId });
  const now = new Date();
  const [user] = await db
    .select({ id: productUsers.id })
    .from(productUsers)
    .where(
      and(
        eq(productUsers.clientInstanceId, input.clientInstanceId),
        eq(productUsers.id, input.creatorUserId)
      )
    )
    .limit(1);
  if (!user) throw new AppError("NOT_FOUND", "User is not available");
  if (
    input.kind === "personal" &&
    (await getPersonalWorkspace(db, input.clientInstanceId, input.creatorUserId))
  ) {
    throw new AppError("CONFLICT", "User already has a Personal Workspace");
  }
  const [row] = await db
    .insert(collaborationWorkspaces)
    .values({
      id: createCollaborationWorkspaceId(),
      clientInstanceId: input.clientInstanceId,
      kind: input.kind,
      name: input.name,
      description: input.description ?? null,
      visibility: input.kind === "personal" ? "private" : (input.visibility ?? "discoverable"),
      defaultConversationVisibility: input.defaultConversationVisibility ?? "workspace",
      emoji: input.emoji ?? null,
      accentColor: input.accentColor ?? null,
      personalUserId: input.kind === "personal" ? input.personalUserId : null,
      createdAt: now,
      updatedAt: now
    })
    .returning();
  if (!row) throw new Error("Workspace insert returned no row");
  await db.insert(collaborationWorkspaceMemberships).values({
    collaborationWorkspaceId: row.id,
    clientInstanceId: input.clientInstanceId,
    userId: input.creatorUserId,
    role: "owner",
    createdAt: now,
    updatedAt: now
  });
  return mapCollaborationWorkspace(row);
}

async function getPersonalWorkspace(
  db: WorkspaceDatabase,
  clientInstanceId: ClientInstanceId,
  userId: UserId
): Promise<CollaborationWorkspace | undefined> {
  const [row] = await db
    .select()
    .from(collaborationWorkspaces)
    .where(
      and(
        eq(collaborationWorkspaces.clientInstanceId, clientInstanceId),
        eq(collaborationWorkspaces.kind, "personal"),
        eq(collaborationWorkspaces.personalUserId, userId)
      )
    )
    .limit(1);
  return row ? mapCollaborationWorkspace(row) : undefined;
}

/**
 * Takes the workspace row lock before a hard delete looks at the Conversations. Creating a
 * Conversation in the workspace, or moving one in, takes a key-share lock on this row through
 * the foreign key, so it waits and then fails instead of being removed with the rest.
 */
export async function lockWorkspaceForHardDelete(
  tx: PostgresTransaction,
  workspace: SQL | undefined
): Promise<void> {
  await tx
    .select({ id: collaborationWorkspaces.id })
    .from(collaborationWorkspaces)
    .where(workspace)
    .for("update");
}

async function requireWorkspace(
  db: WorkspaceDatabase,
  clientInstanceId: ClientInstanceId,
  collaborationWorkspaceId: CollaborationWorkspaceId
): Promise<CollaborationWorkspace> {
  const workspace = await getWorkspace(db, clientInstanceId, collaborationWorkspaceId);
  if (!workspace) throw new AppError("NOT_FOUND", "Collaboration Workspace is not available");
  return workspace;
}

export function workspaceRowWhere(input: {
  clientInstanceId: ClientInstanceId;
  collaborationWorkspaceId: CollaborationWorkspaceId;
}) {
  return and(
    eq(collaborationWorkspaces.clientInstanceId, input.clientInstanceId),
    eq(collaborationWorkspaces.id, input.collaborationWorkspaceId)
  );
}

function membershipWhere(input: {
  clientInstanceId: ClientInstanceId;
  collaborationWorkspaceId: CollaborationWorkspaceId;
  userId: UserId;
}) {
  return and(
    eq(collaborationWorkspaceMemberships.clientInstanceId, input.clientInstanceId),
    eq(collaborationWorkspaceMemberships.collaborationWorkspaceId, input.collaborationWorkspaceId),
    eq(collaborationWorkspaceMemberships.userId, input.userId)
  );
}

function accessRequestWhere(input: {
  clientInstanceId: ClientInstanceId;
  collaborationWorkspaceId: CollaborationWorkspaceId;
  userId: UserId;
}) {
  return and(
    eq(collaborationWorkspaceAccessRequests.clientInstanceId, input.clientInstanceId),
    eq(
      collaborationWorkspaceAccessRequests.collaborationWorkspaceId,
      input.collaborationWorkspaceId
    ),
    eq(collaborationWorkspaceAccessRequests.userId, input.userId)
  );
}

// The composition root supplies operations whose query modules depend on this module.
export function createPostgresWorkspacesStore(
  db: PostgresConnection,
  deps: Pick<
    CollaborationWorkspaceStore,
    | "deleteWorkspace"
    | "getWorkspaceInDeletion"
    | "lockWorkspacesForOwnerChange"
    | "markWorkspaceDeletionRequested"
  >
): CollaborationWorkspaceStore {
  return {
    async createWorkspace(input: CreateWorkspaceInput): Promise<CollaborationWorkspace> {
      return createWorkspace(db, input);
    },
    async getWorkspace(
      clientInstanceId: ClientInstanceId,
      collaborationWorkspaceId: CollaborationWorkspaceId
    ): Promise<CollaborationWorkspace | undefined> {
      return getWorkspace(db, clientInstanceId, collaborationWorkspaceId);
    },
    async listWorkspacesForUser(
      input: Parameters<CollaborationWorkspaceStore["listWorkspacesForUser"]>[0]
    ): Promise<CollaborationWorkspaceWithRole[]> {
      return listWorkspacesForUser(db, input);
    },
    async listDiscoverableWorkspaces(
      input: Parameters<CollaborationWorkspaceStore["listDiscoverableWorkspaces"]>[0]
    ): Promise<CollaborationWorkspace[]> {
      return listDiscoverableWorkspaces(db, input);
    },
    async listSharedWorkspaces(
      input: Parameters<CollaborationWorkspaceStore["listSharedWorkspaces"]>[0]
    ): Promise<CollaborationWorkspace[]> {
      return listSharedWorkspaces(db, input);
    },
    async updateWorkspace(input: UpdateWorkspaceInput): Promise<CollaborationWorkspace> {
      return updateWorkspace(db, input);
    },
    async markWorkspaceDeletionRequested(
      input: Parameters<CollaborationWorkspaceStore["markWorkspaceDeletionRequested"]>[0]
    ): Promise<boolean> {
      return deps.markWorkspaceDeletionRequested(input);
    },
    async lockWorkspacesForOwnerChange(
      input: Parameters<CollaborationWorkspaceStore["lockWorkspacesForOwnerChange"]>[0]
    ): Promise<void> {
      return deps.lockWorkspacesForOwnerChange(input);
    },
    async getWorkspaceInDeletion(
      input: Parameters<CollaborationWorkspaceStore["getWorkspaceInDeletion"]>[0]
    ): Promise<WorkspaceInDeletion | undefined> {
      return deps.getWorkspaceInDeletion(input);
    },
    async deleteWorkspace(
      input: Parameters<CollaborationWorkspaceStore["deleteWorkspace"]>[0]
    ): Promise<CollaborationWorkspace> {
      return deps.deleteWorkspace(input);
    },
    async ensurePersonalWorkspace(
      input: Parameters<CollaborationWorkspaceStore["ensurePersonalWorkspace"]>[0]
    ): Promise<CollaborationWorkspace> {
      return ensurePersonalWorkspace(db, input);
    },
    async addMembership(
      input: Parameters<CollaborationWorkspaceStore["addMembership"]>[0]
    ): Promise<WorkspaceMembership> {
      return addMembership(db, input);
    },
    async updateMembershipRole(
      input: Parameters<CollaborationWorkspaceStore["updateMembershipRole"]>[0]
    ): Promise<WorkspaceMembership> {
      return updateMembershipRole(db, input);
    },
    async removeMembership(
      input: Parameters<CollaborationWorkspaceStore["removeMembership"]>[0]
    ): Promise<WorkspaceMembership> {
      return removeMembership(db, input);
    },
    async listMemberships(
      input: Parameters<CollaborationWorkspaceStore["listMemberships"]>[0]
    ): Promise<WorkspaceMembership[]> {
      return listMemberships(db, input);
    },
    async countMembersOfWorkspaces(
      input: Parameters<CollaborationWorkspaceStore["countMembersOfWorkspaces"]>[0]
    ) {
      return countMembersOfWorkspaces(db, input);
    },
    async searchMemberCandidates(
      input: Parameters<CollaborationWorkspaceStore["searchMemberCandidates"]>[0]
    ): Promise<WorkspaceMemberCandidate[]> {
      return searchMemberCandidates(db, input);
    },
    async getMembership(
      input: Parameters<CollaborationWorkspaceStore["getMembership"]>[0]
    ): Promise<WorkspaceMembership | undefined> {
      return getMembership(db, input);
    },
    async createAccessRequest(
      input: Parameters<CollaborationWorkspaceStore["createAccessRequest"]>[0]
    ): Promise<WorkspaceAccessRequest> {
      return createAccessRequest(db, input);
    },
    async deleteAccessRequest(
      input: Parameters<CollaborationWorkspaceStore["deleteAccessRequest"]>[0]
    ): Promise<WorkspaceAccessRequest> {
      return deleteAccessRequest(db, input);
    },
    async listAccessRequestsForWorkspace(
      input: Parameters<CollaborationWorkspaceStore["listAccessRequestsForWorkspace"]>[0]
    ): Promise<WorkspaceAccessRequest[]> {
      return listAccessRequestsForWorkspace(db, input);
    },
    async getAccessRequest(
      input: Parameters<CollaborationWorkspaceStore["getAccessRequest"]>[0]
    ): Promise<WorkspaceAccessRequest | undefined> {
      return getAccessRequest(db, input);
    },
    async deleteAccessRequestsForUser(
      input: Parameters<CollaborationWorkspaceStore["deleteAccessRequestsForUser"]>[0]
    ): Promise<number> {
      return deleteAccessRequestsForUser(db, input);
    },
    async removeMembershipsForUser(
      input: Parameters<CollaborationWorkspaceStore["removeMembershipsForUser"]>[0]
    ): Promise<number> {
      return removeMembershipsForUser(db, input);
    },
    async deletePersonalWorkspaceForUser(
      input: Parameters<CollaborationWorkspaceStore["deletePersonalWorkspaceForUser"]>[0]
    ): Promise<CollaborationWorkspace> {
      return deletePersonalWorkspaceForUser(db, input);
    }
  };
}
