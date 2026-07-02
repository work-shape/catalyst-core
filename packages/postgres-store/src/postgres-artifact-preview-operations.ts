import { and, desc, eq, sql as drizzleSql } from "drizzle-orm";
import {
  AppError,
  DEFAULT_ARTIFACT_PREVIEW_RENDERER,
  DEFAULT_ARTIFACT_PREVIEW_RENDERER_VERSION,
  DEFAULT_ARTIFACT_PREVIEW_SETTINGS_HASH,
  type ArtifactPreviewImagePageRef,
  type ArtifactPreviewJobRecord,
  type ArtifactPreviewManifest,
  type ClaimNextArtifactPreviewJobInput,
  type ClientInstanceId,
  type CompleteClaimedArtifactPreviewJobInput,
  type EnqueueArtifactPreviewJobInput,
  type FailClaimedArtifactPreviewJobInput,
  type ManagedArtifactId,
  type MarkClaimedArtifactPreviewJobUnsupportedInput,
  type RecoverStaleArtifactPreviewJobsInput,
  type WriteArtifactPreviewManifestInput,
  createPlatformId
} from "@vivd-catalyst/core";
import type { PostgresDatabase } from "./postgres-database";
import { mapArtifactPreviewJob, mapArtifactPreviewManifest } from "./rows";
import {
  artifactPreviewJobs,
  artifactPreviewManifests,
  conversations,
  managedArtifacts
} from "./schema";

export async function enqueueArtifactPreviewJob(
  db: PostgresDatabase,
  input: EnqueueArtifactPreviewJobInput
): Promise<ArtifactPreviewJobRecord> {
  const now = new Date(input.queuedAt ?? new Date().toISOString());
  const renderer = input.renderer ?? DEFAULT_ARTIFACT_PREVIEW_RENDERER;
  const rendererVersion = input.rendererVersion ?? DEFAULT_ARTIFACT_PREVIEW_RENDERER_VERSION;
  const settingsHash = input.settingsHash ?? DEFAULT_ARTIFACT_PREVIEW_SETTINGS_HASH;
  const [inserted] = await db
    .insert(artifactPreviewJobs)
    .values({
      id: createPlatformId<"ArtifactPreviewJobId">("apj"),
      clientInstanceId: input.clientInstanceId,
      conversationId: input.conversationId,
      sourceArtifactId: input.sourceArtifactId,
      sourceChecksum: input.sourceChecksum,
      sourceMimeType: input.sourceMimeType,
      renderer,
      rendererVersion,
      settingsHash,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now
    })
    .onConflictDoNothing({
      target: [
        artifactPreviewJobs.clientInstanceId,
        artifactPreviewJobs.sourceArtifactId,
        artifactPreviewJobs.renderer,
        artifactPreviewJobs.rendererVersion,
        artifactPreviewJobs.settingsHash
      ]
    })
    .returning();
  if (inserted) {
    return mapArtifactPreviewJob(inserted);
  }

  const [existing] = await db
    .select()
    .from(artifactPreviewJobs)
    .where(
      and(
        eq(artifactPreviewJobs.clientInstanceId, input.clientInstanceId),
        eq(artifactPreviewJobs.sourceArtifactId, input.sourceArtifactId),
        eq(artifactPreviewJobs.renderer, renderer),
        eq(artifactPreviewJobs.rendererVersion, rendererVersion),
        eq(artifactPreviewJobs.settingsHash, settingsHash)
      )
    )
    .limit(1);
  if (!existing) {
    throw new AppError("INTERNAL", "Artifact preview job could not be enqueued");
  }
  return mapArtifactPreviewJob(existing);
}

