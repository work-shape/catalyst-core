import { createTestInstance } from "./support/test-instance";
import { claimAttachmentsForStoredMessage } from "./support/test-store";
import { describe, expect, it, vi } from "vitest";

import {
  AppError,
  ATTACHMENT_PREVIEW_SOURCE_ARTIFACT_REF,
  NoopAuditRecorder,
  asClientInstanceId,
  asManagedArtifactId,
  asMessageId,
  type AgentRuntime,
  type AuthenticatedUser,
  type ClientInstanceId,
  type RuntimeCallContext
} from "@vivd-catalyst/core";

import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { ModelProvider } from "@vivd-catalyst/model-provider";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";

describe("artifact preview routes", () => {
  it("creates one hidden preview source for a sent Office attachment and reuses it", async () => {
    const { clientInstanceId, owner, server, store } = await createPreviewServer();
    try {
      const conversation = await store.createConversationForTesting({
        clientInstanceId,
        createdByUserId: owner.id,
        createdByExternalUserId: owner.externalUserId,
        title: "Attachment preview",
        retainedUntil: "2030-01-01T00:00:00.000Z"
      });
      const file = await store.files.createManagedFile({
        clientInstanceId,
        ownerUserId: owner.id,
        filename: "uploaded-deck.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        byteSize: 256,
        checksum: "sha256:uploaded-deck",
        objectKey: "documents/private/uploaded-deck.pptx"
      });
      const attachment = await store.files.createConversationAttachment({
        clientInstanceId,
        conversationId: conversation.id,
        fileId: file.id,
        filename: file.filename,
        mimeType: file.mimeType,
        byteSize: file.byteSize,
        checksum: file.checksum,
        status: "ready",
        format: "pptx"
      });
      await claimAttachmentsForStoredMessage(store, {
        clientInstanceId,
        conversationId: conversation.id,
        messageId: asMessageId("msg_attachment_preview"),
        claimedAt: "2026-08-03T10:00:00.000Z"
      });

      const ensure = vi.spyOn(store.files, "ensureManagedArtifact");
      const enqueue = vi.spyOn(store.files, "enqueueArtifactPreviewJob");
      const read = await server.call("conversations.attachments.get_preview", {
        params: { conversationId: conversation.id, attachmentId: attachment.id }
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({ status: "pending" });
      expect(ensure).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
      const [first, concurrent] = await Promise.all([
        server.call("conversations.attachments.start_preview", {
          params: { conversationId: conversation.id, attachmentId: attachment.id }
        }),
        server.call("conversations.attachments.start_preview", {
          params: { conversationId: conversation.id, attachmentId: attachment.id }
        })
      ]);
      expect(first.statusCode).toBe(200);
      expect(concurrent.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        status: "pending",
        artifactId: expect.any(String)
      });
      const previewSourceId = first.json().artifactId as string;
      expect(concurrent.json()).toMatchObject({ artifactId: previewSourceId });
      const previewSource = await store.files.getManagedArtifact({
        clientInstanceId,
        artifactId: asManagedArtifactId(previewSourceId)
      });
      expect(previewSource).toMatchObject({
        conversationId: conversation.id,
        sourceFileId: file.id,
        filename: file.filename,
        objectKey: file.objectKey,
        metadata: {
          source: "conversation_attachment",
          sourceAttachmentId: attachment.id
        }
      });
      const updatedAttachment = await store.files.getConversationAttachment({
        clientInstanceId,
        attachmentId: attachment.id
      });
      expect(updatedAttachment?.artifactRefs[ATTACHMENT_PREVIEW_SOURCE_ARTIFACT_REF]).toBe(
        previewSourceId
      );

      const second = await server.call("conversations.attachments.get_preview", {
        params: { conversationId: conversation.id, attachmentId: attachment.id }
      });
      expect(second.json()).toMatchObject({ artifactId: previewSourceId });
      await expect(
        store.files.listManagedArtifactsForFile({
          clientInstanceId,
          conversationId: conversation.id,
          fileId: file.id,
          kind: "preview.source_attachment"
        })
      ).resolves.toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("rejects attachment preview jobs for files with native preview paths", async () => {
    const { clientInstanceId, owner, server, store } = await createPreviewServer();
    try {
      const conversation = await store.createConversationForTesting({
        clientInstanceId,
        createdByUserId: owner.id,
        createdByExternalUserId: owner.externalUserId,
        title: "Native PDF preview",
        retainedUntil: "2030-01-01T00:00:00.000Z"
      });
      const file = await store.files.createManagedFile({
        clientInstanceId,
        ownerUserId: owner.id,
        filename: "uploaded.pdf",
        mimeType: "application/pdf",
        byteSize: 32,
        checksum: "sha256:uploaded-pdf",
        objectKey: "documents/private/uploaded.pdf"
      });
      const attachment = await store.files.createConversationAttachment({
        clientInstanceId,
        conversationId: conversation.id,
        fileId: file.id,
        filename: file.filename,
        mimeType: file.mimeType,
        byteSize: file.byteSize,
        checksum: file.checksum,
        status: "ready",
        format: "pdf"
      });
      await claimAttachmentsForStoredMessage(store, {
        clientInstanceId,
        conversationId: conversation.id,
        messageId: asMessageId("msg_native_pdf_preview"),
        claimedAt: "2026-08-03T10:00:00.000Z"
      });

      const response = await server.call("conversations.attachments.get_preview", {
        params: { conversationId: conversation.id, attachmentId: attachment.id }
      });

      expect(response.statusCode).toBe(422);
      await expect(
        store.files.listManagedArtifactsForFile({
          clientInstanceId,
          conversationId: conversation.id,
          fileId: file.id,
          kind: "preview.source_attachment"
        })
      ).resolves.toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("serves artifact preview state without exposing renderer or storage internals", async () => {
    const { clientInstanceId, owner, server, store } = await createPreviewServer();
    try {
      const conversation = await store.createConversationForTesting({
        clientInstanceId,
        createdByUserId: owner.id,
        createdByExternalUserId: owner.externalUserId,
        title: "Artifact preview",
        retainedUntil: "2030-01-01T00:00:00.000Z"
      });
      const otherConversation = await store.createConversationForTesting({
        clientInstanceId,
        createdByUserId: owner.id,
        createdByExternalUserId: owner.externalUserId,
        title: "Other preview conversation",
        retainedUntil: "2030-01-01T00:00:00.000Z"
      });
      const previewPage = await store.files.createManagedArtifact({
        clientInstanceId,
        conversationId: conversation.id,
        kind: "document.preview_page_image",
        objectKey: "artifact-previews/private/page-1.png",
        filename: "page-1.png",
        mimeType: "image/png",
        byteSize: 10,
        checksum: "sha256:page-1"
      });
      const readyArtifact = await store.files.createManagedArtifact({
        clientInstanceId,
        conversationId: conversation.id,
        kind: "document.docx",
        objectKey: "execution-workspaces/private/report.docx",
        filename: "report.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        byteSize: 128,
        checksum: "sha256:ready-docx"
      });
      await store.files.writeArtifactPreviewManifest({
        clientInstanceId,
        conversationId: conversation.id,
        sourceArtifactId: readyArtifact.id,
        status: "ready",
        type: "image_pages",
        format: "png",
        pageCount: 2,
        pages: [
          {
            artifactId: previewPage.id,
            mimeType: "image/png",
            filename: "page-1.png",
            pageNumber: 1,
            width: 1200,
            height: 1600
          }
        ]
      });
      const emptyReadyArtifact = await store.files.createManagedArtifact({
        clientInstanceId,
        conversationId: conversation.id,
        kind: "document.docx",
        objectKey: "execution-workspaces/private/empty-ready.docx",
        filename: "empty-ready.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        byteSize: 64,
        checksum: "sha256:empty-ready-docx"
      });
      await store.files.writeArtifactPreviewManifest({
        clientInstanceId,
        conversationId: conversation.id,
        sourceArtifactId: emptyReadyArtifact.id,
        status: "ready",
        type: "image_pages",
        format: "png",
        pageCount: 1,
        pages: []
      });
      const pendingArtifact = await store.files.createManagedArtifact({
        clientInstanceId,
        conversationId: conversation.id,
        kind: "presentation.pptx",
        objectKey: "execution-workspaces/private/deck.pptx",
        filename: "deck.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        byteSize: 256,
        checksum: "sha256:pending-pptx"
      });
      await store.files.enqueueArtifactPreviewJob({
        clientInstanceId,
        conversationId: conversation.id,
        sourceArtifactId: pendingArtifact.id,
        sourceChecksum: pendingArtifact.checksum,
        sourceMimeType: pendingArtifact.mimeType,
        queuedAt: "2026-07-01T12:00:00.000Z"
      });
      const failedArtifact = await store.files.createManagedArtifact({
        clientInstanceId,
        conversationId: conversation.id,
        kind: "document.doc",
        objectKey: "execution-workspaces/private/failed.doc",
        filename: "failed.doc",
        mimeType: "application/msword",
        byteSize: 64,
        checksum: "sha256:failed-doc"
      });
      await store.files.writeArtifactPreviewManifest({
        clientInstanceId,
        conversationId: conversation.id,
        sourceArtifactId: failedArtifact.id,
        status: "failed",
        errorCode: "conversion_failed"
      });
      const unsupportedManifestArtifact = await store.files.createManagedArtifact({
        clientInstanceId,
        conversationId: conversation.id,
        kind: "presentation.ppt",
        objectKey: "execution-workspaces/private/legacy.ppt",
        filename: "legacy.ppt",
        mimeType: "application/vnd.ms-powerpoint",
        byteSize: 64,
        checksum: "sha256:unsupported-ppt"
      });
      await store.files.writeArtifactPreviewManifest({
        clientInstanceId,
        conversationId: conversation.id,
        sourceArtifactId: unsupportedManifestArtifact.id,
        status: "unsupported",
        errorCode: "unsupported_type"
      });
      const unsupportedWithoutCodeArtifact = await store.files.createManagedArtifact({
        clientInstanceId,
        conversationId: conversation.id,
        kind: "presentation.ppt",
        objectKey: "execution-workspaces/private/legacy-without-code.ppt",
        filename: "legacy-without-code.ppt",
        mimeType: "application/vnd.ms-powerpoint",
        byteSize: 64,
        checksum: "sha256:unsupported-without-code"
      });
      await store.files.writeArtifactPreviewManifest({
        clientInstanceId,
        conversationId: conversation.id,
        sourceArtifactId: unsupportedWithoutCodeArtifact.id,
        status: "unsupported"
      });
      const spreadsheetArtifact = await store.files.createManagedArtifact({
        clientInstanceId,
        conversationId: conversation.id,
        kind: "spreadsheet.xlsx",
        objectKey: "execution-workspaces/private/sheet.xlsx",
        filename: "sheet.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        byteSize: 64,
        checksum: "sha256:sheet"
      });
      const embeddedArtifact = await store.files.createManagedArtifact({
        clientInstanceId,
        conversationId: conversation.id,
        kind: "presentation.pptx",
        objectKey: "execution-workspaces/private/embedded.pptx",
        filename: "embedded.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        byteSize: 64,
        checksum: "sha256:embedded-pptx",
        metadata: {
          preview: {
            type: "image_pages",
            format: "png",
            pages: [
              {
                artifactId: previewPage.id,
                kind: "document.preview_page_image",
                mimeType: "image/png",
                filename: "embedded-page.png",
                pageNumber: 1,
                width: 1024,
                height: 768,
                objectKey: "must-not-leak",
                workspacePath: "scratch/preview.png",
                commandId: "wcmd_secret"
              }
            ]
          }
        }
      });
      const embeddedGifWithoutFormatArtifact = await store.files.createManagedArtifact({
        clientInstanceId,
        conversationId: conversation.id,
        kind: "presentation.pptx",
        objectKey: "execution-workspaces/private/embedded-gif.pptx",
        filename: "embedded-gif.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        byteSize: 64,
        checksum: "sha256:embedded-gif-pptx",
        metadata: {
          preview: {
            type: "image_pages",
            pages: [{ artifactId: previewPage.id, mimeType: "image/gif", slideNumber: 1 }]
          }
        }
      });

      const ready = await server.call("conversations.artifacts.get_preview", {
        params: { conversationId: conversation.id, artifactId: readyArtifact.id }
      });
      expect(ready.statusCode).toBe(200);
      expect(ready.headers["cache-control"]).toBe("private, no-store, max-age=0");
      expect(ready.json()).toEqual({
        status: "ready",
        artifactId: readyArtifact.id,
        type: "image_pages",
        format: "png",
        pageCount: 2,
        truncated: true,
        pages: [
          {
            artifactId: previewPage.id,
            mimeType: "image/png",
            filename: "page-1.png",
            pageNumber: 1,
            width: 1200,
            height: 1600
          }
        ]
      });
      expect(ready.payload).not.toContain("artifact-previews/private");
      expect(ready.payload).not.toContain("renderer");

      const emptyReadyRetry = await server.call("conversations.artifacts.retry_preview", {
        params: { conversationId: conversation.id, artifactId: emptyReadyArtifact.id }
      });
      expect(emptyReadyRetry.statusCode).toBe(200);
      expect(emptyReadyRetry.json()).toMatchObject({
        status: "pending",
        artifactId: emptyReadyArtifact.id,
        queuedAt: expect.any(String)
      });
      await expect(
        store.files.getArtifactPreviewJob({
          clientInstanceId,
          sourceArtifactId: emptyReadyArtifact.id
        })
      ).resolves.toMatchObject({ status: "pending" });

      const pending = await server.call("conversations.artifacts.start_preview", {
        params: { conversationId: conversation.id, artifactId: pendingArtifact.id }
      });
      expect(pending.statusCode).toBe(200);
      expect(pending.headers["cache-control"]).toBe("private, no-store, max-age=0");
      expect(pending.json()).toEqual({
        status: "pending",
        artifactId: pendingArtifact.id,
        queuedAt: "2026-07-01T12:00:00.000Z"
      });
      await expect(
        server.call("conversations.artifacts.get_preview", {
          params: { conversationId: conversation.id, artifactId: failedArtifact.id }
        })
      ).resolves.toMatchObject({
        statusCode: 200,
        payload: JSON.stringify({
          status: "failed",
          artifactId: failedArtifact.id,
          errorCode: "conversion_failed",
          retryable: true
        })
      });
      const failedRetry = await server.call("conversations.artifacts.retry_preview", {
        params: { conversationId: conversation.id, artifactId: failedArtifact.id }
      });
      expect(failedRetry.statusCode).toBe(200);
      const failedRetryJson = failedRetry.json() as { queuedAt: string };
      expect(failedRetry.json()).toMatchObject({
        status: "pending",
        artifactId: failedArtifact.id,
        queuedAt: expect.any(String)
      });
      expect(failedRetry.payload).not.toContain("artifact-previews/private");
      expect(failedRetry.payload).not.toContain("renderer");
      const retriedJob = await store.files.getArtifactPreviewJob({
        clientInstanceId,
        sourceArtifactId: failedArtifact.id
      });
      expect(retriedJob).toMatchObject({
        status: "pending"
      });
      expect(retriedJob?.errorCode).toBeUndefined();
      await expect(
        server.call("conversations.artifacts.retry_preview", {
          params: { conversationId: conversation.id, artifactId: failedArtifact.id }
        })
      ).resolves.toMatchObject({
        statusCode: 200,
        payload: failedRetry.payload
      });
      await expect(
        store.files.getArtifactPreviewJob({
          clientInstanceId,
          sourceArtifactId: failedArtifact.id
        })
      ).resolves.toMatchObject({
        id: retriedJob?.id
      });
      await expect(
        server.call("conversations.artifacts.get_preview", {
          params: { conversationId: conversation.id, artifactId: failedArtifact.id }
        })
      ).resolves.toMatchObject({
        statusCode: 200,
        payload: JSON.stringify({
          status: "pending",
          artifactId: failedArtifact.id,
          queuedAt: failedRetryJson.queuedAt
        })
      });
      await expect(
        server.call("conversations.artifacts.get_preview", {
          params: { conversationId: conversation.id, artifactId: unsupportedManifestArtifact.id }
        })
      ).resolves.toMatchObject({
        statusCode: 200,
        payload: JSON.stringify({
          status: "unsupported",
          artifactId: unsupportedManifestArtifact.id,
          errorCode: "unsupported_type"
        })
      });
      await expect(
        server.call("conversations.artifacts.retry_preview", {
          params: { conversationId: conversation.id, artifactId: unsupportedManifestArtifact.id }
        })
      ).resolves.toMatchObject({
        statusCode: 200,
        payload: JSON.stringify({
          status: "unsupported",
          artifactId: unsupportedManifestArtifact.id,
          errorCode: "unsupported_type"
        })
      });
      await expect(
        server.call("conversations.artifacts.retry_preview", {
          params: { conversationId: conversation.id, artifactId: unsupportedWithoutCodeArtifact.id }
        })
      ).resolves.toMatchObject({
        statusCode: 200,
        payload: JSON.stringify({
          status: "unsupported",
          artifactId: unsupportedWithoutCodeArtifact.id,
          errorCode: "unsupported_type"
        })
      });
      const nonRetryableArtifact = await store.files.createManagedArtifact({
        clientInstanceId,
        conversationId: conversation.id,
        kind: "document.docx",
        objectKey: "execution-workspaces/private/large.docx",
        filename: "large.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        byteSize: 1024,
        checksum: "sha256:large-docx"
      });
      await store.files.writeArtifactPreviewManifest({
        clientInstanceId,
        conversationId: conversation.id,
        sourceArtifactId: nonRetryableArtifact.id,
        status: "failed",
        errorCode: "source_too_large"
      });
      const increasedLimitRetry = await server.call("conversations.artifacts.retry_preview", {
        params: { conversationId: conversation.id, artifactId: nonRetryableArtifact.id }
      });
      expect(increasedLimitRetry.statusCode).toBe(200);
      expect(increasedLimitRetry.json()).toMatchObject({
        status: "pending",
        artifactId: nonRetryableArtifact.id
      });
      await expect(
        store.files.getArtifactPreviewJob({
          clientInstanceId,
          sourceArtifactId: nonRetryableArtifact.id
        })
      ).resolves.toMatchObject({ status: "pending" });
      const oldRendererFailureArtifact = await store.files.createManagedArtifact({
        clientInstanceId,
        conversationId: conversation.id,
        kind: "presentation.pptx",
        objectKey: "execution-workspaces/private/old-runtime.pptx",
        filename: "old-runtime.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        byteSize: 1024,
        checksum: "sha256:old-runtime-pptx"
      });
      await store.files.writeArtifactPreviewManifest({
        clientInstanceId,
        conversationId: conversation.id,
        sourceArtifactId: oldRendererFailureArtifact.id,
        rendererVersion: "previous-preview-runtime",
        status: "failed",
        errorCode: "conversion_failed"
      });
      const oldRendererPreview = await server.call("conversations.artifacts.start_preview", {
        params: { conversationId: conversation.id, artifactId: oldRendererFailureArtifact.id }
      });
      expect(oldRendererPreview.statusCode).toBe(200);
      expect(oldRendererPreview.json()).toMatchObject({
        status: "pending",
        artifactId: oldRendererFailureArtifact.id,
        queuedAt: expect.any(String)
      });
      const spreadsheetPending = await server.call("conversations.artifacts.start_preview", {
        params: { conversationId: conversation.id, artifactId: spreadsheetArtifact.id }
      });
      expect(spreadsheetPending.statusCode).toBe(200);
      expect(spreadsheetPending.json()).toMatchObject({
        status: "pending",
        artifactId: spreadsheetArtifact.id,
        queuedAt: expect.any(String)
      });

      const embedded = await server.call("conversations.artifacts.get_preview", {
        params: { conversationId: conversation.id, artifactId: embeddedArtifact.id }
      });
      expect(embedded.statusCode).toBe(200);
      expect(embedded.json()).toEqual({
        status: "ready",
        artifactId: embeddedArtifact.id,
        type: "image_pages",
        format: "png",
        pages: [
          {
            artifactId: previewPage.id,
            mimeType: "image/png",
            filename: "embedded-page.png",
            pageNumber: 1,
            width: 1024,
            height: 768
          }
        ]
      });
      expect(embedded.payload).not.toContain("objectKey");
      expect(embedded.payload).not.toContain("workspacePath");
      expect(embedded.payload).not.toContain("wcmd_secret");
      expect(embedded.payload).not.toContain("document.preview_page_image");

      const embeddedGif = await server.call("conversations.artifacts.start_preview", {
        params: { conversationId: conversation.id, artifactId: embeddedGifWithoutFormatArtifact.id }
      });
      expect(embeddedGif.statusCode).toBe(200);
      expect(embeddedGif.json()).toMatchObject({
        status: "pending",
        artifactId: embeddedGifWithoutFormatArtifact.id,
        queuedAt: expect.any(String)
      });

      const wrongConversation = await server.call("conversations.artifacts.get_preview", {
        params: { conversationId: otherConversation.id, artifactId: readyArtifact.id }
      });
      expect(wrongConversation.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("requires conversation read scope for artifact previews", async () => {
    const clientInstanceId = asClientInstanceId("demo-local");
    const owner: AuthenticatedUser = {
      ...createTestUser("user-1", clientInstanceId),
      scopes: ["conversation:write"]
    };
    const { server, store } = await createPreviewServer({ clientInstanceId, owner });
    try {
      const conversation = await store.createConversationForTesting({
        clientInstanceId,
        createdByUserId: owner.id,
        createdByExternalUserId: owner.externalUserId,
        title: "Artifact preview forbidden",
        retainedUntil: "2030-01-01T00:00:00.000Z"
      });
      const artifact = await store.files.createManagedArtifact({
        clientInstanceId,
        conversationId: conversation.id,
        kind: "document.docx",
        objectKey: "execution-workspaces/private/report.docx",
        filename: "report.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        byteSize: 128,
        checksum: "sha256:forbidden-docx"
      });

      const preview = await server.call("conversations.artifacts.get_preview", {
        params: { conversationId: conversation.id, artifactId: artifact.id }
      });

      expect(preview.statusCode).toBe(403);
      const retry = await server.call("conversations.artifacts.retry_preview", {
        params: { conversationId: conversation.id, artifactId: artifact.id }
      });
      expect(retry.statusCode).toBe(403);
    } finally {
      await server.close();
    }
  });
});

async function createPreviewServer(
  input: {
    clientInstanceId?: ClientInstanceId;
    owner?: AuthenticatedUser;
  } = {}
) {
  const clientInstanceId = input.clientInstanceId ?? asClientInstanceId("demo-local");
  const store = (await createTestInstance()).stores;
  const config = createPreviewConfig(clientInstanceId);
  const owner = input.owner ?? createTestUser("user-1", clientInstanceId);
  const usageGovernance = new ModelUsageGovernance({
    store: store.usage,
    budget: config.usage.budget,
    safeguards: config.usage.safeguards,
    costs: config.usage.costs
  });
  const server = await createTestInstance({
    server: {
      config,
      clientInstanceId,
      authAdapter: {
        credentialMode: "ambient",
        id: "test-auth",
        async authenticate() {
          return owner;
        }
      },
      stores: store,
      usageGovernance,
      auditRecorder: new NoopAuditRecorder(),
      agentRuntime: createMissingRuntime(),
      modelProvider: createUnusedModelProvider()
    }
  });
  return { clientInstanceId, owner, server, store };
}

function createPreviewConfig(clientInstanceId: ClientInstanceId) {
  return parseClientInstanceConfig({
    version: 1,
    clientInstance: {
      id: clientInstanceId,
      displayName: "Preview Test",
      environment: "development"
    },
    auth: {
      development: {
        enabled: true
      }
    },
    modelProviders: [{ id: "local", type: "deterministic", model: "local" }],
    usage: {
      budget: {},
      safeguards: {}
    },
    tools: []
  });
}

function createTestUser(id: string, clientInstanceId: ClientInstanceId): AuthenticatedUser {
  return {
    id,
    externalUserId: id,
    displayLabel: id === "user-1" ? "User" : "Other user",
    roles: ["user", "admin", "superadmin"],
    permissionRefs: ["demo-tools"],
    clientInstanceId,
    authSource: "test",
    scopes: ["*"]
  };
}

function createMissingRuntime(): AgentRuntime {
  return {
    async start() {
      throw new AppError("NOT_FOUND", "Agent runtime has no local run state");
    },
    async *observe() {
      throw new AppError("NOT_FOUND", "Agent runtime has no local run state");
    },
    async getStatus() {
      throw new AppError("NOT_FOUND", "Agent runtime has no local run state");
    },
    async resume() {
      throw new AppError("NOT_FOUND", "Agent runtime has no local run state");
    },
    async cancel() {
      throw new AppError("NOT_FOUND", "Agent runtime has no local run state");
    }
  };
}

function createUnusedModelProvider(): ModelProvider {
  return {
    id: "unused",
    async complete(_request, _context: RuntimeCallContext) {
      throw new AppError("INTERNAL", "Model provider should not be used by artifact preview tests");
    }
  };
}
