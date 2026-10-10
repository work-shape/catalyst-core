import { and, asc, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import {
  AppError,
  type ArtifactPreviewImageArtifactInput,
  type ArtifactPreviewImagePageRef,
  type ArtifactPreviewJobRecord,
  type ArtifactPreviewManifest,
  type ArtifactPreviewModelImageRef,
  type ClaimArtifactPreviewJobInput,
  type ClientInstanceId,
  type CompleteClaimedArtifactPreviewJobInput,
  type EnqueueArtifactPreviewJobInput,
  type FailClaimedArtifactPreviewJobInput,
  type ManagedArtifactId,
  type MarkClaimedArtifactPreviewJobUnsupportedInput,
  type RenewClaimedArtifactPreviewJobLeaseInput,
  type SubjectRowClaim,
  type WriteArtifactPreviewManifestInput,
  asManagedArtifactId,
  createPlatformId,
  normalizeArtifactPreviewIdentity
} from "@vivd-catalyst/core";
import type { PostgresConnection } from "./postgres-database";
import { mapArtifactPreviewJob, mapArtifactPreviewManifest } from "./rows";
import {
  artifactPreviewJobs,
  artifactPreviewManifests,
  conversations,
  managedArtifacts
} from "./schema";

export async function enqueueArtifactPreviewJob(
  db: PostgresConnection,
  input: EnqueueArtifactPreviewJobInput
): Promise<ArtifactPreviewJobRecord> {
  const now = new Date(input.queuedAt ?? new Date().toISOString());
  const { renderer, rendererVersion, settingsHash } = normalizeArtifactPreviewIdentity(input);
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
  if (input.replaceTerminal && isTerminalArtifactPreviewJob(existing.status)) {
    const [replaced] = await db
      .update(artifactPreviewJobs)
      .set({
        sourceChecksum: input.sourceChecksum,
        sourceMimeType: input.sourceMimeType,
        status: "pending",
        attempts: 0,
        nextAttemptAt: now,
        leaseOwnerId: null,
        leaseToken: null,
        leaseExpiresAt: null,
        errorCode: null,
        errorMessage: null,
        updatedAt: now
      })
      .where(
        and(
          eq(artifactPreviewJobs.id, existing.id),
          inArray(artifactPreviewJobs.status, ["completed", "failed", "unsupported"])
        )
      )
      .returning();
    if (replaced) {
      return mapArtifactPreviewJob(replaced);
    }
    const [current] = await db
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
    if (current) {
      return mapArtifactPreviewJob(current);
    }
  }
  return mapArtifactPreviewJob(existing);
}

function isTerminalArtifactPreviewJob(status: ArtifactPreviewJobRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "unsupported";
}

export async function getArtifactPreviewJob(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    sourceArtifactId: ManagedArtifactId;
    renderer?: string;
    rendererVersion?: string;
    settingsHash?: string;
  }
): Promise<ArtifactPreviewJobRecord | undefined> {
  const { renderer, rendererVersion, settingsHash } = normalizeArtifactPreviewIdentity(input);
  const [row] = await db
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
  return row ? mapArtifactPreviewJob(row) : undefined;
}

/**
 * Takes a preview row by id for the executor job that drives it and writes the job's lease
 * onto the row's lease columns, which a worker of the previous release reads. The row is taken
 * when it is pending, when its lease ran out, or when `leaseOwnerId` already holds it: that is
 * an earlier attempt of the same job, whose lease the executor has ended.
 */
export async function claimArtifactPreviewJob(
  db: PostgresConnection,
  input: ClaimArtifactPreviewJobInput
): Promise<SubjectRowClaim<ArtifactPreviewJobRecord>> {
  const ofRow = and(
    eq(artifactPreviewJobs.clientInstanceId, input.clientInstanceId),
    eq(artifactPreviewJobs.id, input.jobId)
  );
  const [claimed] = await db
    .update(artifactPreviewJobs)
    .set({
      status: "processing",
      attempts: drizzleSql`${artifactPreviewJobs.attempts} + 1`,
      nextAttemptAt: null,
      leaseOwnerId: input.leaseOwnerId,
      leaseToken: input.leaseToken,
      leaseExpiresAt: leaseExpiry(input.leaseMs),
      errorCode: null,
      errorMessage: null,
      updatedAt: drizzleSql`now()`
    })
    .where(
      and(
        ofRow,
        drizzleSql`(
          ${artifactPreviewJobs.status} = 'pending'
          or (
            ${artifactPreviewJobs.status} = 'processing'
            and (
              ${artifactPreviewJobs.leaseExpiresAt} is null
              or ${artifactPreviewJobs.leaseExpiresAt} <= now()
              or ${artifactPreviewJobs.leaseOwnerId} = ${input.leaseOwnerId}
            )
          )
        )`
      )
    )
    .returning();
  if (claimed) return { status: "claimed", row: mapArtifactPreviewJob(claimed) };
  const [current] = await db
    .select({ status: artifactPreviewJobs.status })
    .from(artifactPreviewJobs)
    .where(ofRow)
    .limit(1);
  return current && !isTerminalArtifactPreviewJob(current.status)
    ? { status: "held" }
    : { status: "finished" };
}