export async function getArtifactPreviewJob(
  db: PostgresDatabase,
  input: {
    clientInstanceId: ClientInstanceId;
    sourceArtifactId: ManagedArtifactId;
  }
): Promise<ArtifactPreviewJobRecord | undefined> {
  const [row] = await db
    .select()
    .from(artifactPreviewJobs)
    .where(
      and(
        eq(artifactPreviewJobs.clientInstanceId, input.clientInstanceId),
        eq(artifactPreviewJobs.sourceArtifactId, input.sourceArtifactId)
      )
    )
    .orderBy(desc(artifactPreviewJobs.createdAt))
    .limit(1);
  return row ? mapArtifactPreviewJob(row) : undefined;
}

export async function claimNextArtifactPreviewJob(
  db: PostgresDatabase,
  input: ClaimNextArtifactPreviewJobInput
): Promise<ArtifactPreviewJobRecord | undefined> {
  const claimed = await db.transaction(async (tx) => {
    const rows = (await tx.execute(drizzleSql<{ id: string }>`
      with candidate as (
        select id
        from artifact_preview_jobs
        where client_instance_id = ${input.clientInstanceId}
          and status = 'pending'
          and (
            next_attempt_at is null
            or next_attempt_at <= ${input.now}::timestamptz
          )
        order by coalesce(next_attempt_at, created_at) asc, created_at asc, id asc
        limit 1
        for update skip locked
      )
      update artifact_preview_jobs apj
      set status = 'processing',
          attempts = apj.attempts + 1,
          next_attempt_at = null,
          lease_owner_id = ${input.workerId},
          lease_token = ${input.leaseToken},
          lease_expires_at = ${input.leaseExpiresAt}::timestamptz,
          error_code = null,
          error_message = null,
          updated_at = ${input.now}::timestamptz
      from candidate
      where apj.id = candidate.id
      returning apj.id
    `)) as unknown as Array<{ id: string }>;
    const jobId = rows[0]?.id;
    if (!jobId) {
      return undefined;
    }
    const [row] = await tx
      .select()
      .from(artifactPreviewJobs)
      .where(
        and(
          eq(artifactPreviewJobs.clientInstanceId, input.clientInstanceId),
          eq(artifactPreviewJobs.id, jobId)
        )
      )
      .limit(1);
    return row;
  });
  return claimed ? mapArtifactPreviewJob(claimed) : undefined;
}

export async function completeClaimedArtifactPreviewJob(
  db: PostgresDatabase,
  input: CompleteClaimedArtifactPreviewJobInput
): Promise<ArtifactPreviewJobRecord> {
  const completedAt = new Date(input.completedAt);
  return db.transaction(async (tx) => {
    const [lockedConversation] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.clientInstanceId, input.clientInstanceId),
          eq(conversations.status, "active"),
          drizzleSql`${conversations.id} = (
            select conversation_id
            from artifact_preview_jobs
            where client_instance_id = ${input.clientInstanceId}
              and id = ${input.jobId}
              and status = 'processing'
              and lease_token = ${input.leaseToken}
          )`
        )
      )
      .for("update")
      .limit(1);
    if (!lockedConversation) {
      throw new AppError("CONFLICT", "Artifact preview job lease is no longer active");
    }
    const [job] = await tx
      .update(artifactPreviewJobs)
      .set({
        status: "completed",
        nextAttemptAt: null,
        leaseOwnerId: null,
        leaseToken: null,
        leaseExpiresAt: null,
        errorCode: null,
        errorMessage: null,
        updatedAt: completedAt
      })
      .where(claimedArtifactPreviewJobWhere(input))
      .returning();
    if (!job) {
      throw new AppError("CONFLICT", "Artifact preview job lease is no longer active");
    }
    const [sourceArtifact] = await tx
      .select({ id: managedArtifacts.id })
      .from(managedArtifacts)
      .where(
        and(
          eq(managedArtifacts.clientInstanceId, job.clientInstanceId),
          eq(managedArtifacts.conversationId, job.conversationId),
          eq(managedArtifacts.id, job.sourceArtifactId),
          eq(managedArtifacts.status, "available")
        )
      )
      .limit(1);
    if (!sourceArtifact) {
      throw new AppError("CONFLICT", "Artifact preview source is no longer available");
    }
    const pages = input.previewArtifacts
      ? await createPreviewArtifacts(tx, {
          job,
          completedAt,
          artifacts: input.previewArtifacts
        })
      : (input.pages ?? []);
    await tx
      .insert(artifactPreviewManifests)
      .values({
        clientInstanceId: job.clientInstanceId,
        conversationId: job.conversationId,
        sourceArtifactId: job.sourceArtifactId,
        status: "ready",
        type: "image_pages",
        format: input.format,
        pageCount: pages.length,
        pages,
        errorCode: null,
        createdAt: completedAt,
        updatedAt: completedAt
      })
      .onConflictDoUpdate({
        target: [
          artifactPreviewManifests.clientInstanceId,
          artifactPreviewManifests.sourceArtifactId
        ],
        set: {
          conversationId: job.conversationId,
          status: "ready",
          type: "image_pages",
          format: input.format,
          pageCount: pages.length,
          pages,
          errorCode: null,
          updatedAt: completedAt
        }
      });
    return mapArtifactPreviewJob(job);
  });
}

