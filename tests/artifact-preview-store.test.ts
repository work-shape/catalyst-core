import { describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  type ClientInstanceId,
  type Conversation,
  type ManagedArtifactRecord,
  type ManagedFileRecord,
  type PlatformStore
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import { PostgresPlatformStore } from "@vivd-catalyst/postgres-store";

const databaseUrl = process.env.POSTGRES_STORE_TEST_DATABASE_URL;
const postgresIt = databaseUrl ? it : it.skip;

describe("artifact preview store adapters", () => {
  it("keeps in-memory preview job idempotency scoped to renderer settings identity", async () => {
    await expectPreviewJobIdentityContract(new InMemoryPlatformStore());
  });

  it("claims preview jobs and guards terminal updates by lease in memory", async () => {
    await expectPreviewJobLeaseContract(new InMemoryPlatformStore());
  });

  it("creates preview artifacts inside lease-guarded completion in memory", async () => {
    await expectPreviewArtifactCompletionContract(new InMemoryPlatformStore());
  });

  it("recovers stale preview job leases in memory", async () => {
    await expectPreviewJobStaleRecoveryContract(new InMemoryPlatformStore());
  });

  postgresIt(
    "keeps Postgres preview job idempotency scoped to renderer settings identity",
    async () => {
      const store = await PostgresPlatformStore.connect({
        databaseUrl: databaseUrl!,
        runMigrations: true
      });
      try {
        await expectPreviewJobIdentityContract(store);
      } finally {
        await store.close();
      }
    }
  );

  postgresIt("claims preview jobs and guards terminal updates by lease in Postgres", async () => {
    const store = await PostgresPlatformStore.connect({
      databaseUrl: databaseUrl!,
      runMigrations: true
    });
    try {
      await expectPreviewJobLeaseContract(store);
    } finally {
      await store.close();
    }
  });

  postgresIt("creates preview artifacts inside lease-guarded completion in Postgres", async () => {
    const store = await PostgresPlatformStore.connect({
      databaseUrl: databaseUrl!,
      runMigrations: true
    });
    try {
      await expectPreviewArtifactCompletionContract(store);
    } finally {
      await store.close();
    }
  });

  postgresIt("recovers stale preview job leases in Postgres", async () => {
    const store = await PostgresPlatformStore.connect({
      databaseUrl: databaseUrl!,
      runMigrations: true
    });
    try {
      await expectPreviewJobStaleRecoveryContract(store);
    } finally {
      await store.close();
    }
  });
});

async function expectPreviewJobIdentityContract(store: PreviewJobIdentityStore): Promise<void> {
  const fixture = await createPreviewFixture(store);
  const baseInput = {
    clientInstanceId: fixture.clientInstanceId,
    conversationId: fixture.conversation.id,
    sourceArtifactId: fixture.artifact.id,
    sourceChecksum: fixture.artifact.checksum,
    sourceMimeType: fixture.artifact.mimeType,
    renderer: "preview-renderer-a",
    rendererVersion: "1.0.0",
    settingsHash: "settings-a",
    queuedAt: "2026-07-01T10:00:00.000Z"
  };

  const first = await store.enqueueArtifactPreviewJob(baseInput);
  const duplicate = await store.enqueueArtifactPreviewJob({
    ...baseInput,
    queuedAt: "2026-07-01T10:05:00.000Z"
  });
  const changedRenderer = await store.enqueueArtifactPreviewJob({
    ...baseInput,
    renderer: "preview-renderer-b",
    queuedAt: "2026-07-01T10:10:00.000Z"
  });
  const changedRendererVersion = await store.enqueueArtifactPreviewJob({
    ...baseInput,
    rendererVersion: "1.0.1",
    queuedAt: "2026-07-01T10:15:00.000Z"
  });
  const changedSettings = await store.enqueueArtifactPreviewJob({
    ...baseInput,
    settingsHash: "settings-b",
    queuedAt: "2026-07-01T10:20:00.000Z"
  });

  expect(duplicate.id).toBe(first.id);
  expect(duplicate.createdAt).toBe(first.createdAt);
  expect(changedRenderer.id).not.toBe(first.id);
  expect(changedRendererVersion.id).not.toBe(first.id);
  expect(changedSettings.id).not.toBe(first.id);
  expect(changedRenderer).toMatchObject({
    sourceArtifactId: fixture.artifact.id,
    renderer: "preview-renderer-b",
    rendererVersion: "1.0.0",
    settingsHash: "settings-a"
  });
  expect(changedRendererVersion).toMatchObject({
    sourceArtifactId: fixture.artifact.id,
    renderer: "preview-renderer-a",
    rendererVersion: "1.0.1",
    settingsHash: "settings-a"
  });
  expect(changedSettings).toMatchObject({
    sourceArtifactId: fixture.artifact.id,
    renderer: "preview-renderer-a",
    rendererVersion: "1.0.0",
    settingsHash: "settings-b"
  });
  await expect(
    store.getArtifactPreviewJob({
      clientInstanceId: fixture.clientInstanceId,
      sourceArtifactId: fixture.artifact.id
    })
  ).resolves.toMatchObject({
    id: changedSettings.id,
    settingsHash: "settings-b"
  });
}

async function expectPreviewJobLeaseContract(store: PreviewJobIdentityStore): Promise<void> {
  const fixture = await createPreviewFixture(store);
  const job = await store.enqueueArtifactPreviewJob({
    clientInstanceId: fixture.clientInstanceId,
    conversationId: fixture.conversation.id,
    sourceArtifactId: fixture.artifact.id,
    sourceChecksum: fixture.artifact.checksum,
    sourceMimeType: fixture.artifact.mimeType,
    renderer: "preview-renderer-lease",
    rendererVersion: "1.0.0",
    settingsHash: "settings-lease",
    queuedAt: "2026-07-01T11:00:00.000Z"
  });

  const claimed = await store.claimNextArtifactPreviewJob({
    clientInstanceId: fixture.clientInstanceId,
    workerId: "preview-worker-a",
    leaseToken: "lease-a",
    now: "2026-07-01T11:00:01.000Z",
    leaseExpiresAt: "2026-07-01T11:05:01.000Z"
  });
  expect(claimed).toMatchObject({
    id: job.id,
    status: "processing",
    leaseOwnerId: "preview-worker-a",
    leaseToken: "lease-a",
    attempts: 1
  });
  await expect(
    store.claimNextArtifactPreviewJob({
      clientInstanceId: fixture.clientInstanceId,
      workerId: "preview-worker-b",
      leaseToken: "lease-b",
      now: "2026-07-01T11:00:02.000Z",
      leaseExpiresAt: "2026-07-01T11:05:02.000Z"
    })
  ).resolves.toBeUndefined();
  await expect(
    store.completeClaimedArtifactPreviewJob({
      clientInstanceId: fixture.clientInstanceId,
      jobId: job.id,
      leaseToken: "wrong-lease",
      format: "png",
      pages: [],
      completedAt: "2026-07-01T11:00:03.000Z"
    })
  ).rejects.toMatchObject({ code: "CONFLICT" });

  const page = await store.createManagedArtifact({
    clientInstanceId: fixture.clientInstanceId,
    conversationId: fixture.conversation.id,
    sourceFileId: fixture.artifact.sourceFileId,
    kind: "document.preview_page_image",
    objectKey: "artifact-previews/private/page-1.png",
    filename: "report-page-1.png",
    mimeType: "image/png",
    byteSize: 12,
    checksum: "sha256:page-1",
    metadata: {
      sourceArtifactId: fixture.artifact.id,
      previewRole: "page",
      pageNumber: 1,
      rendererVersion: "1.0.0"
    }
  });
  const completed = await store.completeClaimedArtifactPreviewJob({
    clientInstanceId: fixture.clientInstanceId,
    jobId: job.id,
    leaseToken: "lease-a",
    format: "png",
    pages: [
      {
        artifactId: page.id,
        mimeType: "image/png",
        filename: page.filename,
        pageNumber: 1,
        width: 100,
        height: 200
      }
    ],
    completedAt: "2026-07-01T11:00:04.000Z"
  });
  expect(completed).toMatchObject({
    id: job.id,
    status: "completed",
    leaseToken: undefined,
    attempts: 1
  });
  await expect(
    store.getArtifactPreviewManifest({
      clientInstanceId: fixture.clientInstanceId,
      sourceArtifactId: fixture.artifact.id
    })
  ).resolves.toMatchObject({
    status: "ready",
    pageCount: 1,
    pages: [expect.objectContaining({ artifactId: page.id, pageNumber: 1 })]
  });
}

async function expectPreviewArtifactCompletionContract(
  store: PreviewJobIdentityStore
): Promise<void> {
  const fixture = await createPreviewFixture(store);
  const job = await store.enqueueArtifactPreviewJob({
    clientInstanceId: fixture.clientInstanceId,
    conversationId: fixture.conversation.id,
    sourceArtifactId: fixture.artifact.id,
    sourceChecksum: fixture.artifact.checksum,
    sourceMimeType: fixture.artifact.mimeType,
    renderer: "preview-renderer-completion",
    rendererVersion: "1.0.0",
    settingsHash: "settings-completion",
    queuedAt: "2026-07-01T11:30:00.000Z"
  });
  await store.claimNextArtifactPreviewJob({
    clientInstanceId: fixture.clientInstanceId,
    workerId: "preview-worker-completion",
    leaseToken: "lease-completion",
    now: "2026-07-01T11:30:01.000Z",
    leaseExpiresAt: "2026-07-01T11:35:01.000Z"
  });
  const previewArtifact = {
    sourceFileId: fixture.file.id,
    kind: "document.preview_page_image",
    objectKey: "artifact-previews/private/report-page-1.png",
    filename: "report-page-1.png",
    mimeType: "image/png" as const,
    byteSize: 12,
    checksum: "sha256:preview-page-1",
    metadata: {
      sourceArtifactId: fixture.artifact.id,
      previewRole: "page",
      pageNumber: 1,
      rendererVersion: "1.0.0"
    },
    pageNumber: 1,
    width: 100,
    height: 200
  };

  await expect(
    store.completeClaimedArtifactPreviewJob({
      clientInstanceId: fixture.clientInstanceId,
      jobId: job.id,
      leaseToken: "wrong-lease",
      format: "png",
      previewArtifacts: [previewArtifact],
      completedAt: "2026-07-01T11:30:02.000Z"
    })
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(
    store.listManagedArtifactsForFile({
      clientInstanceId: fixture.clientInstanceId,
      conversationId: fixture.conversation.id,
      fileId: fixture.file.id,
      kind: "document.preview_page_image"
    })
  ).resolves.toEqual([]);

  const completed = await store.completeClaimedArtifactPreviewJob({
    clientInstanceId: fixture.clientInstanceId,
    jobId: job.id,
    leaseToken: "lease-completion",
    format: "png",
    previewArtifacts: [previewArtifact],
    completedAt: "2026-07-01T11:30:03.000Z"
  });
  expect(completed).toMatchObject({
    id: job.id,
    status: "completed",
    leaseToken: undefined
  });
  const manifest = await store.getArtifactPreviewManifest({
    clientInstanceId: fixture.clientInstanceId,
    sourceArtifactId: fixture.artifact.id
  });
  expect(manifest).toMatchObject({
    status: "ready",
    pageCount: 1,
    pages: [
      expect.objectContaining({
        filename: "report-page-1.png",
        mimeType: "image/png",
        pageNumber: 1,
        width: 100,
        height: 200
      })
    ]
  });
  if (!manifest || manifest.status !== "ready") {
    throw new Error("Expected ready preview manifest");
  }
  await expect(
    store.getManagedArtifact({
      clientInstanceId: fixture.clientInstanceId,
      artifactId: manifest.pages[0]!.artifactId
    })
  ).resolves.toMatchObject({
    sourceFileId: fixture.file.id,
    kind: "document.preview_page_image",
    objectKey: "artifact-previews/private/report-page-1.png",
    status: "available"
  });
}

async function expectPreviewJobStaleRecoveryContract(
  store: PreviewJobIdentityStore
): Promise<void> {
  const fixture = await createPreviewFixture(store);
  await store.enqueueArtifactPreviewJob({
    clientInstanceId: fixture.clientInstanceId,
    conversationId: fixture.conversation.id,
    sourceArtifactId: fixture.artifact.id,
    sourceChecksum: fixture.artifact.checksum,
    sourceMimeType: fixture.artifact.mimeType,
    renderer: "preview-renderer-stale",
    rendererVersion: "1.0.0",
    settingsHash: "settings-stale",
    queuedAt: "2026-07-01T12:00:00.000Z"
  });
  const firstClaim = await store.claimNextArtifactPreviewJob({
    clientInstanceId: fixture.clientInstanceId,
    workerId: "preview-worker-stale",
    leaseToken: "lease-stale-1",
    now: "2026-07-01T12:00:01.000Z",
    leaseExpiresAt: "2026-07-01T12:01:00.000Z"
  });
  expect(firstClaim).toMatchObject({ status: "processing", attempts: 1 });

  await expect(
    store.recoverStaleArtifactPreviewJobs({
      clientInstanceId: fixture.clientInstanceId,
      staleLeaseExpiredBefore: "2026-07-01T12:00:30.000Z",
      recoveredAt: "2026-07-01T12:00:30.000Z",
      maxAttempts: 2,
      limit: 10
    })
  ).resolves.toHaveLength(0);

  const retried = await store.recoverStaleArtifactPreviewJobs({
    clientInstanceId: fixture.clientInstanceId,
    staleLeaseExpiredBefore: "2026-07-01T12:02:00.000Z",
    recoveredAt: "2026-07-01T12:02:01.000Z",
    maxAttempts: 2,
    limit: 10
  });
  expect(retried).toHaveLength(1);
  expect(retried[0]).toMatchObject({
    status: "pending",
    attempts: 1,
    leaseToken: undefined,
    errorCode: "stale_lease"
  });

  const secondClaim = await store.claimNextArtifactPreviewJob({
    clientInstanceId: fixture.clientInstanceId,
    workerId: "preview-worker-stale",
    leaseToken: "lease-stale-2",
    now: "2026-07-01T12:02:02.000Z",
    leaseExpiresAt: "2026-07-01T12:03:00.000Z"
  });
  expect(secondClaim).toMatchObject({ status: "processing", attempts: 2 });

  const failed = await store.recoverStaleArtifactPreviewJobs({
    clientInstanceId: fixture.clientInstanceId,
    staleLeaseExpiredBefore: "2026-07-01T12:04:00.000Z",
    recoveredAt: "2026-07-01T12:04:01.000Z",
    maxAttempts: 2,
    limit: 10
  });
  expect(failed).toHaveLength(1);
  expect(failed[0]).toMatchObject({
    status: "failed",
    attempts: 2,
    leaseToken: undefined,
    errorCode: "stale_lease"
  });
  await expect(
    store.getArtifactPreviewManifest({
      clientInstanceId: fixture.clientInstanceId,
      sourceArtifactId: fixture.artifact.id
    })
  ).resolves.toMatchObject({
    status: "failed",
    errorCode: "stale_lease"
  });
}

async function createPreviewFixture(store: PreviewJobIdentityStore): Promise<{
  clientInstanceId: ClientInstanceId;
  conversation: Conversation;
  file: ManagedFileRecord;
  artifact: ManagedArtifactRecord;
}> {
  const clientInstanceId = asClientInstanceId(`preview_store_${globalThis.crypto.randomUUID()}`);
  const conversation = await store.createConversation({
    clientInstanceId,
    ownerUserId: "user-1",
    ownerExternalUserId: "user-1",
    title: "Artifact preview store parity",
    retainedUntil: "2030-01-01T00:00:00.000Z"
  });
  const file = await store.createManagedFile({
    clientInstanceId,
    ownerUserId: "user-1",
    filename: "report.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    byteSize: 128,
    checksum: "sha256:report-docx",
    objectKey: "execution-workspaces/private/report.docx"
  });
  const artifact = await store.createManagedArtifact({
    clientInstanceId,
    conversationId: conversation.id,
    sourceFileId: file.id,
    kind: "document.docx",
    objectKey: "execution-workspaces/private/report.docx",
    filename: "report.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    byteSize: 128,
    checksum: "sha256:report-docx"
  });
  return { clientInstanceId, conversation, file, artifact };
}

type PreviewJobIdentityStore = Pick<
  PlatformStore,
  | "createManagedFile"
  | "createConversation"
  | "createManagedArtifact"
  | "getManagedArtifact"
  | "listManagedArtifactsForFile"
  | "enqueueArtifactPreviewJob"
  | "getArtifactPreviewJob"
  | "claimNextArtifactPreviewJob"
  | "completeClaimedArtifactPreviewJob"
  | "failClaimedArtifactPreviewJob"
  | "markClaimedArtifactPreviewJobUnsupported"
  | "recoverStaleArtifactPreviewJobs"
  | "getArtifactPreviewManifest"
>;