/**
 * A failed preview row waits for work again, as a row that was asked for anew does. True when
 * the row waits for work after the call.
 */
export async function restoreFailedArtifactPreviewJob(
  db: PostgresConnection,
  input: { clientInstanceId: ClientInstanceId; jobId: string }
): Promise<boolean> {
  const ofRow = and(
    eq(artifactPreviewJobs.clientInstanceId, input.clientInstanceId),
    eq(artifactPreviewJobs.id, input.jobId)
  );
  await db
    .update(artifactPreviewJobs)
    .set({
      status: "pending",
      attempts: 0,
      nextAttemptAt: drizzleSql`now()`,
      leaseOwnerId: null,
      leaseToken: null,
      leaseExpiresAt: null,
      errorCode: null,
      errorMessage: null,
      updatedAt: drizzleSql`now()`
    })
    .where(and(ofRow, eq(artifactPreviewJobs.status, "failed")));
  const [current] = await db
    .select({ status: artifactPreviewJobs.status })
    .from(artifactPreviewJobs)
    .where(ofRow)
    .limit(1);
  return current !== undefined && !isTerminalArtifactPreviewJob(current.status);
}

export async function renewClaimedArtifactPreviewJobLease(
  db: PostgresConnection,
  input: RenewClaimedArtifactPreviewJobLeaseInput
): Promise<boolean> {
  const rows = await db
    .update(artifactPreviewJobs)
    .set({ leaseExpiresAt: leaseExpiry(input.leaseMs), updatedAt: drizzleSql`now()` })
    .where(claimedArtifactPreviewJobWhere(input))
    .returning({ id: artifactPreviewJobs.id });
  return rows.length > 0;
}

/**
 * Transition release only: the preview rows that are not finished and have no queued or
 * running job of `jobKind` under the row's dedupe key, oldest first.
 */
export async function listArtifactPreviewJobIdsWithoutJob(
  db: PostgresConnection,
  input: { clientInstanceId: ClientInstanceId; jobKind: string; limit: number }
): Promise<string[]> {
  const rows = await db
    .select({ id: artifactPreviewJobs.id })
    .from(artifactPreviewJobs)
    .where(
      and(
        eq(artifactPreviewJobs.clientInstanceId, input.clientInstanceId),
        inArray(artifactPreviewJobs.status, ["pending", "processing"]),
        drizzleSql`not exists (
          select 1 from platform_jobs job
          where job.client_instance_id = ${artifactPreviewJobs.clientInstanceId}
            and job.kind = ${input.jobKind}
            and job.dedupe_key = ${input.jobKind} || ':' || ${artifactPreviewJobs.id}
            and job.status in ('queued', 'running')
        )`
      )
    )
    .orderBy(asc(artifactPreviewJobs.createdAt), asc(artifactPreviewJobs.id))
    .limit(input.limit);
  return rows.map((row) => row.id);
}

function leaseExpiry(leaseMs: number) {
  return drizzleSql`now() + make_interval(secs => ${leaseMs}::double precision / 1000)`;
}

export async function completeClaimedArtifactPreviewJob(
  db: PostgresConnection,
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
        renderer: job.renderer,
        rendererVersion: job.rendererVersion,
        settingsHash: job.settingsHash,
        status: "ready",
        type: "image_pages",
        format: input.format,
        pageCount: input.sourcePageCount ?? pages.length,
        pages,
        errorCode: null,
        createdAt: completedAt,
        updatedAt: completedAt
      })
      .onConflictDoUpdate({
        target: [
          artifactPreviewManifests.clientInstanceId,
          artifactPreviewManifests.sourceArtifactId,
          artifactPreviewManifests.renderer,
          artifactPreviewManifests.rendererVersion,
          artifactPreviewManifests.settingsHash
        ],
        set: {
          conversationId: job.conversationId,
          status: "ready",
          type: "image_pages",
          format: input.format,
          pageCount: input.sourcePageCount ?? pages.length,
          pages,
          errorCode: null,
          updatedAt: completedAt
        }
      });
    return mapArtifactPreviewJob(job);
  });
}

export async function failClaimedArtifactPreviewJob(
  db: PostgresConnection,
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
  db: PostgresConnection,
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

export async function getArtifactPreviewManifest(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    sourceArtifactId: ManagedArtifactId;
    renderer?: string;
    rendererVersion?: string;
    settingsHash?: string;
  }
): Promise<ArtifactPreviewManifest | undefined> {
  const { renderer, rendererVersion, settingsHash } = normalizeArtifactPreviewIdentity(input);
  const [row] = await db
    .select()
    .from(artifactPreviewManifests)
    .where(
      and(
        eq(artifactPreviewManifests.clientInstanceId, input.clientInstanceId),
        eq(artifactPreviewManifests.sourceArtifactId, input.sourceArtifactId),
        eq(artifactPreviewManifests.renderer, renderer),
        eq(artifactPreviewManifests.rendererVersion, rendererVersion),
        eq(artifactPreviewManifests.settingsHash, settingsHash)
      )
    )
    .limit(1);
  return row ? mapArtifactPreviewManifest(row) : undefined;
}

