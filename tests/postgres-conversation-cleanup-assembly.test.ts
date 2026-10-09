import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClientInstanceCapability } from "@vivd-catalyst/client-assembly";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  asConversationId,
  type ClientInstanceId,
  type ConversationId,
  type PlatformStores
} from "@vivd-catalyst/core";
import { createLocalWorkspaceObjectStorage } from "@vivd-catalyst/tool-execution";
import { jsonObject, required, text } from "./support/assertions";
import {
  createManagedObjectTestAttachmentCapability,
  createMultipartFilePayload
} from "./support/chat-server-attachment-harness";
import { usePostgresSuite } from "./support/postgres-suite";
import { createTestInstance } from "./support/test-instance";

describe("Postgres conversation cleanup through a client assembly", () => {
  const db = usePostgresSuite("cleanupassembly");

  // The handler sets the client assemblies produce. The demo client registers no capability, so
  // with execution workspaces on it gets the platform's source file handler alone, which then
  // marks the records itself. Musterbau adds document processing, whose handler removes
  // objects through `deleteConversationObjects` and marks the records for both.
  it.each([
    { assembly: "the platform handler alone", withCapability: false },
    { assembly: "the platform handler and a capability handler", withCapability: true }
  ])("leaves nothing pending after a cleanup through $assembly", async ({ withCapability }) => {
    const clientInstanceId = db.clientInstance(withCapability ? "capability" : "platform");
    const root = await mkdtemp(join(tmpdir(), "vivd-cleanup-assembly-"));
    const capability = createManagedObjectTestAttachmentCapability();
    const app = await createTestInstance({
      config: parseClientInstanceConfig({
        version: 1,
        clientInstance: {
          id: clientInstanceId,
          displayName: "Cleanup assembly",
          environment: "development"
        },
        auth: { development: { enabled: true } },
        modelProviders: [{ id: "local", type: "deterministic", model: "local" }],
        executionWorkspaces: { enabled: true },
        tools: []
      }),
      env: { DATABASE_URL: db.databaseUrl, EXECUTION_WORKSPACE_OBJECT_ROOT: root },
      capabilities: withCapability ? [acceptingOnly(capability.capability, ".note")] : [],
      tools: [],
      seedAssets: false
    });
    try {
      const created = await app.call("conversations.create", {
        payload: { title: "Cleanup through the assembly" }
      });
      expect(created.statusCode).toBe(200);
      const conversationId = asConversationId(text(jsonObject(created.json()).id));
      const uploads = [
        { filename: "source.csv", contentType: "text/csv" },
        ...(withCapability ? [{ filename: "letter.note", contentType: "text/plain" }] : [])
      ];
      for (const upload of uploads) {
        const payload = createMultipartFilePayload({
          fieldName: "file",
          ...upload,
          content: `bytes of ${upload.filename}`
        });
        const uploaded = await app.call("conversations.draft_attachments.upload", {
          params: { conversationId },
          headers: payload.headers,
          payload: payload.payload
        });
        expect(uploaded.statusCode).toBe(200);
      }
      const [files] = await db.sql<Array<{ count: number }>>`
        select count(*)::int as count from managed_files
        where client_instance_id = ${clientInstanceId} and status = 'available'
      `;
      expect(files?.count).toBe(uploads.length);
      // Alone, the platform handler marks every record deleted, so it has to remove every
      // object too: here a rendered document with the page image of its completed preview.
      const previewKeys = withCapability
        ? []
        : await createCompletedPreview({
            store: app.stores,
            root,
            clientInstanceId,
            conversationId
          });
      expect(await storedKeys(root)).toEqual(expect.arrayContaining(previewKeys));

      const deleted = await app.call("conversations.delete", { params: { conversationId } });
      expect(deleted.statusCode).toBe(200);

      const [deletion] = (
        await app.stores.audit.listAuditEvents({ clientInstanceId, limit: 50 })
      ).filter((event) => event.type === "conversation.deleted");
      expect(deletion).toMatchObject({
        subject: conversationId,
        metadata: expect.objectContaining({ cleanup: "complete", fileCount: uploads.length })
      });
      await expect(
        app.stores.files.listConversationsPendingObjectCleanup({ clientInstanceId, limit: 10 })
      ).resolves.toEqual([]);
      const [left] = await db.sql<Array<{ count: number }>>`
        select count(*)::int as count from managed_files
        where client_instance_id = ${clientInstanceId} and status <> 'deleted'
      `;
      expect(left?.count).toBe(0);
      expect(capability.objects.size).toBe(0);
      const [artifactsLeft] = await db.sql<Array<{ count: number }>>`
        select count(*)::int as count from managed_artifacts
        where client_instance_id = ${clientInstanceId} and status <> 'deleted'
      `;
      expect(artifactsLeft?.count).toBe(0);
      // The object store holds no key of the Conversation any more.
      expect(await storedKeys(root)).toEqual([]);
      // With nothing pending the personal workspace of the author can go.
      const [author] = await app.stores.users.listUsers({ clientInstanceId });
      await expect(
        app.stores.workspaces.deletePersonalWorkspaceForUser({
          clientInstanceId,
          userId: required(author).id
        })
      ).resolves.toMatchObject({ kind: "personal" });
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

/** The keys of every object under the root of a local object store. */
async function storedKeys(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

/**
 * A rendered document and the page image of its preview, as the preview worker leaves them:
 * both objects stored, the job completed, the manifest written. Returns the object keys.
 */
async function createCompletedPreview(input: {
  store: PlatformStores;
  root: string;
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
}): Promise<string[]> {
  const scope = { clientInstanceId: input.clientInstanceId };
  const objects = createLocalWorkspaceObjectStorage({ rootDirectory: input.root });
  const keyOf = (prefix: string, name: string) =>
    [prefix, input.clientInstanceId, input.conversationId, name].join("/");
  const bytes = new TextEncoder().encode("rendered");
  const sourceKey = keyOf("execution-workspaces", "report.docx");
  const pageKey = keyOf("artifact-previews", "page-1.png");
  await objects.putObject({ key: sourceKey, body: bytes });
  await objects.putObject({ key: pageKey, body: bytes });
  const source = await input.store.files.createManagedArtifact({
    ...scope,
    conversationId: input.conversationId,
    kind: "document.docx",
    objectKey: sourceKey,
    filename: "report.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    byteSize: bytes.byteLength,
    checksum: "sha256:report"
  });
  const job = await input.store.files.enqueueArtifactPreviewJob({
    ...scope,
    conversationId: input.conversationId,
    sourceArtifactId: source.id,
    sourceChecksum: source.checksum,
    sourceMimeType: source.mimeType
  });
  const now = new Date();
  await input.store.files.claimNextArtifactPreviewJob({
    ...scope,
    workerId: "preview-worker",
    leaseToken: "lease",
    now: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString()
  });
  const page = await input.store.files.createManagedArtifact({
    ...scope,
    conversationId: input.conversationId,
    kind: "document.preview_page_image",
    objectKey: pageKey,
    filename: "report-page-1.png",
    mimeType: "image/png",
    byteSize: bytes.byteLength,
    checksum: "sha256:page-1",
    metadata: { sourceArtifactId: source.id, previewRole: "page", pageNumber: 1 }
  });
  await input.store.files.completeClaimedArtifactPreviewJob({
    ...scope,
    jobId: job.id,
    leaseToken: "lease",
    format: "png",
    pages: [{ artifactId: page.id, mimeType: "image/png", filename: page.filename, pageNumber: 1 }],
    completedAt: now.toISOString()
  });
  return [pageKey, sourceKey].sort();
}

/** The capability with its attachment handler limited to files of one extension. */
function acceptingOnly(capability: ClientInstanceCapability, extension: string) {
  return {
    name: capability.name,
    async create(context: Parameters<ClientInstanceCapability["create"]>[0]) {
      const contribution = await capability.create(context);
      return {
        ...contribution,
        attachments: (contribution.attachments ?? []).map((handler) => ({
          ...handler,
          acceptsFile: (file: { filename: string }) => file.filename.endsWith(extension)
        }))
      };
    }
  } satisfies ClientInstanceCapability;
}
