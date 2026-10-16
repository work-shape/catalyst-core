import {
  AppError,
  asConversationAttachmentId,
  asConversationId,
  createPlatformId,
  type ClientInstanceId,
  type ConversationAttachment,
  type ConversationAttachmentId,
  type ConversationAttachmentStatus,
  type ConversationId,
  type CreateConversationAttachmentInput,
  type DraftAttachment,
  type ManagedFileId,
  type MessageId,
  type SubjectRowClaim,
  type UpdateConversationAttachmentInput
} from "@work-shape/catalyst-core";
import { and, asc, desc, sql as drizzleSql, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { lockActiveConversation, touchConversation } from "./postgres-conversation-operations";
import {
  type PostgresConnection,
  type PostgresPlatformFileStoreCallbacks
} from "./postgres-file-store-types";
import { mapConversationAttachment } from "./rows";
import { conversationAttachments, managedFiles } from "./schema";

function leaseExpiry(leaseMs: number) {
  return drizzleSql`now() + make_interval(secs => ${leaseMs}::double precision / 1000)`;
}

export async function createConversationAttachment(
  db: PostgresConnection,
  input: CreateConversationAttachmentInput
): Promise<ConversationAttachment> {
  const row = await db.transaction(async (tx) => {
    // The lock keeps expiry from deciding that the Conversation is an abandoned draft while
    // this upload is on its way in.
    if (!(await lockActiveConversation(tx, input.clientInstanceId, input.conversationId))) {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }
    const now = new Date();
    const [attachment] = await tx
      .insert(conversationAttachments)
      .values({
        id: createPlatformId<"ConversationAttachmentId">("att"),
        clientInstanceId: input.clientInstanceId,
        conversationId: input.conversationId,
        fileId: input.fileId,
        filename: input.filename,
        mimeType: input.mimeType ?? null,
        byteSize: input.byteSize,
        checksum: input.checksum,
        status: input.status,
        format: input.format ?? null,
        artifactRefs: input.artifactRefs ?? {},
        processingMetadata: input.processingMetadata ?? {},
        warnings: input.warnings ?? [],
        error: input.error ?? null,
        createdAt: now,
        updatedAt: now
      })
      .returning();
    await touchConversation(tx, input.clientInstanceId, input.conversationId, now);
    return attachment;
  });
  return mapConversationAttachment(row);
}

export async function getConversationAttachment(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    attachmentId: ConversationAttachmentId;
  }
): Promise<ConversationAttachment | undefined> {
  const [row] = await db
    .select()
    .from(conversationAttachments)
    .where(
      and(
        eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
        eq(conversationAttachments.id, input.attachmentId),
        ne(conversationAttachments.status, "deleted")
      )
    )
    .limit(1);
  return row ? mapConversationAttachment(row) : undefined;
}

export async function listDraftAttachments(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }
): Promise<DraftAttachment[]> {
  const rows = await db
    .select()
    .from(conversationAttachments)
    .where(
      and(
        eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
        eq(conversationAttachments.conversationId, input.conversationId),
        isNull(conversationAttachments.messageId),
        isNull(conversationAttachments.followUpId),
        ne(conversationAttachments.status, "deleted")
      )
    )
    .orderBy(asc(conversationAttachments.createdAt));
  return rows.map(mapConversationAttachment) as DraftAttachment[];
}

export async function listSentConversationAttachments(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }
): Promise<ConversationAttachment[]> {
  const rows = await db
    .select()
    .from(conversationAttachments)
    .where(
      and(
        eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
        eq(conversationAttachments.conversationId, input.conversationId),
        isNotNull(conversationAttachments.messageId),
        ne(conversationAttachments.status, "deleted")
      )
    )
    .orderBy(desc(conversationAttachments.createdAt));
  return rows.map(mapConversationAttachment);
}

export async function findConversationAttachmentByChecksum(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    checksum: string;
  }
): Promise<ConversationAttachment | undefined> {
  const [row] = await db
    .select()
    .from(conversationAttachments)
    .where(
      and(
        eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
        eq(conversationAttachments.conversationId, input.conversationId),
        eq(conversationAttachments.checksum, input.checksum)
      )
    )
    .orderBy(desc(conversationAttachments.createdAt))
    .limit(1);
  return row ? mapConversationAttachment(row) : undefined;
}

