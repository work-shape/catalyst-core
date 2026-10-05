import { and, asc, eq, ilike, inArray, isNull, or, sql as drizzleSql } from "drizzle-orm";
import {
  AppError,
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
  validateWorkspaceCreation
} from "@vivd-catalyst/core";
import type { PostgresDatabase, PostgresTransaction } from "./postgres-database";
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

type WorkspaceDatabase = PostgresDatabase | PostgresTransaction;

export async function createWorkspace(
  db: PostgresDatabase,
  input: CreateWorkspaceInput
): Promise<CollaborationWorkspace> {
  validateWorkspaceCreation(input);
  return db.transaction(async (tx) => createWorkspaceRecords(tx, input));
}

export async function getWorkspace(
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
        eq(collaborationWorkspaces.id, collaborationWorkspaceId)
      )
    )
    .limit(1);
  return row ? mapCollaborationWorkspace(row) : undefined;
}

export async function listWorkspacesForUser(
  db: PostgresDatabase,
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
        eq(collaborationWorkspaceMemberships.userId, input.userId)
      )
    )
    .orderBy(asc(collaborationWorkspaces.createdAt));
  return rows.map(mapCollaborationWorkspaceWithRole);
}

export async function listDiscoverableWorkspaces(
  db: PostgresDatabase,
  input: Parameters<CollaborationWorkspaceStore["listDiscoverableWorkspaces"]>[0]
): Promise<CollaborationWorkspace[]> {
  const rows = await db
    .select()
    .from(collaborationWorkspaces)
    .where(
      and(
        eq(collaborationWorkspaces.clientInstanceId, input.clientInstanceId),
        eq(collaborationWorkspaces.kind, "shared"),
        eq(collaborationWorkspaces.visibility, "discoverable")
      )
    )
    .orderBy(asc(collaborationWorkspaces.createdAt));
  return rows.map(mapCollaborationWorkspace);
}

export async function updateWorkspace(
  db: PostgresDatabase,
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

export async function deleteWorkspace(
  db: PostgresDatabase,
  input: Parameters<CollaborationWorkspaceStore["deleteWorkspace"]>[0]
): Promise<CollaborationWorkspace> {
  return db.transaction(async (tx) => {
    const workspace = await requireWorkspace(
      tx,
      input.clientInstanceId,
      input.collaborationWorkspaceId
    );
    if (workspace.kind === "personal") {
      throw new AppError("VALIDATION_FAILED", "A Personal Workspace cannot be deleted");
    }
    const [activeConversation] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.clientInstanceId, input.clientInstanceId),
          eq(conversations.collaborationWorkspaceId, input.collaborationWorkspaceId),
          eq(conversations.status, "active")
        )
      )
      .limit(1);
    if (activeConversation) {
      throw new AppError("CONFLICT", "Workspace still contains conversations");
    }
    await tx
      .delete(conversations)
      .where(
        and(
          eq(conversations.clientInstanceId, input.clientInstanceId),
          eq(conversations.collaborationWorkspaceId, input.collaborationWorkspaceId)
        )
      );
    await tx
      .delete(collaborationWorkspaceAccessRequests)
      .where(
        and(
          eq(collaborationWorkspaceAccessRequests.clientInstanceId, input.clientInstanceId),
          eq(
            collaborationWorkspaceAccessRequests.collaborationWorkspaceId,
            input.collaborationWorkspaceId
          )
        )
      );
    await tx
      .delete(collaborationWorkspaceMemberships)
      .where(
        and(
          eq(collaborationWorkspaceMemberships.clientInstanceId, input.clientInstanceId),
          eq(
            collaborationWorkspaceMemberships.collaborationWorkspaceId,
            input.collaborationWorkspaceId
          )
        )
      );
    const [row] = await tx
      .delete(collaborationWorkspaces)
      .where(
        and(
          eq(collaborationWorkspaces.clientInstanceId, input.clientInstanceId),
          eq(collaborationWorkspaces.id, input.collaborationWorkspaceId)
        )
      )
      .returning();
    return mapCollaborationWorkspace(row);
  });
}

