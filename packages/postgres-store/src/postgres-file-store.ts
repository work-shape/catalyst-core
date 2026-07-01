import { and, asc, desc, eq, inArray, isNull, ne, sql as drizzleSql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  AppError,
  type ArtifactPreviewJobRecord,
  type ArtifactPreviewManifest,
  type ClaimNextArtifactPreviewJobInput,
  type ClientInstanceId,
  type CompleteClaimedArtifactPreviewJobInput,
  type ConversationAttachment,
  type ConversationAttachmentId,
  type ConversationId,
  type CreateConversationAttachmentInput,
  type EnqueueArtifactPreviewJobInput,
  type CreateManagedArtifactInput,
  type CreateManagedFileInput,
  type FailClaimedArtifactPreviewJobInput,
  type MarkClaimedArtifactPreviewJobUnsupportedInput,
  type PlatformFileStore,
  type DraftAttachment,
  type ManagedArtifactId,
  type ManagedArtifactKind,
  type ManagedArtifactRecord,
  type ManagedFileId,
  type ManagedFileRecord,
  type ManagedObjectDeletionResult,
  type MessageId,
  type RecoverStaleArtifactPreviewJobsInput,
  type UpdateConversationAttachmentInput,
  type WriteArtifactPreviewManifestInput,
  createPlatformId
} from "@vivd-catalyst/core";
import {
  mapConversationAttachment,
  mapManagedArtifact,
  mapManagedFile
} from "./rows";
import {
  claimNextArtifactPreviewJob as claimNextPostgresArtifactPreviewJob,
  completeClaimedArtifactPreviewJob as completeClaimedPostgresArtifactPreviewJob,
  enqueueArtifactPreviewJob as enqueuePostgresArtifactPreviewJob,
  failClaimedArtifactPreviewJob as failClaimedPostgresArtifactPreviewJob,
  getArtifactPreviewJob as getPostgresArtifactPreviewJob,
  getArtifactPreviewManifest as getPostgresArtifactPreviewManifest,
  markClaimedArtifactPreviewJobUnsupported as markClaimedPostgresArtifactPreviewJobUnsupported,
  recoverStaleArtifactPreviewJobs as recoverStalePostgresArtifactPreviewJobs,
  writeArtifactPreviewManifest as writePostgresArtifactPreviewManifest
} from "./postgres-artifact-preview-operations";
import {
  artifactPreviewJobs,
  artifactPreviewManifests,
  conversations,
  conversationAttachments,
  managedArtifacts,
  managedFiles,
  schema
} from "./schema";

type PostgresDatabase = PostgresJsDatabase<typeof schema>;

export interface PostgresPlatformFileStoreCallbacks {
  requireActiveConversation(clientInstanceId: ClientInstanceId, conversationId: ConversationId): Promise<void>;
  touchConversation(
    clientInstanceId: ClientInstanceId,
    conversationId: ConversationId,
    updatedAt: Date
  ): Promise<void>;
}

export function createPostgresPlatformFileStore(
  db: PostgresDatabase,
  callbacks: PostgresPlatformFileStoreCallbacks
): PlatformFileStore {
  return new PostgresPlatformFileStore(db, callbacks);
}

