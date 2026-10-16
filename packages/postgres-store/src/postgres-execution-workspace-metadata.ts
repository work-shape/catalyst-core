import {
  AppError,
  createPlatformId,
  type ClientInstanceId,
  type ConversationId,
  type EnsureExecutionWorkspaceInput,
  type ExecutionWorkspace,
  type ExecutionWorkspaceId
} from "@work-shape/catalyst-core";
import { and, eq, ne } from "drizzle-orm";
import { type PostgresConnection } from "./postgres-database";
import { mapExecutionWorkspace } from "./rows";
import { conversations, executionWorkspaces } from "./schema";

export async function ensureExecutionWorkspace(
  db: PostgresConnection,
  input: EnsureExecutionWorkspaceInput
): Promise<ExecutionWorkspace> {
  const now = input.now ? new Date(input.now) : new Date();
  await requireActiveConversation(db, {
    clientInstanceId: input.clientInstanceId,
    conversationId: input.conversationId
  });

  const [inserted] = await db
    .insert(executionWorkspaces)
    .values({
      id: createPlatformId<"ExecutionWorkspaceId">("ews"),
      clientInstanceId: input.clientInstanceId,
      conversationId: input.conversationId,
      ownerUserId: input.ownerUserId,
      status: "active",
      createdAt: now,
      updatedAt: now
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) {
    return mapExecutionWorkspace(inserted);
  }

  const [existing] = await db
    .select()
    .from(executionWorkspaces)
    .where(
      and(
        eq(executionWorkspaces.clientInstanceId, input.clientInstanceId),
        eq(executionWorkspaces.conversationId, input.conversationId),
        ne(executionWorkspaces.status, "deleted")
      )
    )
    .limit(1);
  if (!existing) {
    throw new AppError("NOT_FOUND", "Execution workspace is not available");
  }
  return mapExecutionWorkspace(existing);
}

export async function getExecutionWorkspace(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    workspaceId: ExecutionWorkspaceId;
  }
): Promise<ExecutionWorkspace | undefined> {
  const [row] = await db
    .select()
    .from(executionWorkspaces)
    .where(
      and(
        eq(executionWorkspaces.clientInstanceId, input.clientInstanceId),
        eq(executionWorkspaces.id, input.workspaceId),
        ne(executionWorkspaces.status, "deleted")
      )
    )
    .limit(1);
  return row ? mapExecutionWorkspace(row) : undefined;
}

export async function getExecutionWorkspaceForConversation(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }
): Promise<ExecutionWorkspace | undefined> {
  const [row] = await db
    .select()
    .from(executionWorkspaces)
    .where(
      and(
        eq(executionWorkspaces.clientInstanceId, input.clientInstanceId),
        eq(executionWorkspaces.conversationId, input.conversationId),
        ne(executionWorkspaces.status, "deleted")
      )
    )
    .limit(1);
  return row ? mapExecutionWorkspace(row) : undefined;
}

export async function findExecutionWorkspaceOfActiveConversation(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }
): Promise<ExecutionWorkspace | undefined> {
  await requireActiveConversation(db, input);
  return getExecutionWorkspaceForConversation(db, input);
}

async function requireActiveConversation(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }
): Promise<void> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.clientInstanceId, input.clientInstanceId),
        eq(conversations.id, input.conversationId),
        eq(conversations.status, "active")
      )
    )
    .limit(1);
  if (!row) {
    throw new AppError("NOT_FOUND", "Conversation is not available");
  }
}

export async function requireActiveWorkspace(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    workspaceId: ExecutionWorkspaceId;
  }
): Promise<ExecutionWorkspace> {
  const where = [
    eq(executionWorkspaces.clientInstanceId, input.clientInstanceId),
    eq(executionWorkspaces.id, input.workspaceId),
    eq(executionWorkspaces.status, "active")
  ];
  const [row] = await db
    .select()
    .from(executionWorkspaces)
    .where(and(...where))
    .limit(1);
  if (!row) {
    throw new AppError("NOT_FOUND", "Execution workspace is not available");
  }
  return mapExecutionWorkspace(row);
}