export async function updateConversationAttachment(
  db: PostgresConnection,
  input: UpdateConversationAttachmentInput
): Promise<ConversationAttachment> {
  const set: Partial<typeof conversationAttachments.$inferInsert> = {
    updatedAt: new Date()
  };
  if (input.status !== undefined) {
    set.status = input.status;
  }
  if (input.format !== undefined) {
    set.format = input.format;
  }
  if (input.artifactRefs !== undefined) {
    set.artifactRefs = input.artifactRefs;
  }
  if (input.processingMetadata !== undefined) {
    set.processingMetadata = input.processingMetadata;
  }
  if (input.warnings !== undefined) {
    set.warnings = input.warnings;
  }
  if (input.error !== undefined) {
    set.error = input.error;
  }
  if (input.processingOwnerId !== undefined) {
    set.processingOwnerId = input.processingOwnerId;
  }
  if (input.processingLeaseToken !== undefined) {
    set.processingLeaseToken = input.processingLeaseToken;
  }
  if (input.processingLeaseExpiresAt !== undefined) {
    set.processingLeaseExpiresAt = input.processingLeaseExpiresAt
      ? new Date(input.processingLeaseExpiresAt)
      : null;
  }
  if (input.processingAttempts !== undefined) {
    set.processingAttempts = input.processingAttempts;
  }
  if (input.preprocessingStartedAt !== undefined) {
    set.preprocessingStartedAt = input.preprocessingStartedAt
      ? new Date(input.preprocessingStartedAt)
      : null;
  }
  if (input.preprocessingCompletedAt !== undefined) {
    set.preprocessingCompletedAt = input.preprocessingCompletedAt
      ? new Date(input.preprocessingCompletedAt)
      : null;
  }
  if (input.deletedAt !== undefined) {
    set.deletedAt = new Date(input.deletedAt);
  }

  const [row] = await db
    .update(conversationAttachments)
    .set(set)
    .where(
      and(
        eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
        eq(conversationAttachments.id, input.attachmentId)
      )
    )
    .returning();
  if (!row) {
    throw new AppError("NOT_FOUND", "Attachment is not available");
  }
  return mapConversationAttachment(row);
}

export async function reactivateDraftAttachment(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    attachmentId: ConversationAttachmentId;
    status: "queued" | "ready" | "unsupported";
  }
): Promise<ConversationAttachment> {
  const row = await db.transaction(async (tx) => {
    if (!(await lockActiveConversation(tx, input.clientInstanceId, input.conversationId))) {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }
    const [attachment] = await tx
      .update(conversationAttachments)
      .set({
        status: input.status,
        deletedAt: null,
        updatedAt: new Date()
      })
      .where(
        and(
          eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
          eq(conversationAttachments.conversationId, input.conversationId),
          eq(conversationAttachments.id, input.attachmentId),
          isNull(conversationAttachments.messageId),
          isNull(conversationAttachments.followUpId),
          eq(conversationAttachments.status, "deleted")
        )
      )
      .returning();
    if (!attachment) {
      throw new AppError("NOT_FOUND", "Draft attachment is not available");
    }
    await tx
      .update(managedFiles)
      .set({
        status: "available",
        deletedAt: null
      })
      .where(
        and(
          eq(managedFiles.clientInstanceId, input.clientInstanceId),
          eq(managedFiles.id, attachment.fileId)
        )
      );
    await touchConversation(tx, input.clientInstanceId, input.conversationId, attachment.updatedAt);
    return attachment;
  });
  return mapConversationAttachment(row);
}

export async function deleteDraftAttachment(
  db: PostgresConnection,
  callbacks: PostgresPlatformFileStoreCallbacks,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    attachmentId: ConversationAttachmentId;
    deletedAt: string;
  }
): Promise<ConversationAttachment> {
  const deletedAt = new Date(input.deletedAt);
  const [row] = await db
    .update(conversationAttachments)
    .set({
      status: "deleted",
      deletedAt,
      updatedAt: deletedAt
    })
    .where(
      and(
        eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
        eq(conversationAttachments.conversationId, input.conversationId),
        eq(conversationAttachments.id, input.attachmentId),
        isNull(conversationAttachments.messageId),
        isNull(conversationAttachments.followUpId)
      )
    )
    .returning();
  if (!row) {
    throw new AppError("NOT_FOUND", "Draft attachment is not available");
  }
  await callbacks.touchConversation(input.clientInstanceId, input.conversationId, deletedAt);
  return mapConversationAttachment(row);
}

