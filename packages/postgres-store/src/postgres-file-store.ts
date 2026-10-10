import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notExists,
  notInArray,
  sql as drizzleSql
} from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  AppError,
  artifactPreviewJobDedupeKey,
  asConversationAttachmentId,
  asConversationId,
  renderArtifactPreviewJob,
  type SubjectRowClaim,
  type ArtifactPreviewJobRecord,
  type ArtifactPreviewManifest,
  type ClaimArtifactPreviewJobInput,
  type ClientInstanceId,
  type CollaborationWorkspaceId,
  type UserId,
  type CompleteClaimedArtifactPreviewJobInput,
  type ConversationAttachment,
  type ConversationAttachmentId,
  type ConversationId,
  type CreateConversationAttachmentInput,
  type EnqueueArtifactPreviewJobInput,
  type EnsureManagedArtifactInput,
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
  type OrphanedManagedFile,
  type RenewClaimedArtifactPreviewJobLeaseInput,
  type UpdateConversationAttachmentInput,
  type WriteArtifactPreviewManifestInput,
  createPlatformId
} from "@vivd-catalyst/core";
import {
  lockActiveConversation,
  requireActiveConversationLock,
  touchConversation
} from "./postgres-conversation-operations";
import { enqueueJob } from "./jobs/store";
import { conversationsPendingCleanup } from "./postgres-pending-cleanup";
import { mapConversationAttachment, mapManagedArtifact, mapManagedFile } from "./rows";
import {
  claimArtifactPreviewJob as claimPostgresArtifactPreviewJob,
  completeClaimedArtifactPreviewJob as completeClaimedPostgresArtifactPreviewJob,
  enqueueArtifactPreviewJob as enqueuePostgresArtifactPreviewJob,
  failClaimedArtifactPreviewJob as failClaimedPostgresArtifactPreviewJob,
  getArtifactPreviewJob as getPostgresArtifactPreviewJob,
  getArtifactPreviewManifest as getPostgresArtifactPreviewManifest,
  markClaimedArtifactPreviewJobUnsupported as markClaimedPostgresArtifactPreviewJobUnsupported,
  listArtifactPreviewJobIdsWithoutJob,
  renewClaimedArtifactPreviewJobLease as renewClaimedPostgresArtifactPreviewJobLease,
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

type PostgresConnection = PostgresJsDatabase<typeof schema>;

function leaseExpiry(leaseMs: number) {
  return drizzleSql`now() + make_interval(secs => ${leaseMs}::double precision / 1000)`;
}

export interface PostgresPlatformFileStoreCallbacks {
  /** Tells the job workers of this process that the store enqueued a job. */
  jobsEnqueued(): void;
  touchConversation(
    clientInstanceId: ClientInstanceId,
    conversationId: ConversationId,
    updatedAt: Date
  ): Promise<void>;
}

export function createPostgresPlatformFileStore(
  db: PostgresConnection,
  callbacks: PostgresPlatformFileStoreCallbacks
): PlatformFileStore {
  return new PostgresPlatformFileStore(db, callbacks);
}

class PostgresPlatformFileStore implements PlatformFileStore {
  constructor(
    private readonly db: PostgresConnection,
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

  async listOrphanedManagedFiles(input: {
    clientInstanceId: ClientInstanceId;
    createdBefore: string;
    afterFileId?: ManagedFileId;
    limit: number;
  }): Promise<OrphanedManagedFile[]> {
    const rows = await this.db
      .select({ id: managedFiles.id, objectKey: managedFiles.objectKey })
      .from(managedFiles)
      .where(
        and(
          this.orphanedManagedFileCondition(input),
          input.afterFileId ? gt(managedFiles.id, input.afterFileId) : undefined
        )
      )
      .orderBy(asc(managedFiles.id))
      .limit(input.limit);
    if (rows.length === 0) {
      return [];
    }
    const fileIds = rows.map((row) => row.id);
    const objectKeys = [...new Set(rows.map((row) => row.objectKey))];
    const [otherFiles, artifacts] = await Promise.all([
      this.db
        .selectDistinct({ objectKey: managedFiles.objectKey })
        .from(managedFiles)
        .where(
          and(
            eq(managedFiles.clientInstanceId, input.clientInstanceId),
            inArray(managedFiles.objectKey, objectKeys),
            ne(managedFiles.status, "deleted"),
            notInArray(managedFiles.id, fileIds)
          )
        ),
      this.db
        .selectDistinct({ objectKey: managedArtifacts.objectKey })
        .from(managedArtifacts)
        .where(
          and(
            eq(managedArtifacts.clientInstanceId, input.clientInstanceId),
            inArray(managedArtifacts.objectKey, objectKeys),
            ne(managedArtifacts.status, "deleted")
          )
        )
    ]);
    const objectKeysInUse = new Set([...otherFiles, ...artifacts].map((row) => row.objectKey));
    return rows.map((row) => ({
      id: row.id as ManagedFileId,
      objectKey: row.objectKey,
      objectKeyInUse: objectKeysInUse.has(row.objectKey)
    }));
  }

  async markOrphanedManagedFilesDeleted(input: {
    clientInstanceId: ClientInstanceId;
    fileIds: readonly ManagedFileId[];
    createdBefore: string;
    deletedAt: string;
  }): Promise<number> {
    if (input.fileIds.length === 0) {
      return 0;
    }
    const rows = await this.db
      .update(managedFiles)
      .set({ status: "deleted", deletedAt: new Date(input.deletedAt) })
      .where(
        and(this.orphanedManagedFileCondition(input), inArray(managedFiles.id, [...input.fileIds]))
      )
      .returning({ id: managedFiles.id });
    return rows.length;
  }

  /**
   * A file is orphaned when no active Conversation refers to it, neither through an attachment
   * of any status (a removed draft attachment can be restored) nor as an artifact source.
   */
  private orphanedManagedFileCondition(input: {
    clientInstanceId: ClientInstanceId;
    createdBefore: string;
  }) {
    return and(
      eq(managedFiles.clientInstanceId, input.clientInstanceId),
      ne(managedFiles.status, "deleted"),
      lt(managedFiles.createdAt, new Date(input.createdBefore)),
      notExists(
        this.db
          .select({ id: conversationAttachments.id })
          .from(conversationAttachments)
          .innerJoin(conversations, eq(conversations.id, conversationAttachments.conversationId))
          .where(
            and(
              eq(conversationAttachments.fileId, managedFiles.id),
              eq(conversations.status, "active")
            )
          )
      ),
      notExists(
        this.db
          .select({ id: managedArtifacts.id })
          .from(managedArtifacts)
          .innerJoin(conversations, eq(conversations.id, managedArtifacts.conversationId))
          .where(
            and(
              eq(managedArtifacts.sourceFileId, managedFiles.id),
              ne(managedArtifacts.status, "deleted"),
              eq(conversations.status, "active")
            )
          )
      )
    );
  }

  async createManagedArtifact(input: CreateManagedArtifactInput): Promise<ManagedArtifactRecord> {
    return this.db.transaction(async (tx) => {
      await requireActiveConversationLock(tx, input.clientInstanceId, input.conversationId);
      const [row] = await tx
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
    });
  }

  async ensureManagedArtifact(input: EnsureManagedArtifactInput): Promise<ManagedArtifactRecord> {
    const created = await this.db.transaction(async (tx) => {
      await requireActiveConversationLock(tx, input.clientInstanceId, input.conversationId);
      const [row] = await tx
        .insert(managedArtifacts)
        .values({
          id: input.id,
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
        .onConflictDoNothing({ target: managedArtifacts.id })
        .returning();
      return row;
    });
    if (created) {
      return mapManagedArtifact(created);
    }
    const existing = await this.getManagedArtifact({
      clientInstanceId: input.clientInstanceId,
      artifactId: input.id
    });
    if (!existing || !managedArtifactMatchesEnsureInput(existing, input)) {
      throw new AppError("CONFLICT", "Managed artifact id belongs to a different artifact");
    }
    return existing;
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

  async listConversationManagedArtifacts(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<ManagedArtifactRecord[]> {
    const rows = await this.db
      .select()
      .from(managedArtifacts)
      .where(
        and(
          eq(managedArtifacts.clientInstanceId, input.clientInstanceId),
          eq(managedArtifacts.conversationId, input.conversationId),
          eq(managedArtifacts.status, "available")
        )
      )
      .orderBy(desc(managedArtifacts.createdAt));
    return rows.map(mapManagedArtifact);
  }

  async enqueueArtifactPreviewJob(
    input: EnqueueArtifactPreviewJobInput
  ): Promise<ArtifactPreviewJobRecord> {
    // The row and the job that drives it commit together, whoever asks for the preview.
    const record = await this.db.transaction(async (tx) => {
      const row = await enqueuePostgresArtifactPreviewJob(tx, input);
      if (row.status === "pending" || row.status === "processing")
        await this.enqueueArtifactPreviewRender(tx, input.clientInstanceId, row.id);
      return row;
    });
    this.callbacks.jobsEnqueued();
    return record;
  }

  private async enqueueArtifactPreviewRender(
    tx: PostgresConnection,
    clientInstanceId: ClientInstanceId,
    previewJobId: string
  ): Promise<void> {
    await enqueueJob(
      tx,
      renderArtifactPreviewJob,
      { previewJobId },
      {
        clientInstanceId,
        subject: previewJobId,
        dedupeKey: artifactPreviewJobDedupeKey(previewJobId)
      }
    );
  }

  async adoptArtifactPreviewJobs(input: {
    clientInstanceId: ClientInstanceId;
    limit: number;
  }): Promise<number> {
    const ids = await listArtifactPreviewJobIdsWithoutJob(this.db, {
      clientInstanceId: input.clientInstanceId,
      jobKind: renderArtifactPreviewJob.kind,
      limit: input.limit
    });
    for (const id of ids)
      await this.enqueueArtifactPreviewRender(this.db, input.clientInstanceId, id);
    if (ids.length > 0) this.callbacks.jobsEnqueued();
    return ids.length;
  }

  async getArtifactPreviewJob(input: {
    clientInstanceId: ClientInstanceId;
    sourceArtifactId: ManagedArtifactId;
    renderer?: string;
    rendererVersion?: string;
    settingsHash?: string;
  }): Promise<ArtifactPreviewJobRecord | undefined> {
    return getPostgresArtifactPreviewJob(this.db, input);
  }

  async claimArtifactPreviewJob(
    input: ClaimArtifactPreviewJobInput
  ): Promise<SubjectRowClaim<ArtifactPreviewJobRecord>> {
    return claimPostgresArtifactPreviewJob(this.db, input);
  }

  async renewClaimedArtifactPreviewJobLease(
    input: RenewClaimedArtifactPreviewJobLeaseInput
  ): Promise<boolean> {
    return renewClaimedPostgresArtifactPreviewJobLease(this.db, input);
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

  async getArtifactPreviewManifest(input: {
    clientInstanceId: ClientInstanceId;
    sourceArtifactId: ManagedArtifactId;
    renderer?: string;
    rendererVersion?: string;
    settingsHash?: string;
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
    const row = await this.db.transaction(async (tx) => {
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

  async listSentConversationAttachments(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<ConversationAttachment[]> {
    const rows = await this.db
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

  async findConversationAttachmentByChecksum(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    checksum: string;
  }): Promise<ConversationAttachment | undefined> {
    const [row] = await this.db
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

  async reactivateDraftAttachment(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    attachmentId: ConversationAttachmentId;
    status: "queued" | "ready" | "unsupported";
  }): Promise<ConversationAttachment> {
    const row = await this.db.transaction(async (tx) => {
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
      await touchConversation(
        tx,
        input.clientInstanceId,
        input.conversationId,
        attachment.updatedAt
      );
      return attachment;
    });
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

  /**
   * Takes an attachment by id for the executor job that preprocesses it and writes the job's
   * lease onto the row's lease columns, which a worker of the previous release reads. The row
   * is taken when it is queued, when its lease ran out, or when `leaseOwnerId` already holds
   * it: that is an earlier attempt of the same job, whose lease the executor has ended.
   */
  async claimConversationAttachmentForPreprocessing(input: {
    clientInstanceId: ClientInstanceId;
    attachmentId: ConversationAttachmentId;
    leaseOwnerId: string;
    leaseToken: string;
    leaseMs: number;
  }): Promise<SubjectRowClaim<ConversationAttachment>> {
    const ofRow = and(
      eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
      eq(conversationAttachments.id, input.attachmentId)
    );
    const [claimed] = await this.db
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
    const [current] = await this.db
      .select({ status: conversationAttachments.status })
      .from(conversationAttachments)
      .where(ofRow)
      .limit(1);
    return current?.status === "queued" || current?.status === "preprocessing"
      ? { status: "held" }
      : { status: "finished" };
  }

  async renewClaimedConversationAttachmentLease(input: {
    clientInstanceId: ClientInstanceId;
    attachmentId: ConversationAttachmentId;
    leaseToken: string;
    leaseMs: number;
  }): Promise<boolean> {
    const rows = await this.db
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

  async listConversationAttachmentsWithoutJob(input: {
    clientInstanceId: ClientInstanceId;
    jobKind: string;
    formats?: readonly string[];
    limit: number;
  }): Promise<Array<{ id: ConversationAttachmentId; conversationId: ConversationId }>> {
    const rows = await this.db
      .select({
        id: conversationAttachments.id,
        conversationId: conversationAttachments.conversationId
      })
      .from(conversationAttachments)
      .where(
        and(
          eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
          inArray(conversationAttachments.status, ["queued", "preprocessing"]),
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

  async listConversationsPendingObjectCleanup(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId?: CollaborationWorkspaceId;
    createdByUserId?: UserId;
    limit: number;
  }): Promise<ConversationId[]> {
    if (input.limit <= 0) {
      return [];
    }
    const rows = await this.db
      .select({ id: drizzleSql<string>`pending.id` })
      .from(
        drizzleSql`(${conversationsPendingCleanup({
          clientInstanceId: input.clientInstanceId,
          collaborationWorkspaceId: input.collaborationWorkspaceId,
          createdByUserId: input.createdByUserId,
          executionWorkspaces:
            input.collaborationWorkspaceId !== undefined || input.createdByUserId !== undefined
        })}) pending`
      )
      .orderBy(drizzleSql`pending.deleted_at asc`, drizzleSql`pending.id asc`)
      .limit(input.limit);
    return rows.map((row) => asConversationId(row.id));
  }
}

function managedArtifactMatchesEnsureInput(
  artifact: ManagedArtifactRecord,
  input: EnsureManagedArtifactInput
): boolean {
  return (
    artifact.clientInstanceId === input.clientInstanceId &&
    artifact.conversationId === input.conversationId &&
    artifact.sourceFileId === input.sourceFileId &&
    artifact.kind === input.kind &&
    artifact.objectKey === input.objectKey &&
    artifact.checksum === input.checksum &&
    artifact.status === "available"
  );
}

type PostgresFileStoreDatabase =
  PostgresConnection | Parameters<Parameters<PostgresConnection["transaction"]>[0]>[0];

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
        eq(conversationAttachments.conversationId, input.conversationId)
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
