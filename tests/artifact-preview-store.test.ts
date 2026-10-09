import { beforeAllWithPostgres as beforeAll } from "./support/postgres-hooks";
import { fileTestDatabaseUrl } from "./support/test-database";
import {} from "vitest";
import { type TestPostgresStore, createTestInstance } from "./support/test-instance";
import { describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import {
  asClientInstanceId,
  asManagedArtifactId,
  type ClientInstanceId,
  type Conversation,
  type ManagedArtifactRecord,
  type ManagedFileRecord,
  type PlatformStores
} from "@vivd-catalyst/core";

describe("artifact preview store adapters", () => {
  it("ensures one deterministic attachment preview source in Postgres", async () => {
    const store = (
      await createTestInstance({
        postgres: {}
      })
    ).stores;
    try {
      await expectManagedArtifactEnsureContract(store);
    } finally {
      await store.close();
    }
  });

  it("keeps Postgres preview job idempotency scoped to renderer settings identity", async () => {
    const store = (
      await createTestInstance({
        postgres: {}
      })
    ).stores;
    try {
      await expectPreviewJobIdentityContract(store);
    } finally {
      await store.close();
    }
  });

  it("does not reuse a failure recorded under the cell limit of the previous renderer version", async () => {
    const store = (await createTestInstance({ postgres: {} })).stores;
    try {
      const fixture = await createPreviewFixture(store);
      const source = {
        clientInstanceId: fixture.clientInstanceId,
        conversationId: fixture.conversation.id,
        sourceArtifactId: fixture.artifact.id
      };
      const job = {
        ...source,
        sourceChecksum: fixture.artifact.checksum,
        sourceMimeType: fixture.artifact.mimeType
      };
      // What a sheet above 5,000 cells left behind before the limit was raised.
      const previous = { rendererVersion: "preview-contract-v1" };
      const failedJob = await store.files.enqueueArtifactPreviewJob({ ...job, ...previous });
      await store.files.writeArtifactPreviewManifest({
        ...source,
        ...previous,
        status: "failed",
        errorCode: "page_limit_exceeded",
        writtenAt: "2026-10-01T10:00:00.000Z"
      });

      const reopened = await store.files.enqueueArtifactPreviewJob(job);

      expect(reopened.id).not.toBe(failedJob.id);
      expect(reopened).toMatchObject({ status: "pending", attempts: 0 });
      await expect(store.files.getArtifactPreviewManifest(source)).resolves.toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it("claims preview jobs and guards terminal updates by lease in Postgres", async () => {
    const store = (
      await createTestInstance({
        postgres: {}
      })
    ).stores;
    try {
      await expectPreviewJobLeaseContract(store);
    } finally {
      await store.close();
    }
  });

  it("creates preview artifacts inside lease-guarded completion in Postgres", async () => {
    const store = (
      await createTestInstance({
        postgres: {}
      })
    ).stores;
    try {
      await expectPreviewArtifactCompletionContract(store);
    } finally {
      await store.close();
    }
  });

  it("takes a preview row over for the same job or after its lease, and never a finished one", async () => {
    const store = (
      await createTestInstance({
        postgres: {}
      })
    ).stores;
    const rawSql = postgres(databaseUrl, { max: 1 });
    try {
      await expectPreviewRowTakeoverContract(store, rawSql);
    } finally {
      await rawSql.end();
      await store.close();
    }
  });

  it("does not clear a processing lease when retry replacement races with worker claim in Postgres", async () => {
    const store = (
      await createTestInstance({
        postgres: {}
      })
    ).stores;
    const rawSql = postgres(databaseUrl, { max: 5 });
    try {
      await expectPreviewJobRetryReplacementRaceContract(store, rawSql);
    } finally {
      await rawSql.end();
      await store.close();
    }
  });
});

async function expectManagedArtifactEnsureContract(
  store: Pick<PlatformStores, "conversations" | "files" | "workspaces" | "users">
): Promise<void> {
  const clientInstanceId = asClientInstanceId(`preview_source_${globalThis.crypto.randomUUID()}`);
  const user = await store.users.createUser({ clientInstanceId, displayLabel: "Preview user" });
  const personalWorkspace = await store.workspaces.ensurePersonalWorkspace({
    clientInstanceId,
    userId: user.id
  });
  const conversation = await store.conversations.createConversation({
    visibility: "workspace",
    clientInstanceId,
    collaborationWorkspaceId: personalWorkspace.id,
    createdByUserId: user.id,
    createdByExternalUserId: "user-1",
    title: "Attachment preview source",
    retainedUntil: "2030-01-01T00:00:00.000Z"
  });
  const file = await store.files.createManagedFile({
    clientInstanceId,
    ownerUserId: user.id,
    filename: "deck.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    byteSize: 128,
    checksum: "sha256:deck",
    objectKey: "documents/private/deck.pptx"
  });
  const input = {
    id: asManagedArtifactId(`art_attachment_preview_${globalThis.crypto.randomUUID()}`),
    clientInstanceId,
    conversationId: conversation.id,
    sourceFileId: file.id,
    kind: "preview.source_attachment",
    objectKey: file.objectKey,
    filename: file.filename,
    mimeType: file.mimeType!,
    byteSize: file.byteSize,
    checksum: file.checksum,
    metadata: { source: "conversation_attachment" }
  };

  const [first, second] = await Promise.all([
    store.files.ensureManagedArtifact(input),
    store.files.ensureManagedArtifact(input)
  ]);

  expect(first.id).toBe(input.id);
  expect(second.id).toBe(input.id);
  await expect(
    store.files.listManagedArtifactsForFile({
      clientInstanceId,
      conversationId: conversation.id,
      fileId: file.id,
      kind: input.kind
    })
  ).resolves.toHaveLength(1);
}

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

  const first = await store.files.enqueueArtifactPreviewJob(baseInput);
  const duplicate = await store.files.enqueueArtifactPreviewJob({
    ...baseInput,
    queuedAt: "2026-07-01T10:05:00.000Z"
  });
  const changedRenderer = await store.files.enqueueArtifactPreviewJob({
    ...baseInput,
    renderer: "preview-renderer-b",
    queuedAt: "2026-07-01T10:10:00.000Z"
  });
  const changedRendererVersion = await store.files.enqueueArtifactPreviewJob({
    ...baseInput,
    rendererVersion: "1.0.1",
    queuedAt: "2026-07-01T10:15:00.000Z"
  });
  const changedSettings = await store.files.enqueueArtifactPreviewJob({
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
    store.files.getArtifactPreviewJob({
      clientInstanceId: fixture.clientInstanceId,
      sourceArtifactId: fixture.artifact.id,
      renderer: "preview-renderer-a",
      rendererVersion: "1.0.0",
      settingsHash: "settings-b"
    })
  ).resolves.toMatchObject({
    id: changedSettings.id,
    settingsHash: "settings-b"
  });
  await expect(
    store.files.getArtifactPreviewJob({
      clientInstanceId: fixture.clientInstanceId,
      sourceArtifactId: fixture.artifact.id
    })
  ).resolves.toBeUndefined();

  await store.files.writeArtifactPreviewManifest({
    clientInstanceId: fixture.clientInstanceId,
    conversationId: fixture.conversation.id,
    sourceArtifactId: fixture.artifact.id,
    status: "failed",
    errorCode: "conversion_failed",
    writtenAt: "2026-07-01T10:25:00.000Z"
  });
  await store.files.writeArtifactPreviewManifest({
    clientInstanceId: fixture.clientInstanceId,
    conversationId: fixture.conversation.id,
    sourceArtifactId: fixture.artifact.id,
    renderer: "preview-renderer-a",
    rendererVersion: "1.0.0",
    settingsHash: "settings-b",
    status: "ready",
    type: "image_pages",
    format: "png",
    pages: [],
    writtenAt: "2026-07-01T10:30:00.000Z"
  });
  await expect(
    store.files.getArtifactPreviewManifest({
      clientInstanceId: fixture.clientInstanceId,
      sourceArtifactId: fixture.artifact.id
    })
  ).resolves.toMatchObject({
    status: "failed",
    renderer: "artifact-preview-worker",
    rendererVersion: "preview-contract-v2",
    settingsHash: "default-image-pages-v1"
  });
  await expect(
    store.files.getArtifactPreviewManifest({
      clientInstanceId: fixture.clientInstanceId,
      sourceArtifactId: fixture.artifact.id,
      renderer: "preview-renderer-a",
      rendererVersion: "1.0.0",
      settingsHash: "settings-b"
    })
  ).resolves.toMatchObject({
    status: "ready",
    renderer: "preview-renderer-a",
    rendererVersion: "1.0.0",
    settingsHash: "settings-b"
  });
}

async function expectPreviewJobLeaseContract(store: PreviewJobIdentityStore): Promise<void> {
  const fixture = await createPreviewFixture(store);
  const job = await store.files.enqueueArtifactPreviewJob({
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

  const claimed = await claimPreviewRow(
    store,
    fixture.clientInstanceId,
    job.id,
    "preview-worker-a",
    "lease-a"
  );
  expect(claimed).toMatchObject({
    id: job.id,
    status: "processing",
    leaseOwnerId: "preview-worker-a",
    leaseToken: "lease-a",
    attempts: 1
  });
  await expect(
    claimPreviewRow(store, fixture.clientInstanceId, job.id, "preview-worker-b", "lease-b")
  ).resolves.toBeUndefined();
  await expect(
    store.files.completeClaimedArtifactPreviewJob({
      clientInstanceId: fixture.clientInstanceId,
      jobId: job.id,
      leaseToken: "wrong-lease",
      format: "png",
      pages: [],
      completedAt: "2026-07-01T11:00:03.000Z"
    })
  ).rejects.toMatchObject({ code: "CONFLICT" });

  const page = await store.files.createManagedArtifact({
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
  const completed = await store.files.completeClaimedArtifactPreviewJob({
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
    store.files.getArtifactPreviewManifest({
      clientInstanceId: fixture.clientInstanceId,
      sourceArtifactId: fixture.artifact.id,
      renderer: "preview-renderer-lease",
      rendererVersion: "1.0.0",
      settingsHash: "settings-lease"
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
  const job = await store.files.enqueueArtifactPreviewJob({
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
  await claimPreviewRow(
    store,
    fixture.clientInstanceId,
    job.id,
    "preview-worker-completion",
    "lease-completion"
  );
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
    store.files.completeClaimedArtifactPreviewJob({
      clientInstanceId: fixture.clientInstanceId,
      jobId: job.id,
      leaseToken: "wrong-lease",
      format: "png",
      previewArtifacts: [previewArtifact],
      completedAt: "2026-07-01T11:30:02.000Z"
    })
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(
    store.files.listManagedArtifactsForFile({
      clientInstanceId: fixture.clientInstanceId,
      conversationId: fixture.conversation.id,
      fileId: fixture.file.id,
      kind: "document.preview_page_image"
    })
  ).resolves.toEqual([]);

  const completed = await store.files.completeClaimedArtifactPreviewJob({
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
  const manifest = await store.files.getArtifactPreviewManifest({
    clientInstanceId: fixture.clientInstanceId,
    sourceArtifactId: fixture.artifact.id,
    renderer: "preview-renderer-completion",
    rendererVersion: "1.0.0",
    settingsHash: "settings-completion"
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
    store.files.getManagedArtifact({
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

async function expectPreviewRowTakeoverContract(
  store: PreviewJobIdentityStore,
  rawSql: Sql
): Promise<void> {
  const fixture = await createPreviewFixture(store);
  const job = await store.files.enqueueArtifactPreviewJob({
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
  const claim = (leaseOwnerId: string, leaseToken: string) =>
    store.files.claimArtifactPreviewJob({
      clientInstanceId: fixture.clientInstanceId,
      jobId: job.id,
      leaseOwnerId,
      leaseToken,
      leaseMs: 60_000
    });

  await expect(claim("job:one", "lease-1")).resolves.toMatchObject({
    status: "claimed",
    row: { status: "processing", attempts: 1, leaseOwnerId: "job:one", leaseToken: "lease-1" }
  });
  // A live lease of another owner is left alone.
  await expect(claim("job:two", "lease-2")).resolves.toEqual({ status: "held" });
  // A later attempt of the same job takes the row over at once.
  await expect(claim("job:one", "lease-3")).resolves.toMatchObject({
    status: "claimed",
    row: { attempts: 2, leaseToken: "lease-3" }
  });
  // The earlier attempt's token no longer extends the lease.
  await expect(
    store.files.renewClaimedArtifactPreviewJobLease({
      clientInstanceId: fixture.clientInstanceId,
      jobId: job.id,
      leaseToken: "lease-1",
      leaseMs: 60_000
    })
  ).resolves.toBe(false);
  await expect(
    store.files.renewClaimedArtifactPreviewJobLease({
      clientInstanceId: fixture.clientInstanceId,
      jobId: job.id,
      leaseToken: "lease-3",
      leaseMs: 60_000
    })
  ).resolves.toBe(true);

  // Once the lease ran out, by the database's clock, another owner takes the row.
  await rawSql`
    update artifact_preview_jobs set lease_expires_at = now() - interval '1 second'
    where id = ${job.id}
  `;
  await expect(claim("job:two", "lease-4")).resolves.toMatchObject({
    status: "claimed",
    row: { attempts: 3, leaseOwnerId: "job:two", leaseToken: "lease-4" }
  });

  await store.files.failClaimedArtifactPreviewJob({
    clientInstanceId: fixture.clientInstanceId,
    jobId: job.id,
    leaseToken: "lease-4",
    errorCode: "stale_lease",
    failedAt: "2026-07-01T12:04:01.000Z"
  });
  // A finished row is nobody's to claim, and neither is one that does not exist.
  await expect(claim("job:two", "lease-5")).resolves.toEqual({ status: "finished" });
  await expect(
    store.files.claimArtifactPreviewJob({
      clientInstanceId: fixture.clientInstanceId,
      jobId: "apj_missing",
      leaseOwnerId: "job:two",
      leaseToken: "lease-6",
      leaseMs: 60_000
    })
  ).resolves.toEqual({ status: "finished" });
}

async function expectPreviewJobRetryReplacementRaceContract(
  store: PlatformStores,
  rawSql: Sql
): Promise<void> {
  const fixture = await createPreviewFixture(store);
  const retryInput = {
    clientInstanceId: fixture.clientInstanceId,
    conversationId: fixture.conversation.id,
    sourceArtifactId: fixture.artifact.id,
    sourceChecksum: fixture.artifact.checksum,
    sourceMimeType: fixture.artifact.mimeType,
    renderer: "preview-renderer-retry-race",
    rendererVersion: "1.0.0",
    settingsHash: "settings-retry-race"
  };
  const job = await store.files.enqueueArtifactPreviewJob({
    ...retryInput,
    queuedAt: "2026-07-01T12:30:00.000Z"
  });
  const claimed = await claimPreviewRow(
    store,
    fixture.clientInstanceId,
    job.id,
    "preview-worker-initial",
    "lease-initial"
  );
  expect(claimed).toMatchObject({
    id: job.id,
    status: "processing",
    leaseToken: "lease-initial",
    attempts: 1
  });
  await store.files.failClaimedArtifactPreviewJob({
    clientInstanceId: fixture.clientInstanceId,
    jobId: job.id,
    leaseToken: "lease-initial",
    errorCode: "conversion_failed",
    errorMessage: "Renderer crashed",
    failedAt: "2026-07-01T12:30:02.000Z"
  });

  let replacement: ReturnType<TestPostgresStore["files"]["enqueueArtifactPreviewJob"]> | undefined;
  await rawSql.begin(async (tx) => {
    await tx`select id from artifact_preview_jobs where id = ${job.id} for update`;
    replacement = store.files.enqueueArtifactPreviewJob({
      ...retryInput,
      queuedAt: "2026-07-01T12:30:03.000Z",
      replaceTerminal: true
    });
    await waitForBlockedArtifactPreviewJobUpdate(rawSql);

    await tx`
      update artifact_preview_jobs
      set status = 'processing',
          attempts = attempts + 1,
          next_attempt_at = null,
          lease_owner_id = 'preview-worker-race',
          lease_token = 'lease-race',
          lease_expires_at = ${"2026-07-01T12:35:00.000Z"}::timestamptz,
          error_code = null,
          error_message = null,
          updated_at = ${"2026-07-01T12:30:04.000Z"}::timestamptz
      where id = ${job.id}
    `;
  });

  await expect(replacement!).resolves.toMatchObject({
    id: job.id,
    status: "processing",
    attempts: 2,
    leaseOwnerId: "preview-worker-race",
    leaseToken: "lease-race"
  });
  await expect(
    store.files.getArtifactPreviewJob({
      clientInstanceId: fixture.clientInstanceId,
      sourceArtifactId: fixture.artifact.id,
      renderer: retryInput.renderer,
      rendererVersion: retryInput.rendererVersion,
      settingsHash: retryInput.settingsHash
    })
  ).resolves.toMatchObject({
    id: job.id,
    status: "processing",
    attempts: 2,
    leaseOwnerId: "preview-worker-race",
    leaseToken: "lease-race"
  });
}

/** The claim by id of the executor job; the row when it was taken, nothing when it is held. */
async function claimPreviewRow(
  store: PreviewJobIdentityStore,
  clientInstanceId: ClientInstanceId,
  jobId: string,
  leaseOwnerId: string,
  leaseToken: string
) {
  const claim = await store.files.claimArtifactPreviewJob({
    clientInstanceId,
    jobId,
    leaseOwnerId,
    leaseToken,
    leaseMs: 5 * 60_000
  });
  return claim.status === "claimed" ? claim.row : undefined;
}

async function waitForBlockedArtifactPreviewJobUpdate(sql: Sql): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const blocked = await sql`
      select 1
      from pg_stat_activity
      where wait_event_type = 'Lock'
        and query ilike '%update%artifact_preview_jobs%'
      limit 1
    `;
    if (blocked.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for blocked artifact preview job update");
}

async function createPreviewFixture(store: PreviewJobIdentityStore): Promise<{
  clientInstanceId: ClientInstanceId;
  conversation: Conversation;
  file: ManagedFileRecord;
  artifact: ManagedArtifactRecord;
}> {
  const clientInstanceId = asClientInstanceId(`preview_store_${globalThis.crypto.randomUUID()}`);
  const user = await store.users.createUser({ clientInstanceId, displayLabel: "Preview user" });
  const personalWorkspace = await store.workspaces.ensurePersonalWorkspace({
    clientInstanceId,
    userId: user.id
  });
  const conversation = await store.conversations.createConversation({
    visibility: "workspace",
    clientInstanceId,
    collaborationWorkspaceId: personalWorkspace.id,
    createdByUserId: user.id,
    createdByExternalUserId: "user-1",
    title: "Artifact preview store parity",
    retainedUntil: "2030-01-01T00:00:00.000Z"
  });
  const file = await store.files.createManagedFile({
    clientInstanceId,
    ownerUserId: user.id,
    filename: "report.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    byteSize: 128,
    checksum: "sha256:report-docx",
    objectKey: "execution-workspaces/private/report.docx"
  });
  const artifact = await store.files.createManagedArtifact({
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
  PlatformStores,
  "files" | "conversations" | "workspaces" | "users"
>;

let databaseUrl: string;
beforeAll(async () => {
  databaseUrl = await fileTestDatabaseUrl();
});