export async function failClaimedArtifactPreviewJob(
  db: PostgresDatabase,
  input: FailClaimedArtifactPreviewJobInput
): Promise<ArtifactPreviewJobRecord> {
  const failedAt = new Date(input.failedAt);
  const retryAt = input.retryAt ? new Date(input.retryAt) : null;
  return db.transaction(async (tx) => {
    const [job] = await tx
      .update(artifactPreviewJobs)
      .set({
        status: retryAt ? "pending" : "failed",
        nextAttemptAt: retryAt,
        leaseOwnerId: null,
        leaseToken: null,
        leaseExpiresAt: null,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage ?? null,
        updatedAt: failedAt
      })
      .where(claimedArtifactPreviewJobWhere(input))
      .returning();
    if (!job) {
      throw new AppError("CONFLICT", "Artifact preview job lease is no longer active");
    }
    if (!retryAt) {
      await writeTerminalPreviewManifest(tx, {
        status: "failed",
        job,
        errorCode: input.errorCode,
        writtenAt: failedAt
      });
    }
    return mapArtifactPreviewJob(job);
  });
}

export async function markClaimedArtifactPreviewJobUnsupported(
  db: PostgresDatabase,
  input: MarkClaimedArtifactPreviewJobUnsupportedInput
): Promise<ArtifactPreviewJobRecord> {
  const unsupportedAt = new Date(input.unsupportedAt);
  const errorCode = input.errorCode ?? "unsupported_type";
  return db.transaction(async (tx) => {
    const [job] = await tx
      .update(artifactPreviewJobs)
      .set({
        status: "unsupported",
        nextAttemptAt: null,
        leaseOwnerId: null,
        leaseToken: null,
        leaseExpiresAt: null,
        errorCode,
        errorMessage: input.errorMessage ?? null,
        updatedAt: unsupportedAt
      })
      .where(claimedArtifactPreviewJobWhere(input))
      .returning();
    if (!job) {
      throw new AppError("CONFLICT", "Artifact preview job lease is no longer active");
    }
    await writeTerminalPreviewManifest(tx, {
      status: "unsupported",
      job,
      errorCode,
      writtenAt: unsupportedAt
    });
    return mapArtifactPreviewJob(job);
  });
}

