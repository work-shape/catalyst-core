import {
  AppError,
  DEFAULT_ARTIFACT_PREVIEW_RENDERER,
  DEFAULT_ARTIFACT_PREVIEW_RENDERER_VERSION,
  DEFAULT_ARTIFACT_PREVIEW_SETTINGS_HASH,
  type ArtifactPreviewJobRecord,
  type ArtifactPreviewManifest,
  type ClientInstanceId,
  type ConversationId,
  type ClaimNextArtifactPreviewJobInput,
  type CompleteClaimedArtifactPreviewJobInput,
  type EnqueueArtifactPreviewJobInput,
  type FailClaimedArtifactPreviewJobInput,
  type ManagedArtifactId,
  type ManagedArtifactRecord,
  type MarkClaimedArtifactPreviewJobUnsupportedInput,
  type RecoverStaleArtifactPreviewJobsInput,
  type WriteArtifactPreviewManifestInput,
  createPlatformId
} from "./index";

export interface InMemoryArtifactPreviewStoreOptions {
  managedArtifacts: Map<string, ManagedArtifactRecord>;
  requireActiveConversation(
    clientInstanceId: ClientInstanceId,
    conversationId: ConversationId
  ): Promise<void>;
}

export class InMemoryArtifactPreviewStore {
  private readonly artifactPreviewJobs = new Map<string, ArtifactPreviewJobRecord>();
  private readonly artifactPreviewManifests = new Map<string, ArtifactPreviewManifest>();

  constructor(private readonly options: InMemoryArtifactPreviewStoreOptions) {}

  async enqueueArtifactPreviewJob(
    input: EnqueueArtifactPreviewJobInput
  ): Promise<ArtifactPreviewJobRecord> {
    const renderer = input.renderer ?? DEFAULT_ARTIFACT_PREVIEW_RENDERER;
    const rendererVersion = input.rendererVersion ?? DEFAULT_ARTIFACT_PREVIEW_RENDERER_VERSION;
    const settingsHash = input.settingsHash ?? DEFAULT_ARTIFACT_PREVIEW_SETTINGS_HASH;
    const key = artifactPreviewJobKey({
      clientInstanceId: input.clientInstanceId,
      sourceArtifactId: input.sourceArtifactId,
      renderer,
      rendererVersion,
      settingsHash
    });
    const existing = this.artifactPreviewJobs.get(key);
    if (existing) {
      return existing;
    }
    const now = input.queuedAt ?? new Date().toISOString();
    const job: ArtifactPreviewJobRecord = {
      id: createPlatformId("apj"),
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
    };
    this.artifactPreviewJobs.set(key, job);
    return job;
  }

