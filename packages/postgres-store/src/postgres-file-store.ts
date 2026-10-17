import {
  AppError,
  artifactPreviewJobDedupeKey,
  createPlatformId,
  renderArtifactPreviewJob,
  type ArtifactPreviewJobRecord,
  type ArtifactPreviewManifest,
  type ClaimArtifactPreviewJobInput,
  type ClientInstanceId,
  type CollaborationWorkspaceId,
  type CompleteClaimedArtifactPreviewJobInput,
  type ConversationAttachment,
  type ConversationAttachmentId,
  type ConversationId,
  type CreateConversationAttachmentInput,
  type CreateManagedArtifactInput,
  type CreateManagedFileInput,
  type DraftAttachment,
  type EnqueueArtifactPreviewJobInput,
  type EnsureManagedArtifactInput,
  type FailClaimedArtifactPreviewJobInput,
  type ManagedArtifactId,
  type ManagedArtifactKind,
  type ManagedArtifactRecord,
  type ManagedFileId,
  type ManagedFileRecord,
  type ManagedObjectDeletionResult,
  type MarkClaimedArtifactPreviewJobUnsupportedInput,
  type MessageId,
  type OrphanedManagedFile,
  type PlatformFileStore,
  type RenewClaimedArtifactPreviewJobLeaseInput,
  type SubjectRowClaim,
  type UpdateConversationAttachmentInput,
  type UserId,
  type WriteArtifactPreviewManifestInput
} from "@work-shape/catalyst-core";
import { and, asc, desc, eq, gt, inArray, lt, ne, notExists, notInArray } from "drizzle-orm";
import { enqueueJob } from "./jobs/store";
import {
  claimArtifactPreviewJob as claimPostgresArtifactPreviewJob,
  completeClaimedArtifactPreviewJob as completeClaimedPostgresArtifactPreviewJob,
  enqueueArtifactPreviewJob as enqueuePostgresArtifactPreviewJob,
  failClaimedArtifactPreviewJob as failClaimedPostgresArtifactPreviewJob,
  getArtifactPreviewJob as getPostgresArtifactPreviewJob,
  getArtifactPreviewManifest as getPostgresArtifactPreviewManifest,
  listArtifactPreviewJobIdsWithoutJob,
  markClaimedArtifactPreviewJobUnsupported as markClaimedPostgresArtifactPreviewJobUnsupported,
  renewClaimedArtifactPreviewJobLease as renewClaimedPostgresArtifactPreviewJobLease,
  restoreFailedArtifactPreviewJob,
  writeArtifactPreviewManifest as writePostgresArtifactPreviewManifest
} from "./postgres-artifact-preview-operations";
import {
  claimConversationAttachmentForPreprocessing,
  claimReadyDraftAttachmentsForMessage,
  completeClaimedConversationAttachment,
  createConversationAttachment,
  deleteDraftAttachment,
  failClaimedConversationAttachment,
  findConversationAttachmentByChecksum,
  findConversationAttachmentByFile,
  findReadyConversationAttachmentByFile,
  getConversationAttachment,
  listConversationAttachmentsWithoutJob,
  listDraftAttachments,
  listSentConversationAttachments,
  reactivateDraftAttachment,
  renewClaimedConversationAttachmentLease,
  updateConversationAttachment
} from "./postgres-conversation-attachment-operations";
import {
  requireActiveConversationLock,
  touchConversation
} from "./postgres-conversation-operations";
import type { PostgresConnection as PostgresStoreConnection } from "./postgres-database";
import {
  type PostgresConnection,
  type PostgresPlatformFileStoreCallbacks
} from "./postgres-file-store-types";
import {
  listConversationManagedObjectsForDeletion,
  listConversationsPendingObjectCleanup,
  markConversationManagedObjectsDeleted
} from "./postgres-managed-object-cleanup";
import { mapManagedArtifact, mapManagedFile } from "./rows";
import { conversationAttachments, conversations, managedArtifacts, managedFiles } from "./schema";