export async function recoverStaleArtifactPreviewJobs(
  db: PostgresDatabase,
  input: RecoverStaleArtifactPreviewJobsInput
): Promise<ArtifactPreviewJobRecord[]> {
  if (input.limit <= 0) {
    return [];
  }
  const recoveredAt = new Date(input.recoveredAt);
  const retryAt = new Date(input.retryAt ?? input.recoveredAt);
  return db.transaction(async (tx) => {
    const staleRows = (await tx.execute(drizzleSql<{ id: string }>`
      select id
      from artifact_preview_jobs
      where client_instance_id = ${input.clientInstanceId}
        and status = 'processing'
        and lease_expires_at is not null
        and lease_expires_at < ${input.staleLeaseExpiredBefore}::timestamptz
      order by lease_expires_at asc, id asc
      limit ${input.limit}
      for update skip locked
    `)) as unknown as Array<{ id: string }>;
    const recovered: ArtifactPreviewJobRecord[] = [];
    for (const stale of staleRows) {
      const [current] = await tx
        .select()
        .from(artifactPreviewJobs)
        .where(
          and(
            eq(artifactPreviewJobs.clientInstanceId, input.clientInstanceId),
            eq(artifactPreviewJobs.id, stale.id)
          )
        )
        .limit(1);
      if (!current) {
        continue;
      }
      const terminal = current.attempts >= input.maxAttempts;
      const errorCode = input.errorCode ?? "stale_lease";
      const [job] = await tx
        .update(artifactPreviewJobs)
        .set({
          status: terminal ? "failed" : "pending",
          nextAttemptAt: terminal ? null : retryAt,
          leaseOwnerId: null,
          leaseToken: null,
          leaseExpiresAt: null,
          errorCode,
          errorMessage: input.errorMessage ?? null,
          updatedAt: recoveredAt
        })
        .where(
          and(
            eq(artifactPreviewJobs.clientInstanceId, input.clientInstanceId),
            eq(artifactPreviewJobs.id, stale.id)
          )
        )
        .returning();
      if (!job) {
        continue;
      }
      if (terminal) {
        await writeTerminalPreviewManifest(tx, {
          status: "failed",
          job,
          errorCode,
          writtenAt: recoveredAt
        });
      }
      recovered.push(mapArtifactPreviewJob(job));
    }
    return recovered;
  });
}

export async function getArtifactPreviewManifest(
  db: PostgresDatabase,
  input: {
    clientInstanceId: ClientInstanceId;
    sourceArtifactId: ManagedArtifactId;
  }
): Promise<ArtifactPreviewManifest | undefined> {
  const [row] = await db
    .select()
    .from(artifactPreviewManifests)
    .where(
      and(
        eq(artifactPreviewManifests.clientInstanceId, input.clientInstanceId),
        eq(artifactPreviewManifests.sourceArtifactId, input.sourceArtifactId)
      )
    )
    .limit(1);
  return row ? mapArtifactPreviewManifest(row) : undefined;
}

export async function writeArtifactPreviewManifest(
  db: PostgresDatabase,
  input: WriteArtifactPreviewManifestInput
): Promise<ArtifactPreviewManifest> {
  const existing = await getArtifactPreviewManifest(db, input);
  const writtenAt = new Date(input.writtenAt ?? new Date().toISOString());
  const createdAt = existing ? new Date(existing.createdAt) : writtenAt;
  const [row] = await db
    .insert(artifactPreviewManifests)
    .values({
      clientInstanceId: input.clientInstanceId,
      conversationId: input.conversationId,
      sourceArtifactId: input.sourceArtifactId,
      status: input.status,
      type: input.status === "ready" ? "image_pages" : null,
      format: input.status === "ready" ? input.format : null,
      pageCount: input.status === "ready" ? input.pages.length : 0,
      pages: input.status === "ready" ? input.pages : [],
      errorCode: input.status === "ready" ? null : (input.errorCode ?? null),
      createdAt,
      updatedAt: writtenAt
    })
    .onConflictDoUpdate({
      target: [
        artifactPreviewManifests.clientInstanceId,
        artifactPreviewManifests.sourceArtifactId
      ],
      set: {
        conversationId: input.conversationId,
        status: input.status,
        type: input.status === "ready" ? "image_pages" : null,
        format: input.status === "ready" ? input.format : null,
        pageCount: input.status === "ready" ? input.pages.length : 0,
        pages: input.status === "ready" ? input.pages : [],
        errorCode: input.status === "ready" ? null : (input.errorCode ?? null),
        updatedAt: writtenAt
      }
    })
    .returning();
  return mapArtifactPreviewManifest(row);
}