export async function claimReadyDraftAttachmentsForMessage(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    messageId: MessageId;
    claimedAt: string;
  }
): Promise<ConversationAttachment[]> {
  const claimedAt = new Date(input.claimedAt);
  const rows = await db
    .update(conversationAttachments)
    .set({
      messageId: input.messageId,
      updatedAt: claimedAt
    })
    .where(
      and(
        eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
        eq(conversationAttachments.conversationId, input.conversationId),
        eq(conversationAttachments.status, "ready"),
        isNull(conversationAttachments.messageId),
        isNull(conversationAttachments.followUpId)
      )
    )
    .returning();
  return rows.map(mapConversationAttachment);
}

/**
 * Takes an attachment by id for the executor job that preprocesses it and writes the job's
 * lease onto the row's lease columns, which a worker of the previous release reads. The row
 * is taken when it is queued, when its lease ran out, or when `leaseOwnerId` already holds
 * it: that is an earlier attempt of the same job, whose lease the executor has ended.
 */
export async function claimConversationAttachmentForPreprocessing(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    attachmentId: ConversationAttachmentId;
    leaseOwnerId: string;
    leaseToken: string;
    leaseMs: number;
  }
): Promise<SubjectRowClaim<ConversationAttachment>> {
  const ofRow = and(
    eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
    eq(conversationAttachments.id, input.attachmentId)
  );
  const [claimed] = await db
    .update(conversationAttachments)
    .set({
      status: "preprocessing",
      processingOwnerId: input.leaseOwnerId,
      processingLeaseToken: input.leaseToken,
      processingLeaseExpiresAt: leaseExpiry(input.leaseMs),
      processingAttempts: drizzleSql`${conversationAttachments.processingAttempts} + 1`,
      preprocessingStartedAt: drizzleSql`coalesce(${conversationAttachments.preprocessingStartedAt}, now())`,
      updatedAt: drizzleSql`now()`,
      error: null
    })
    .where(
      and(
        ofRow,
        drizzleSql`(
            ${conversationAttachments.status} = 'queued'
            or (
              ${conversationAttachments.status} = 'preprocessing'
              and (
                ${conversationAttachments.processingLeaseExpiresAt} is null
                or ${conversationAttachments.processingLeaseExpiresAt} <= now()
                or ${conversationAttachments.processingOwnerId} = ${input.leaseOwnerId}
              )
            )
          )`
      )
    )
    .returning();
  if (claimed) return { status: "claimed", row: mapConversationAttachment(claimed) };
  const [current] = await db
    .select({ status: conversationAttachments.status })
    .from(conversationAttachments)
    .where(ofRow)
    .limit(1);
  return current?.status === "queued" || current?.status === "preprocessing"
    ? { status: "held" }
    : { status: "finished" };
}

export async function renewClaimedConversationAttachmentLease(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    attachmentId: ConversationAttachmentId;
    leaseToken: string;
    leaseMs: number;
  }
): Promise<boolean> {
  const rows = await db
    .update(conversationAttachments)
    .set({ processingLeaseExpiresAt: leaseExpiry(input.leaseMs) })
    .where(
      and(
        eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
        eq(conversationAttachments.id, input.attachmentId),
        eq(conversationAttachments.status, "preprocessing"),
        eq(conversationAttachments.processingLeaseToken, input.leaseToken)
      )
    )
    .returning({ id: conversationAttachments.id });
  return rows.length > 0;
}