class PostgresPlatformFileStore implements PlatformFileStore {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly callbacks: PostgresPlatformFileStoreCallbacks
  ) {}

  async createManagedFile(input: CreateManagedFileInput): Promise<ManagedFileRecord> {
    const [row] = await this.db
      .insert(managedFiles)
      .values({
        id: createPlatformId<"ManagedFileId">("file"),
        clientInstanceId: input.clientInstanceId,
        ownerUserId: input.ownerUserId,
        filename: input.filename,
        mimeType: input.mimeType ?? null,
        byteSize: input.byteSize,
        checksum: input.checksum,
        objectKey: input.objectKey,
        status: "available",
        createdAt: new Date()
      })
      .returning();
    return mapManagedFile(row);
  }

  async getManagedFile(input: {
    clientInstanceId: ClientInstanceId;
    fileId: ManagedFileId;
  }): Promise<ManagedFileRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(managedFiles)
      .where(
        and(
          eq(managedFiles.clientInstanceId, input.clientInstanceId),
          eq(managedFiles.id, input.fileId),
          ne(managedFiles.status, "deleted")
        )
      )
      .limit(1);
    return row ? mapManagedFile(row) : undefined;
  }

  async createManagedArtifact(input: CreateManagedArtifactInput): Promise<ManagedArtifactRecord> {
    const [row] = await this.db
      .insert(managedArtifacts)
      .values({
        id: createPlatformId<"ManagedArtifactId">("art"),
        clientInstanceId: input.clientInstanceId,
        conversationId: input.conversationId,
        sourceFileId: input.sourceFileId ?? null,
        kind: input.kind,
        objectKey: input.objectKey,
        filename: input.filename ?? null,
        mimeType: input.mimeType,
        byteSize: input.byteSize,
        checksum: input.checksum,
        metadata: input.metadata ?? {},
        status: "available",
        createdAt: new Date()
      })
      .returning();
    return mapManagedArtifact(row);
  }

  async getManagedArtifact(input: {
    clientInstanceId: ClientInstanceId;
    artifactId: ManagedArtifactId;
  }): Promise<ManagedArtifactRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(managedArtifacts)
      .where(
        and(
          eq(managedArtifacts.clientInstanceId, input.clientInstanceId),
          eq(managedArtifacts.id, input.artifactId),
          ne(managedArtifacts.status, "deleted")
        )
      )
      .limit(1);
    return row ? mapManagedArtifact(row) : undefined;
  }

  async listManagedArtifactsForFile(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    fileId: ManagedFileId;
    kind?: ManagedArtifactKind;
  }): Promise<ManagedArtifactRecord[]> {
    const where = [
      eq(managedArtifacts.clientInstanceId, input.clientInstanceId),
      eq(managedArtifacts.conversationId, input.conversationId),
      eq(managedArtifacts.sourceFileId, input.fileId),
      ne(managedArtifacts.status, "deleted")
    ];
    if (input.kind !== undefined) {
      where.push(eq(managedArtifacts.kind, input.kind));
    }
    const rows = await this.db
      .select()
      .from(managedArtifacts)
      .where(and(...where))
      .orderBy(desc(managedArtifacts.createdAt));
    return rows.map(mapManagedArtifact);
  }

  async enqueueArtifactPreviewJob(
    input: EnqueueArtifactPreviewJobInput
  ): Promise<ArtifactPreviewJobRecord> {
    return enqueuePostgresArtifactPreviewJob(this.db, input);
  }

  async getArtifactPreviewJob(input: {
    clientInstanceId: ClientInstanceId;
    sourceArtifactId: ManagedArtifactId;
  }): Promise<ArtifactPreviewJobRecord | undefined> {
    return getPostgresArtifactPreviewJob(this.db, input);
  }

  async claimNextArtifactPreviewJob(
    input: ClaimNextArtifactPreviewJobInput
  ): Promise<ArtifactPreviewJobRecord | undefined> {
    return claimNextPostgresArtifactPreviewJob(this.db, input);
  }

  async completeClaimedArtifactPreviewJob(
    input: CompleteClaimedArtifactPreviewJobInput
  ): Promise<ArtifactPreviewJobRecord> {
    return completeClaimedPostgresArtifactPreviewJob(this.db, input);
  }

  async failClaimedArtifactPreviewJob(
    input: FailClaimedArtifactPreviewJobInput
  ): Promise<ArtifactPreviewJobRecord> {
    return failClaimedPostgresArtifactPreviewJob(this.db, input);
  }

  async markClaimedArtifactPreviewJobUnsupported(
    input: MarkClaimedArtifactPreviewJobUnsupportedInput
  ): Promise<ArtifactPreviewJobRecord> {
    return markClaimedPostgresArtifactPreviewJobUnsupported(this.db, input);
  }

  async recoverStaleArtifactPreviewJobs(
    input: RecoverStaleArtifactPreviewJobsInput
  ): Promise<ArtifactPreviewJobRecord[]> {
    return recoverStalePostgresArtifactPreviewJobs(this.db, input);
  }

  async getArtifactPreviewManifest(input: {
    clientInstanceId: ClientInstanceId;
    sourceArtifactId: ManagedArtifactId;
  }): Promise<ArtifactPreviewManifest | undefined> {
    return getPostgresArtifactPreviewManifest(this.db, input);
  }

  async writeArtifactPreviewManifest(
    input: WriteArtifactPreviewManifestInput
  ): Promise<ArtifactPreviewManifest> {
    return writePostgresArtifactPreviewManifest(this.db, input);
  }

  async createConversationAttachment(
    input: CreateConversationAttachmentInput
  ): Promise<ConversationAttachment> {
    await this.callbacks.requireActiveConversation(input.clientInstanceId, input.conversationId);

    const now = new Date();
    const [row] = await this.db
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
    await this.callbacks.touchConversation(input.clientInstanceId, input.conversationId, now);
    return mapConversationAttachment(row);
  }

  async getConversationAttachment(input: {
    clientInstanceId: ClientInstanceId;
    attachmentId: ConversationAttachmentId;
  }): Promise<ConversationAttachment | undefined> {
    const [row] = await this.db
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

  async listDraftAttachments(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<DraftAttachment[]> {
    const rows = await this.db
      .select()
      .from(conversationAttachments)
      .where(
        and(
          eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
          eq(conversationAttachments.conversationId, input.conversationId),
          isNull(conversationAttachments.messageId),
          ne(conversationAttachments.status, "deleted")
        )
      )
      .orderBy(asc(conversationAttachments.createdAt));
    return rows.map(mapConversationAttachment) as DraftAttachment[];
  }

  async updateConversationAttachment(
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

    const [row] = await this.db
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

  async deleteDraftAttachment(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    attachmentId: ConversationAttachmentId;
    deletedAt: string;
  }): Promise<ConversationAttachment> {
    const deletedAt = new Date(input.deletedAt);
    const [row] = await this.db
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
          isNull(conversationAttachments.messageId)
        )
      )
      .returning();
    if (!row) {
      throw new AppError("NOT_FOUND", "Draft attachment is not available");
    }
    await this.callbacks.touchConversation(input.clientInstanceId, input.conversationId, deletedAt);
    return mapConversationAttachment(row);
  }

  async claimReadyDraftAttachmentsForMessage(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    messageId: MessageId;
    claimedAt: string;
  }): Promise<ConversationAttachment[]> {
    const claimedAt = new Date(input.claimedAt);
    const rows = await this.db
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
          isNull(conversationAttachments.messageId)
        )
      )
      .returning();
    return rows.map(mapConversationAttachment);
  }

  async claimNextQueuedConversationAttachment(input: {
    clientInstanceId: ClientInstanceId;
    workerId: string;
    leaseToken: string;
    now: string;
    leaseExpiresAt: string;
    perConversationLimit: number;
    globalLimit: number;
    formats?: readonly string[];
  }): Promise<ConversationAttachment | undefined> {
    const now = new Date(input.now).toISOString();
    const leaseExpiresAt = new Date(input.leaseExpiresAt).toISOString();
    const formatFilter =
      input.formats && input.formats.length > 0
        ? drizzleSql`and ca.format in (${drizzleSql.join(
            input.formats.map((format) => drizzleSql`${format}`),
            drizzleSql`, `
          )})`
        : drizzleSql``;
    const rows = await this.db.transaction(async (tx) => {
      const claimed = (await tx.execute(drizzleSql<{ id: string }>`
        with candidate as (
          select ca.id
          from conversation_attachments ca
          where ca.client_instance_id = ${input.clientInstanceId}
            and ca.status <> 'deleted'
            ${formatFilter}
            and (
              ca.status = 'queued'
              or (
                ca.status = 'preprocessing'
                and (
                  ca.processing_lease_expires_at is null
                  or ca.processing_lease_expires_at <= ${now}::timestamptz
                )
              )
            )
            and (
              select count(*)
              from conversation_attachments active
              where active.client_instance_id = ca.client_instance_id
                and active.status = 'preprocessing'
                and active.processing_lease_token is not null
                and active.processing_lease_expires_at > ${now}::timestamptz
            ) < ${input.globalLimit}
            and (
              select count(*)
              from conversation_attachments active
              where active.client_instance_id = ca.client_instance_id
                and active.conversation_id = ca.conversation_id
                and active.status = 'preprocessing'
                and active.processing_lease_token is not null
                and active.processing_lease_expires_at > ${now}::timestamptz
            ) < ${input.perConversationLimit}
          order by ca.created_at asc
          limit 1
          for update skip locked
        )
        update conversation_attachments ca
        set status = 'preprocessing',
            processing_owner_id = ${input.workerId},
            processing_lease_token = ${input.leaseToken},
            processing_lease_expires_at = ${leaseExpiresAt}::timestamptz,
            processing_attempts = ca.processing_attempts + 1,
            preprocessing_started_at = coalesce(ca.preprocessing_started_at, ${now}::timestamptz),
            updated_at = ${now}::timestamptz,
            error = null
        from candidate
        where ca.id = candidate.id
        returning ca.id
      `)) as unknown as Array<{ id: string }>;
      const claimedId = claimed[0]?.id;
      if (!claimedId) {
        return [];
      }
      return tx
        .select()
        .from(conversationAttachments)
        .where(
          and(
            eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
            eq(conversationAttachments.id, claimedId)
          )
        )
        .limit(1);
    });
    const row = rows[0];
    return row ? mapConversationAttachment(row) : undefined;
  }

  async completeClaimedConversationAttachment(input: {
    clientInstanceId: ClientInstanceId;
    attachmentId: ConversationAttachmentId;
    leaseToken: string;
    artifactRefs: ConversationAttachment["artifactRefs"];
    processingMetadata?: ConversationAttachment["processingMetadata"];
    warnings: ConversationAttachment["warnings"];
    completedAt: string;
  }): Promise<ConversationAttachment> {
    const completedAt = new Date(input.completedAt);
    const processingMetadata = input.processingMetadata ?? {};
    const [row] = await this.db
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

  async failClaimedConversationAttachment(input: {
    clientInstanceId: ClientInstanceId;
    attachmentId: ConversationAttachmentId;
    leaseToken: string;
    error: NonNullable<ConversationAttachment["error"]>;
    completedAt: string;
  }): Promise<ConversationAttachment> {
    const completedAt = new Date(input.completedAt);
    const [row] = await this.db
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

  async findReadyConversationAttachmentByFile(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    fileId: ManagedFileId;
  }): Promise<ConversationAttachment | undefined> {
    const [row] = await this.db
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

  async findConversationAttachmentByFile(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    fileId: ManagedFileId;
  }): Promise<ConversationAttachment | undefined> {
    const [row] = await this.db
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

  async markConversationManagedObjectsDeleted(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    deletedAt: string;
  }): Promise<ManagedObjectDeletionResult> {
    const deletedAt = new Date(input.deletedAt);
    return this.db.transaction(async (tx) => {
      await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.clientInstanceId, input.clientInstanceId),
            eq(conversations.id, input.conversationId)
          )
        )
        .for("update")
        .limit(1);
      const deletion = await collectConversationManagedObjectsForDeletion(tx, input);
      const fileIds = deletion.files.map((file) => file.id);

      await tx
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
            ne(conversationAttachments.status, "deleted")
          )
        );
      if (fileIds.length > 0) {
        await tx
          .update(managedFiles)
          .set({
            status: "deleted",
            deletedAt
          })
          .where(
            and(
              eq(managedFiles.clientInstanceId, input.clientInstanceId),
              inArray(managedFiles.id, fileIds)
            )
          );
      }
      await tx
        .delete(artifactPreviewJobs)
        .where(
          and(
            eq(artifactPreviewJobs.clientInstanceId, input.clientInstanceId),
            eq(artifactPreviewJobs.conversationId, input.conversationId)
          )
        );
      await tx
        .delete(artifactPreviewManifests)
        .where(
          and(
            eq(artifactPreviewManifests.clientInstanceId, input.clientInstanceId),
            eq(artifactPreviewManifests.conversationId, input.conversationId)
          )
        );
      await tx
        .update(managedArtifacts)
        .set({
          status: "deleted",
          deletedAt
        })
        .where(
          and(
            eq(managedArtifacts.clientInstanceId, input.clientInstanceId),
            eq(managedArtifacts.conversationId, input.conversationId),
            ne(managedArtifacts.status, "deleted")
          )
        );

      return {
        attachmentCount: deletion.attachments.length,
        fileObjectKeys: uniqueStrings(deletion.files.map((file) => file.objectKey)),
        artifactObjectKeys: uniqueStrings(deletion.artifacts.map((artifact) => artifact.objectKey))
      };
    });
  }

  async listConversationManagedObjectsForDeletion(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<ManagedObjectDeletionResult> {
    const deletion = await collectConversationManagedObjectsForDeletion(this.db, input);
    return {
      attachmentCount: deletion.attachments.length,
      fileObjectKeys: uniqueStrings(deletion.files.map((file) => file.objectKey)),
      artifactObjectKeys: uniqueStrings(deletion.artifacts.map((artifact) => artifact.objectKey))
    };
  }
}