type PreviewTransaction = Parameters<Parameters<PostgresDatabase["transaction"]>[0]>[0];
type ArtifactPreviewJobRow = typeof artifactPreviewJobs.$inferSelect;

async function createPreviewArtifacts(
  tx: PreviewTransaction,
  input: {
    job: ArtifactPreviewJobRow;
    completedAt: Date;
    artifacts: NonNullable<CompleteClaimedArtifactPreviewJobInput["previewArtifacts"]>;
  }
): Promise<ArtifactPreviewImagePageRef[]> {
  const pages: ArtifactPreviewImagePageRef[] = [];
  for (const artifactInput of input.artifacts) {
    const [artifact] = await tx
      .insert(managedArtifacts)
      .values({
        id: createPlatformId<"ManagedArtifactId">("art"),
        clientInstanceId: input.job.clientInstanceId,
        conversationId: input.job.conversationId,
        sourceFileId: artifactInput.sourceFileId ?? null,
        kind: artifactInput.kind,
        objectKey: artifactInput.objectKey,
        filename: artifactInput.filename ?? null,
        mimeType: artifactInput.mimeType,
        byteSize: artifactInput.byteSize,
        checksum: artifactInput.checksum,
        metadata: artifactInput.metadata ?? {},
        status: "available",
        createdAt: input.completedAt
      })
      .returning();
    if (!artifact) {
      throw new AppError("INTERNAL", "Artifact preview image artifact could not be created");
    }
    pages.push({
      artifactId: artifact.id as ArtifactPreviewImagePageRef["artifactId"],
      mimeType: artifactInput.mimeType,
      filename: artifactInput.filename,
      ...(artifactInput.pageNumber ? { pageNumber: artifactInput.pageNumber } : {}),
      ...(artifactInput.slideNumber ? { slideNumber: artifactInput.slideNumber } : {}),
      ...(artifactInput.sheet ? { sheet: artifactInput.sheet } : {}),
      ...(artifactInput.range ? { range: artifactInput.range } : {}),
      ...(artifactInput.width ? { width: artifactInput.width } : {}),
      ...(artifactInput.height ? { height: artifactInput.height } : {})
    });
  }
  return pages;
}

async function writeTerminalPreviewManifest(
  tx: PreviewTransaction,
  input: {
    status: "failed" | "unsupported";
    job: ArtifactPreviewJobRow;
    errorCode: string;
    writtenAt: Date;
  }
): Promise<void> {
  await tx
    .insert(artifactPreviewManifests)
    .values({
      clientInstanceId: input.job.clientInstanceId,
      conversationId: input.job.conversationId,
      sourceArtifactId: input.job.sourceArtifactId,
      status: input.status,
      type: null,
      format: null,
      pageCount: 0,
      pages: [],
      errorCode: input.errorCode,
      createdAt: input.writtenAt,
      updatedAt: input.writtenAt
    })
    .onConflictDoUpdate({
      target: [
        artifactPreviewManifests.clientInstanceId,
        artifactPreviewManifests.sourceArtifactId
      ],
      set: {
        conversationId: input.job.conversationId,
        status: input.status,
        type: null,
        format: null,
        pageCount: 0,
        pages: [],
        errorCode: input.errorCode,
        updatedAt: input.writtenAt
      }
    });
}

function claimedArtifactPreviewJobWhere(input: {
  clientInstanceId: ClientInstanceId;
  jobId: string;
  leaseToken: string;
}) {
  return and(
    eq(artifactPreviewJobs.clientInstanceId, input.clientInstanceId),
    eq(artifactPreviewJobs.id, input.jobId),
    eq(artifactPreviewJobs.status, "processing"),
    eq(artifactPreviewJobs.leaseToken, input.leaseToken)
  );
}