export async function listConversationAttachmentsWithoutJob(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    jobKind: string;
    formats?: readonly string[];
    limit: number;
  }
): Promise<Array<{ id: ConversationAttachmentId; conversationId: ConversationId }>> {
  const rows = await db
    .select({
      id: conversationAttachments.id,
      conversationId: conversationAttachments.conversationId
    })
    .from(conversationAttachments)
    .where(
      and(
        eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
        inArray(conversationAttachments.status, PENDING_ATTACHMENT_STATUSES),
        input.formats && input.formats.length > 0
          ? inArray(conversationAttachments.format, [...input.formats])
          : undefined,
        drizzleSql`not exists (
            select 1 from platform_jobs job
            where job.client_instance_id = ${conversationAttachments.clientInstanceId}
              and job.kind = ${input.jobKind}
              and job.dedupe_key = ${input.jobKind} || ':' || ${conversationAttachments.id}
              and job.status in ('queued', 'running')
          )`
      )
    )
    .orderBy(asc(conversationAttachments.createdAt), asc(conversationAttachments.id))
    .limit(input.limit);
  return rows.map((row) => ({
    id: asConversationAttachmentId(row.id),
    conversationId: asConversationId(row.conversationId)
  }));
}

export async function completeClaimedConversationAttachment(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    attachmentId: ConversationAttachmentId;
    leaseToken: string;
    artifactRefs: ConversationAttachment["artifactRefs"];
    processingMetadata?: ConversationAttachment["processingMetadata"];
    warnings: ConversationAttachment["warnings"];
    completedAt: string;
  }
): Promise<ConversationAttachment> {
  const completedAt = new Date(input.completedAt);
  const processingMetadata = input.processingMetadata ?? {};
  const [row] = await db
    .update(conversationAttachments)
    .set({
      status: "ready",
      artifactRefs: input.artifactRefs,
      processingMetadata,
      warnings: input.warnings,
      error: null,
      processingOwnerId: null,
      processingLeaseToken: null,
      processingLeaseExpiresAt: null,
      preprocessingCompletedAt: completedAt,
      updatedAt: completedAt
    })
    .where(
      and(
        eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
        eq(conversationAttachments.id, input.attachmentId),
        eq(conversationAttachments.status, "preprocessing"),
        eq(conversationAttachments.processingLeaseToken, input.leaseToken)
      )
    )
    .returning();
  if (!row) {
    throw new AppError("CONFLICT", "Attachment processing lease is no longer active");
  }
  return mapConversationAttachment(row);
}

export async function failClaimedConversationAttachment(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    attachmentId: ConversationAttachmentId;
    leaseToken: string;
    error: NonNullable<ConversationAttachment["error"]>;
    completedAt: string;
  }
): Promise<ConversationAttachment> {
  const completedAt = new Date(input.completedAt);
  const [row] = await db
    .update(conversationAttachments)
    .set({
      status: "failed",
      error: input.error,
      processingOwnerId: null,
      processingLeaseToken: null,
      processingLeaseExpiresAt: null,
      preprocessingCompletedAt: completedAt,
      updatedAt: completedAt
    })
    .where(
      and(
        eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
        eq(conversationAttachments.id, input.attachmentId),
        eq(conversationAttachments.status, "preprocessing"),
        eq(conversationAttachments.processingLeaseToken, input.leaseToken)
      )
    )
    .returning();
  if (!row) {
    throw new AppError("CONFLICT", "Attachment processing lease is no longer active");
  }
  return mapConversationAttachment(row);
}

export async function findReadyConversationAttachmentByFile(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    fileId: ManagedFileId;
  }
): Promise<ConversationAttachment | undefined> {
  const [row] = await db
    .select()
    .from(conversationAttachments)
    .where(
      and(
        eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
        eq(conversationAttachments.conversationId, input.conversationId),
        eq(conversationAttachments.fileId, input.fileId),
        eq(conversationAttachments.status, "ready")
      )
    )
    .orderBy(desc(conversationAttachments.updatedAt))
    .limit(1);
  return row ? mapConversationAttachment(row) : undefined;
}

export async function findConversationAttachmentByFile(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    fileId: ManagedFileId;
  }
): Promise<ConversationAttachment | undefined> {
  const [row] = await db
    .select()
    .from(conversationAttachments)
    .where(
      and(
        eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
        eq(conversationAttachments.conversationId, input.conversationId),
        eq(conversationAttachments.fileId, input.fileId),
        ne(conversationAttachments.status, "deleted")
      )
    )
    .orderBy(desc(conversationAttachments.updatedAt))
    .limit(1);
  return row ? mapConversationAttachment(row) : undefined;
}

const PENDING_ATTACHMENT_STATUSES = [
  "queued",
  "preprocessing"
] as const satisfies readonly ConversationAttachmentStatus[];