type PostgresFileStoreDatabase = PostgresDatabase | Parameters<Parameters<PostgresDatabase["transaction"]>[0]>[0];

async function collectConversationManagedObjectsForDeletion(
  db: PostgresFileStoreDatabase,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }
): Promise<{
  attachments: Array<typeof conversationAttachments.$inferSelect>;
  files: Array<typeof managedFiles.$inferSelect>;
  artifacts: Array<typeof managedArtifacts.$inferSelect>;
}> {
  const attachments = await db
    .select()
    .from(conversationAttachments)
    .where(
      and(
        eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
        eq(conversationAttachments.conversationId, input.conversationId),
        ne(conversationAttachments.status, "deleted")
      )
    );
  const fileIds = [...new Set(attachments.map((attachment) => attachment.fileId))];
  const artifacts = await db
    .select()
    .from(managedArtifacts)
    .where(
      and(
        eq(managedArtifacts.clientInstanceId, input.clientInstanceId),
        eq(managedArtifacts.conversationId, input.conversationId),
        ne(managedArtifacts.status, "deleted")
      )
    );

  let files: Array<typeof managedFiles.$inferSelect> = [];
  if (fileIds.length > 0) {
    const sharedAttachmentRows = await db
      .select({ fileId: conversationAttachments.fileId })
      .from(conversationAttachments)
      .where(
        and(
          eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
          inArray(conversationAttachments.fileId, fileIds),
          ne(conversationAttachments.conversationId, input.conversationId),
          ne(conversationAttachments.status, "deleted")
        )
      );
    const sharedFileIds = new Set(sharedAttachmentRows.map((attachment) => attachment.fileId));
    const deletableFileIds = fileIds.filter((fileId) => !sharedFileIds.has(fileId));
    if (deletableFileIds.length > 0) {
      files = await db
        .select()
        .from(managedFiles)
        .where(
          and(
            eq(managedFiles.clientInstanceId, input.clientInstanceId),
            inArray(managedFiles.id, deletableFileIds),
            ne(managedFiles.status, "deleted")
          )
        );
    }
  }

  return { attachments, files, artifacts };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