  async getArtifactPreviewJob(input: {
    clientInstanceId: ClientInstanceId;
    sourceArtifactId: ManagedArtifactId;
  }): Promise<ArtifactPreviewJobRecord | undefined> {
    return [...this.artifactPreviewJobs.values()]
      .filter(
        (job) =>
          job.clientInstanceId === input.clientInstanceId &&
          job.sourceArtifactId === input.sourceArtifactId
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }

  async claimNextArtifactPreviewJob(
    input: ClaimNextArtifactPreviewJobInput
  ): Promise<ArtifactPreviewJobRecord | undefined> {
    const dueJobs = [...this.artifactPreviewJobs.entries()]
      .filter(
        ([, job]) =>
          job.clientInstanceId === input.clientInstanceId &&
          job.status === "pending" &&
          (job.nextAttemptAt === undefined || job.nextAttemptAt <= input.now)
      )
      .sort(([, left], [, right]) =>
        `${left.nextAttemptAt ?? left.createdAt}:${left.createdAt}:${left.id}`.localeCompare(
          `${right.nextAttemptAt ?? right.createdAt}:${right.createdAt}:${right.id}`
        )
      );
    const [key, job] = dueJobs[0] ?? [];
    if (!key || !job) {
      return undefined;
    }
    const claimed: ArtifactPreviewJobRecord = {
      ...job,
      status: "processing",
      attempts: job.attempts + 1,
      nextAttemptAt: undefined,
      leaseOwnerId: input.workerId,
      leaseToken: input.leaseToken,
      leaseExpiresAt: input.leaseExpiresAt,
      errorCode: undefined,
      errorMessage: undefined,
      updatedAt: input.now
    };
    this.artifactPreviewJobs.set(key, claimed);
    return claimed;
  }

  async completeClaimedArtifactPreviewJob(
    input: CompleteClaimedArtifactPreviewJobInput
  ): Promise<ArtifactPreviewJobRecord> {
    const { key, job } = this.requireClaimedArtifactPreviewJob(input);
    await this.options.requireActiveConversation(job.clientInstanceId, job.conversationId);
    const sourceArtifact = this.options.managedArtifacts.get(job.sourceArtifactId);
    if (
      !sourceArtifact ||
      sourceArtifact.clientInstanceId !== job.clientInstanceId ||
      sourceArtifact.conversationId !== job.conversationId ||
      sourceArtifact.status === "deleted"
    ) {
      throw new AppError("CONFLICT", "Artifact preview source is no longer available");
    }
    const pages = input.previewArtifacts
      ? input.previewArtifacts.map((artifactInput) => {
          const artifact: ManagedArtifactRecord = {
            id: createPlatformId("art"),
            clientInstanceId: job.clientInstanceId,
            conversationId: job.conversationId,
            sourceFileId: artifactInput.sourceFileId,
            kind: artifactInput.kind,
            objectKey: artifactInput.objectKey,
            filename: artifactInput.filename,
            mimeType: artifactInput.mimeType,
            byteSize: artifactInput.byteSize,
            checksum: artifactInput.checksum,
            metadata: artifactInput.metadata ?? {},
            status: "available",
            createdAt: input.completedAt
          };
          this.options.managedArtifacts.set(artifact.id, artifact);
          return {
            artifactId: artifact.id,
            mimeType: artifact.mimeType as "image/png" | "image/jpeg" | "image/webp",
            filename: artifact.filename,
            ...(artifactInput.pageNumber ? { pageNumber: artifactInput.pageNumber } : {}),
            ...(artifactInput.slideNumber ? { slideNumber: artifactInput.slideNumber } : {}),
            ...(artifactInput.sheet ? { sheet: artifactInput.sheet } : {}),
            ...(artifactInput.range ? { range: artifactInput.range } : {}),
            ...(artifactInput.width ? { width: artifactInput.width } : {}),
            ...(artifactInput.height ? { height: artifactInput.height } : {})
          };
        })
      : (input.pages ?? []);
    const completed: ArtifactPreviewJobRecord = {
      ...job,
      status: "completed",
      nextAttemptAt: undefined,
      leaseOwnerId: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      errorCode: undefined,
      errorMessage: undefined,
      updatedAt: input.completedAt
    };
    this.artifactPreviewJobs.set(key, completed);
    await this.writeArtifactPreviewManifest({
      status: "ready",
      clientInstanceId: completed.clientInstanceId,
      conversationId: completed.conversationId,
      sourceArtifactId: completed.sourceArtifactId,
      type: "image_pages",
      format: input.format,
      pages,
      writtenAt: input.completedAt
    });
    return completed;
  }

  async failClaimedArtifactPreviewJob(
    input: FailClaimedArtifactPreviewJobInput
  ): Promise<ArtifactPreviewJobRecord> {
    const { key, job } = this.requireClaimedArtifactPreviewJob(input);
    const failed: ArtifactPreviewJobRecord = {
      ...job,
      status: input.retryAt ? "pending" : "failed",
      nextAttemptAt: input.retryAt,
      leaseOwnerId: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      updatedAt: input.failedAt
    };
    this.artifactPreviewJobs.set(key, failed);
    if (!input.retryAt) {
      await this.writeArtifactPreviewManifest({
        status: "failed",
        clientInstanceId: failed.clientInstanceId,
        conversationId: failed.conversationId,
        sourceArtifactId: failed.sourceArtifactId,
        errorCode: input.errorCode,
        writtenAt: input.failedAt
      });
    }
    return failed;
  }

  async markClaimedArtifactPreviewJobUnsupported(
    input: MarkClaimedArtifactPreviewJobUnsupportedInput
  ): Promise<ArtifactPreviewJobRecord> {
    const { key, job } = this.requireClaimedArtifactPreviewJob(input);
    const unsupported: ArtifactPreviewJobRecord = {
      ...job,
      status: "unsupported",
      nextAttemptAt: undefined,
      leaseOwnerId: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      errorCode: input.errorCode ?? "unsupported_type",
      errorMessage: input.errorMessage,
      updatedAt: input.unsupportedAt
    };
    this.artifactPreviewJobs.set(key, unsupported);
    await this.writeArtifactPreviewManifest({
      status: "unsupported",
      clientInstanceId: unsupported.clientInstanceId,
      conversationId: unsupported.conversationId,
      sourceArtifactId: unsupported.sourceArtifactId,
      errorCode: unsupported.errorCode,
      writtenAt: input.unsupportedAt
    });
    return unsupported;
  }

  async recoverStaleArtifactPreviewJobs(
    input: RecoverStaleArtifactPreviewJobsInput
  ): Promise<ArtifactPreviewJobRecord[]> {
    if (input.limit <= 0) {
      return [];
    }
    const staleEntries = [...this.artifactPreviewJobs.entries()]
      .filter(
        ([, job]) =>
          job.clientInstanceId === input.clientInstanceId &&
          job.status === "processing" &&
          job.leaseExpiresAt !== undefined &&
          job.leaseExpiresAt < input.staleLeaseExpiredBefore
      )
      .sort(([, left], [, right]) =>
        `${left.leaseExpiresAt}:${left.id}`.localeCompare(`${right.leaseExpiresAt}:${right.id}`)
      )
      .slice(0, input.limit);
    const recovered: ArtifactPreviewJobRecord[] = [];
    for (const [key, job] of staleEntries) {
      const terminal = job.attempts >= input.maxAttempts;
      const nextJob: ArtifactPreviewJobRecord = {
        ...job,
        status: terminal ? "failed" : "pending",
        nextAttemptAt: terminal ? undefined : (input.retryAt ?? input.recoveredAt),
        leaseOwnerId: undefined,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        errorCode: input.errorCode ?? "stale_lease",
        errorMessage: input.errorMessage,
        updatedAt: input.recoveredAt
      };
      this.artifactPreviewJobs.set(key, nextJob);
      if (terminal) {
        await this.writeArtifactPreviewManifest({
          status: "failed",
          clientInstanceId: nextJob.clientInstanceId,
          conversationId: nextJob.conversationId,
          sourceArtifactId: nextJob.sourceArtifactId,
          errorCode: nextJob.errorCode,
          writtenAt: input.recoveredAt
        });
      }
      recovered.push(nextJob);
    }
    return recovered;
  }

  async getArtifactPreviewManifest(input: {
    clientInstanceId: ClientInstanceId;
    sourceArtifactId: ManagedArtifactId;
  }): Promise<ArtifactPreviewManifest | undefined> {
    const manifest = this.artifactPreviewManifests.get(
      artifactPreviewKey(input.clientInstanceId, input.sourceArtifactId)
    );
    return manifest?.clientInstanceId === input.clientInstanceId ? manifest : undefined;
  }

  async writeArtifactPreviewManifest(
    input: WriteArtifactPreviewManifestInput
  ): Promise<ArtifactPreviewManifest> {
    const existing = await this.getArtifactPreviewManifest(input);
    const writtenAt = input.writtenAt ?? new Date().toISOString();
    const manifest: ArtifactPreviewManifest =
      input.status === "ready"
        ? {
            status: "ready",
            clientInstanceId: input.clientInstanceId,
            conversationId: input.conversationId,
            sourceArtifactId: input.sourceArtifactId,
            type: "image_pages",
            format: input.format,
            pageCount: input.pages.length,
            pages: input.pages,
            createdAt: existing?.createdAt ?? writtenAt,
            updatedAt: writtenAt
          }
        : {
            status: input.status,
            clientInstanceId: input.clientInstanceId,
            conversationId: input.conversationId,
            sourceArtifactId: input.sourceArtifactId,
            ...(input.errorCode ? { errorCode: input.errorCode } : {}),
            createdAt: existing?.createdAt ?? writtenAt,
            updatedAt: writtenAt
          };
    this.artifactPreviewManifests.set(
      artifactPreviewKey(input.clientInstanceId, input.sourceArtifactId),
      manifest
    );
    return manifest;
  }

  deletePreviewStateForConversation(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): void {
    for (const [key, job] of this.artifactPreviewJobs.entries()) {
      if (
        job.clientInstanceId === input.clientInstanceId &&
        job.conversationId === input.conversationId
      ) {
        this.artifactPreviewJobs.delete(key);
      }
    }
    for (const [key, manifest] of this.artifactPreviewManifests.entries()) {
      if (
        manifest.clientInstanceId === input.clientInstanceId &&
        manifest.conversationId === input.conversationId
      ) {
        this.artifactPreviewManifests.delete(key);
      }
    }
  }

  private requireClaimedArtifactPreviewJob(input: {
    clientInstanceId: ClientInstanceId;
    jobId: string;
    leaseToken: string;
  }): { key: string; job: ArtifactPreviewJobRecord } {
    for (const [key, job] of this.artifactPreviewJobs.entries()) {
      if (
        job.clientInstanceId === input.clientInstanceId &&
        job.id === input.jobId &&
        job.status === "processing" &&
        job.leaseToken === input.leaseToken
      ) {
        return { key, job };
      }
    }
    throw new AppError("CONFLICT", "Artifact preview job lease is no longer active");
  }
}

function artifactPreviewKey(clientInstanceId: ClientInstanceId, artifactId: ManagedArtifactId): string {
  return `${clientInstanceId}:${artifactId}`;
}

function artifactPreviewJobKey(input: {
  clientInstanceId: ClientInstanceId;
  sourceArtifactId: ManagedArtifactId;
  renderer: string;
  rendererVersion: string;
  settingsHash: string;
}): string {
  return JSON.stringify([
    input.clientInstanceId,
    input.sourceArtifactId,
    input.renderer,
    input.rendererVersion,
    input.settingsHash
  ]);
}