function createPostgresPlatformFileStore(
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
      .orderBy(desc(managedArtifacts.createdAt), desc(managedArtifacts.id));
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
      .orderBy(desc(managedArtifacts.createdAt), desc(managedArtifacts.id));
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

  restoreFailedArtifactPreviewJob(input: {
    clientInstanceId: ClientInstanceId;
    jobId: string;
  }): Promise<boolean> {
    return restoreFailedArtifactPreviewJob(this.db, input);
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
    return createConversationAttachment(this.db, input);
  }

  async getConversationAttachment(input: {
    clientInstanceId: ClientInstanceId;
    attachmentId: ConversationAttachmentId;
  }): Promise<ConversationAttachment | undefined> {
    return getConversationAttachment(this.db, input);
  }

  async listDraftAttachments(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<DraftAttachment[]> {
    return listDraftAttachments(this.db, input);
  }

  async listSentConversationAttachments(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<ConversationAttachment[]> {
    return listSentConversationAttachments(this.db, input);
  }

  async findConversationAttachmentByChecksum(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    checksum: string;
  }): Promise<ConversationAttachment | undefined> {
    return findConversationAttachmentByChecksum(this.db, input);
  }

  async updateConversationAttachment(
    input: UpdateConversationAttachmentInput
  ): Promise<ConversationAttachment> {
    return updateConversationAttachment(this.db, input);
  }

  async reactivateDraftAttachment(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    attachmentId: ConversationAttachmentId;
    status: "queued" | "ready" | "unsupported";
  }): Promise<ConversationAttachment> {
    return reactivateDraftAttachment(this.db, input);
  }

  async deleteDraftAttachment(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    attachmentId: ConversationAttachmentId;
    deletedAt: string;
  }): Promise<ConversationAttachment> {
    return deleteDraftAttachment(this.db, this.callbacks, input);
  }

  async claimReadyDraftAttachmentsForMessage(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    messageId: MessageId;
    claimedAt: string;
  }): Promise<ConversationAttachment[]> {
    return claimReadyDraftAttachmentsForMessage(this.db, input);
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
    return claimConversationAttachmentForPreprocessing(this.db, input);
  }

  async renewClaimedConversationAttachmentLease(input: {
    clientInstanceId: ClientInstanceId;
    attachmentId: ConversationAttachmentId;
    leaseToken: string;
    leaseMs: number;
  }): Promise<boolean> {
    return renewClaimedConversationAttachmentLease(this.db, input);
  }

  async listConversationAttachmentsWithoutJob(input: {
    clientInstanceId: ClientInstanceId;
    jobKind: string;
    formats?: readonly string[];
    limit: number;
  }): Promise<Array<{ id: ConversationAttachmentId; conversationId: ConversationId }>> {
    return listConversationAttachmentsWithoutJob(this.db, input);
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
    return completeClaimedConversationAttachment(this.db, input);
  }

  async failClaimedConversationAttachment(input: {
    clientInstanceId: ClientInstanceId;
    attachmentId: ConversationAttachmentId;
    leaseToken: string;
    error: NonNullable<ConversationAttachment["error"]>;
    completedAt: string;
  }): Promise<ConversationAttachment> {
    return failClaimedConversationAttachment(this.db, input);
  }

  async findReadyConversationAttachmentByFile(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    fileId: ManagedFileId;
  }): Promise<ConversationAttachment | undefined> {
    return findReadyConversationAttachmentByFile(this.db, input);
  }

  async findConversationAttachmentByFile(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    fileId: ManagedFileId;
  }): Promise<ConversationAttachment | undefined> {
    return findConversationAttachmentByFile(this.db, input);
  }

  async markConversationManagedObjectsDeleted(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    deletedAt: string;
  }): Promise<ManagedObjectDeletionResult> {
    return markConversationManagedObjectsDeleted(this.db, input);
  }

  async listConversationManagedObjectsForDeletion(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<ManagedObjectDeletionResult> {
    return listConversationManagedObjectsForDeletion(this.db, input);
  }

  async listConversationsPendingObjectCleanup(input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId?: CollaborationWorkspaceId;
    createdByUserId?: UserId;
    limit: number;
  }): Promise<ConversationId[]> {
    return listConversationsPendingObjectCleanup(this.db, input);
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

/** `jobsEnqueued` is called after the store enqueued a job, as the jobs store reports its own. */
export function createPostgresFilesStore(
  db: PostgresStoreConnection,
  jobsEnqueued: () => void
): PlatformFileStore {
  return createPostgresPlatformFileStore(db, {
    jobsEnqueued,
    touchConversation: (clientInstanceId, conversationId, updatedAt) =>
      touchConversation(db, clientInstanceId, conversationId, updatedAt)
  });
}