export async function ensurePersonalWorkspace(
  db: PostgresDatabase,
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

export async function addMembership(
  db: PostgresDatabase,
  input: Parameters<CollaborationWorkspaceStore["addMembership"]>[0]
): Promise<WorkspaceMembership> {
  const workspace = await requireWorkspace(
    db,
    input.clientInstanceId,
    input.collaborationWorkspaceId
  );
  if (workspace.kind === "personal") {
    throw new AppError("VALIDATION_FAILED", "A Personal Workspace cannot gain members");
  }
  if (await getMembership(db, input)) {
    throw new AppError("CONFLICT", "Workspace Membership already exists");
  }
  const now = new Date();
  const [row] = await db
    .insert(collaborationWorkspaceMemberships)
    .values({ ...input, createdAt: now, updatedAt: now })
    .returning();
  return mapWorkspaceMembership(row);
}

export async function updateMembershipRole(
  db: PostgresDatabase,
  input: Parameters<CollaborationWorkspaceStore["updateMembershipRole"]>[0]
): Promise<WorkspaceMembership> {
  const workspace = await requireWorkspace(
    db,
    input.clientInstanceId,
    input.collaborationWorkspaceId
  );
  if (workspace.kind === "personal") {
    throw new AppError("VALIDATION_FAILED", "A Personal Workspace membership cannot change");
  }
  const [row] = await db
    .update(collaborationWorkspaceMemberships)
    .set({ role: input.role, updatedAt: new Date() })
    .where(membershipWhere(input))
    .returning();
  if (!row) throw new AppError("NOT_FOUND", "Workspace Membership is not available");
  return mapWorkspaceMembership(row);
}

export async function removeMembership(
  db: PostgresDatabase,
  input: Parameters<CollaborationWorkspaceStore["removeMembership"]>[0]
): Promise<WorkspaceMembership> {
  const workspace = await requireWorkspace(
    db,
    input.clientInstanceId,
    input.collaborationWorkspaceId
  );
  if (workspace.kind === "personal") {
    throw new AppError("VALIDATION_FAILED", "A Personal Workspace membership cannot be removed");
  }
  const [row] = await db
    .delete(collaborationWorkspaceMemberships)
    .where(membershipWhere(input))
    .returning();
  if (!row) throw new AppError("NOT_FOUND", "Workspace Membership is not available");
  return mapWorkspaceMembership(row);
}

export async function listMemberships(
  db: PostgresDatabase,
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
    .orderBy(asc(collaborationWorkspaceMemberships.createdAt));
  return rows.map(mapWorkspaceMembership);
}

export async function searchMemberCandidates(
  db: PostgresDatabase,
  input: Parameters<CollaborationWorkspaceStore["searchMemberCandidates"]>[0]
): Promise<WorkspaceMemberCandidate[]> {
  await requireWorkspace(db, input.clientInstanceId, input.collaborationWorkspaceId);
  const pattern = `%${escapeLikePattern(input.query)}%`;
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
  return rows.map((row) => ({
    displayLabel: row.displayLabel,
    email: row.email!,
    hasPendingAccessRequest: row.hasPendingAccessRequest
  }));
}

export async function getMembership(
  db: WorkspaceDatabase,
  input: Parameters<CollaborationWorkspaceStore["getMembership"]>[0]
): Promise<WorkspaceMembership | undefined> {
  const [row] = await db
    .select()
    .from(collaborationWorkspaceMemberships)
    .where(membershipWhere(input))
    .limit(1);
  return row ? mapWorkspaceMembership(row) : undefined;
}

export async function createAccessRequest(
  db: PostgresDatabase,
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

export async function deleteAccessRequest(
  db: PostgresDatabase,
  input: Parameters<CollaborationWorkspaceStore["deleteAccessRequest"]>[0]
): Promise<WorkspaceAccessRequest> {
  const [row] = await db
    .delete(collaborationWorkspaceAccessRequests)
    .where(accessRequestWhere(input))
    .returning();
  if (!row) throw new AppError("NOT_FOUND", "Workspace Access Request is not available");
  return mapWorkspaceAccessRequest(row);
}

export async function listAccessRequestsForWorkspace(
  db: PostgresDatabase,
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
    .orderBy(asc(collaborationWorkspaceAccessRequests.createdAt));
  return rows.map(mapWorkspaceAccessRequest);
}

export async function getAccessRequest(
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

export async function deleteAccessRequestsForUser(
  db: PostgresDatabase,
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

export async function removeMembershipsForUser(
  db: PostgresDatabase,
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

export async function deletePersonalWorkspaceForUser(
  db: PostgresDatabase,
  input: Parameters<CollaborationWorkspaceStore["deletePersonalWorkspaceForUser"]>[0]
): Promise<CollaborationWorkspace> {
  return db.transaction(async (tx) => {
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
    await tx
      .delete(conversations)
      .where(
        and(
          eq(conversations.clientInstanceId, input.clientInstanceId),
          eq(conversations.collaborationWorkspaceId, workspace.id)
        )
      );
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
  await db.insert(collaborationWorkspaceMemberships).values({
    collaborationWorkspaceId: row!.id,
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

async function requireWorkspace(
  db: WorkspaceDatabase,
  clientInstanceId: ClientInstanceId,
  collaborationWorkspaceId: CollaborationWorkspaceId
): Promise<CollaborationWorkspace> {
  const workspace = await getWorkspace(db, clientInstanceId, collaborationWorkspaceId);
  if (!workspace) throw new AppError("NOT_FOUND", "Collaboration Workspace is not available");
  return workspace;
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

function escapeLikePattern(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
