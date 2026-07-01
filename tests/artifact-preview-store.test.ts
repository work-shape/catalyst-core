import { describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  type ClientInstanceId,
  type Conversation,
  type ManagedArtifactRecord,
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

async function createPreviewFixture(store: PreviewJobIdentityStore): Promise<{
  clientInstanceId: ClientInstanceId;
  conversation: Conversation;
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
  const artifact = await store.createManagedArtifact({
    clientInstanceId,
    conversationId: conversation.id,
    kind: "document.docx",
    objectKey: "execution-workspaces/private/report.docx",
    filename: "report.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    byteSize: 128,
    checksum: "sha256:report-docx"
  });
  return { clientInstanceId, conversation, artifact };
}

type PreviewJobIdentityStore = Pick<
  PlatformStore,
  | "createConversation"
  | "createManagedArtifact"
  | "enqueueArtifactPreviewJob"
  | "getArtifactPreviewJob"
>;