export async function writeArtifactPreviewManifest(
  db: PostgresConnection,
  input: WriteArtifactPreviewManifestInput
): Promise<ArtifactPreviewManifest> {
  const existing = await getArtifactPreviewManifest(db, input);
  const writtenAt = new Date(input.writtenAt ?? new Date().toISOString());
  const createdAt = existing ? new Date(existing.createdAt) : writtenAt;
  const { renderer, rendererVersion, settingsHash } = normalizeArtifactPreviewIdentity(input);
  const [row] = await db
    .insert(artifactPreviewManifests)
    .values({
      clientInstanceId: input.clientInstanceId,
      conversationId: input.conversationId,
      sourceArtifactId: input.sourceArtifactId,
      renderer,
      rendererVersion,
      settingsHash,
      status: input.status,
      type: input.status === "ready" ? "image_pages" : null,
      format: input.status === "ready" ? input.format : null,
      pageCount: input.status === "ready" ? (input.pageCount ?? input.pages.length) : 0,
      pages: input.status === "ready" ? input.pages : [],
      errorCode: input.status === "ready" ? null : (input.errorCode ?? null),
      createdAt,
      updatedAt: writtenAt
    })
    .onConflictDoUpdate({
      target: [
        artifactPreviewManifests.clientInstanceId,
        artifactPreviewManifests.sourceArtifactId,
        artifactPreviewManifests.renderer,
        artifactPreviewManifests.rendererVersion,
        artifactPreviewManifests.settingsHash
      ],
      set: {
        conversationId: input.conversationId,
        status: input.status,
        type: input.status === "ready" ? "image_pages" : null,
        format: input.status === "ready" ? input.format : null,
        pageCount: input.status === "ready" ? (input.pageCount ?? input.pages.length) : 0,
        pages: input.status === "ready" ? input.pages : [],
        errorCode: input.status === "ready" ? null : (input.errorCode ?? null),
        updatedAt: writtenAt
      }
    })
    .returning();
  return mapArtifactPreviewManifest(row);
}

type PreviewTransaction = Parameters<Parameters<PostgresConnection["transaction"]>[0]>[0];
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
    const modelImage = artifactInput.modelImage
      ? await createPreviewModelImageArtifact(tx, {
          job: input.job,
          completedAt: input.completedAt,
          page: artifactInput,
          image: artifactInput.modelImage
        })
      : undefined;
    pages.push({
      artifactId: artifact.id as ArtifactPreviewImagePageRef["artifactId"],
      mimeType: artifactInput.mimeType,
      filename: artifactInput.filename,
      ...(artifactInput.pageNumber ? { pageNumber: artifactInput.pageNumber } : {}),
      ...(artifactInput.slideNumber ? { slideNumber: artifactInput.slideNumber } : {}),
      ...(artifactInput.sheet ? { sheet: artifactInput.sheet } : {}),
      ...(artifactInput.range ? { range: artifactInput.range } : {}),
      ...(artifactInput.width ? { width: artifactInput.width } : {}),
      ...(artifactInput.height ? { height: artifactInput.height } : {}),
      ...(modelImage ? { modelImage } : {})
    });
  }
  return pages;
}

/** The model's rendition of a page: an artifact of the page's kind, marked by its rendition. */
async function createPreviewModelImageArtifact(
  tx: PreviewTransaction,
  input: {
    job: ArtifactPreviewJobRow;
    completedAt: Date;
    page: ArtifactPreviewImageArtifactInput;
    image: NonNullable<ArtifactPreviewImageArtifactInput["modelImage"]>;
  }
): Promise<ArtifactPreviewModelImageRef> {
  const { image } = input;
  const [artifact] = await tx
    .insert(managedArtifacts)
    .values({
      id: createPlatformId<"ManagedArtifactId">("art"),
      clientInstanceId: input.job.clientInstanceId,
      conversationId: input.job.conversationId,
      sourceFileId: input.page.sourceFileId ?? null,
      kind: input.page.kind,
      objectKey: image.objectKey,
      filename: image.filename ?? null,
      mimeType: image.mimeType,
      byteSize: image.byteSize,
      checksum: image.checksum,
      metadata: { ...input.page.metadata, previewRendition: "model" },
      status: "available",
      createdAt: input.completedAt
    })
    .returning();
  if (!artifact) {
    throw new AppError("INTERNAL", "Artifact preview model image artifact could not be created");
  }
  return {
    artifactId: asManagedArtifactId(artifact.id),
    mimeType: image.mimeType,
    ...(image.width ? { width: image.width } : {}),
    ...(image.height ? { height: image.height } : {})
  };
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
      renderer: input.job.renderer,
      rendererVersion: input.job.rendererVersion,
      settingsHash: input.job.settingsHash,
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
        artifactPreviewManifests.sourceArtifactId,
        artifactPreviewManifests.renderer,
        artifactPreviewManifests.rendererVersion,
        artifactPreviewManifests.settingsHash
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
