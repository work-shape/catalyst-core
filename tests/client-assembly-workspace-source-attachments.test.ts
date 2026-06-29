import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AppError,
  asClientInstanceId,
  createPlatformId,
  type Conversation,
  type ConversationAttachment,
  type DraftAttachment,
  type FileAttachmentFormat,
  type ManagedFileId
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  createClientInstanceApp,
  createExecutionWorkspaceSourceAttachmentHandler,
  detectWorkspaceSourceFileFormat,
  type ClientInstanceCapability,
  WORKSPACE_SOURCE_ACCEPTED_FILE_TYPES
} from "@vivd-catalyst/client-assembly";

describe("execution workspace source attachments", () => {
  it("accepts source artifact formats used by workspace skills", () => {
    expect(detectWorkspaceSourceFileFormat("analysis.xlsx", undefined)).toBe("xlsx");
    expect(
      detectWorkspaceSourceFileFormat(
        "deck",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      )
    ).toBe("pptx");
    expect(detectWorkspaceSourceFileFormat("source.csv", "text/csv; charset=utf-8")).toBe("csv");
    expect(detectWorkspaceSourceFileFormat("notes.rtf", undefined)).toBe("rtf");
    expect(detectWorkspaceSourceFileFormat("archive.zip", "application/zip")).toBeUndefined();
    expect(WORKSPACE_SOURCE_ACCEPTED_FILE_TYPES).toEqual(
      expect.arrayContaining([
        ".xlsx",
        ".pptx",
        ".doc",
        ".csv",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      ])
    );
  });

  it("stores uploaded source files as managed conversation refs without exposing object keys", async () => {
    const fixture = await createSourceAttachmentFixture();
    try {
      const bytes = new TextEncoder().encode("name,total\nAda,42\n");
      const attachment = await fixture.handler.uploadDraftAttachment({
        conversationId: fixture.conversation.id,
        ownerUserId: "user-1",
        filename: "analysis.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        bytes
      });

      expect(attachment).toMatchObject({
        conversationId: fixture.conversation.id,
        filename: "analysis.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        byteSize: bytes.byteLength,
        status: "ready",
        format: "xlsx",
        processingMetadata: {
          source: "execution_workspace_source"
        }
      });

      const manifest = fixture.handler.createAttachmentManifest([
        attachment as ConversationAttachment
      ]);
      expect(manifest.attachments).toHaveLength(1);
      expect(manifest.attachments[0]).toMatchObject({
        kind: "workspace_source",
        fileId: attachment.fileId,
        filename: "analysis.xlsx",
        readable: false,
        modelContext: {
          section: "Attached source artifacts",
          text: expect.stringContaining("workspace.import_files")
        }
      });
      expect(JSON.stringify(manifest)).not.toContain("execution-workspace-source-files");

      const source = await fixture.handler.readConversationFile({
        conversationId: fixture.conversation.id,
        fileId: attachment.fileId
      });
      expect(source).toMatchObject({
        fileId: attachment.fileId,
        filename: "analysis.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        byteSize: bytes.byteLength
      });
      expect(new TextDecoder().decode(source.bytes)).toBe("name,total\nAda,42\n");
    } finally {
      await fixture.cleanup();
    }
  });

  it("reports unsupported source types and source size limits before workspace import", async () => {
    const fixture = await createSourceAttachmentFixture({ maxFileBytes: 8 });
    try {
      await expect(
        fixture.handler.uploadDraftAttachment({
          conversationId: fixture.conversation.id,
          ownerUserId: "user-1",
          filename: "archive.zip",
          mimeType: "application/zip",
          bytes: new TextEncoder().encode("zip")
        })
      ).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        message: "This file type is not supported for workspace artifact uploads"
      });

      await expect(
        fixture.handler.uploadDraftAttachment({
          conversationId: fixture.conversation.id,
          ownerUserId: "user-1",
          filename: "large.csv",
          mimeType: "text/csv",
          bytes: new TextEncoder().encode("too-large")
        })
      ).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        message: "File exceeds the configured workspace source upload size limit"
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("advertises and uploads workspace source, PDF, and image formats through the chat attachment API", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivd-workspace-source-app-"));
    const app = await createClientInstanceApp({
      config: createWorkspaceAttachmentConfig(),
      env: {
        EXECUTION_WORKSPACE_OBJECT_ROOT: root
      },
      storeMode: "memory",
      capabilities: [createStrictUploadCapability()],
      tools: []
    });
    try {
      const config = await app.server.inject({
        method: "GET",
        url: "/api/config"
      });
      expect(config.statusCode).toBe(200);
      const accept = (config.json() as { features: { attachments: { accept: string } } })
        .features.attachments.accept;
      expect(accept).toContain(".xlsx");
      expect(accept).toContain("application/pdf");
      expect(accept).toContain("image/png");

      const created = await app.server.inject({
        method: "POST",
        url: "/api/conversations",
        payload: { title: "Dropzone source artifact test" }
      });
      expect(created.statusCode).toBe(200);
      const conversation = created.json() as { id: string };

      await expectUpload(app.server, conversation.id, {
        filename: "analysis.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        content: "spreadsheet",
        expectedFormat: "xlsx"
      });
      await expectUpload(app.server, conversation.id, {
        filename: "scan.pdf",
        contentType: "application/pdf",
        content: "%PDF-1.4",
        expectedFormat: "pdf"
      });
      await expectUpload(app.server, conversation.id, {
        filename: "photo.png",
        contentType: "image/png",
        content: "png",
        expectedFormat: "png"
      });

      const unsupported = await uploadFile(app.server, conversation.id, {
        filename: "archive.zip",
        contentType: "application/zip",
        content: "zip"
      });
      expect(unsupported.statusCode).toBe(400);
      expect(unsupported.json()).toMatchObject({
        error: {
          code: "BAD_REQUEST",
          message: "This file type is not supported for uploads in this chat"
        }
      });

      const oversized = await uploadFile(app.server, conversation.id, {
        filename: "large.pdf",
        contentType: "application/pdf",
        content: "too-large"
      });
      expect(oversized.statusCode).toBe(422);
      expect(oversized.json()).toMatchObject({
        error: {
          code: "VALIDATION_FAILED",
          message: "File exceeds the configured document preprocessing size limit"
        }
      });
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function createSourceAttachmentFixture(input: { maxFileBytes?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "vivd-workspace-source-"));
  const clientInstanceId = asClientInstanceId(`workspace_source_${globalThis.crypto.randomUUID()}`);
  const store = new InMemoryPlatformStore();
  const conversation = await store.createConversation({
    clientInstanceId,
    ownerUserId: "user-1",
    ownerExternalUserId: "user-1",
    title: "Workspace source upload test",
    retainedUntil: "2026-07-29T00:00:00.000Z"
  });
  return {
    clientInstanceId,
    conversation: conversation as Conversation,
    handler: createExecutionWorkspaceSourceAttachmentHandler({
      clientInstanceId,
      files: store,
      objectRootDirectory: root,
      markDeletedOnDelete: true,
      ...input
    }),
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    }
  };
}

function createWorkspaceAttachmentConfig() {
  return parseClientInstanceConfig({
    version: 1,
    clientInstance: {
      id: "workspace-source-local",
      displayName: "Workspace Source",
      environment: "development"
    },
    auth: {
      development: {
        enabled: true
      }
    },
    defaultAgentName: "test_agent",
    agents: [
      {
        name: "test_agent",
        displayName: "Test Agent",
        instructions: "Use configured tools only.",
        modelProviderId: "local"
      }
    ],
    modelProviders: [{ id: "local", type: "deterministic", model: "local" }],
    executionWorkspaces: {
      enabled: true
    },
    tools: []
  });
}

function createStrictUploadCapability(): ClientInstanceCapability {
  const maxFileBytes = 8;
  const attachmentsByConversation = new Map<string, DraftAttachment[]>();
  const files = new Map<string, { filename: string; mimeType?: string; bytes: Uint8Array }>();
  return {
    name: "strict-pdf-image-attachments",
    create(context) {
      return {
        attachments: [
          {
            name: "strict-pdf-image-attachments",
            maxFileBytes,
            acceptedFileTypes: ["application/pdf", "image/png"],
            acceptsFile(file) {
              return file.mimeType === "application/pdf" || file.mimeType === "image/png";
            },
            async listDraftAttachments(conversationId) {
              return attachmentsByConversation.get(conversationId) ?? [];
            },
            async uploadDraftAttachment(input) {
              if (input.bytes.byteLength > maxFileBytes) {
                throw new AppError(
                  "VALIDATION_FAILED",
                  "File exceeds the configured document preprocessing size limit"
                );
              }
              const fileId = createPlatformId<"ManagedFileId">("file");
              const attachment: DraftAttachment = {
                id: createPlatformId<"ConversationAttachmentId">("att"),
                clientInstanceId: context.clientInstanceId,
                conversationId: input.conversationId,
                fileId,
                filename: input.filename,
                ...(input.mimeType ? { mimeType: input.mimeType } : {}),
                byteSize: input.bytes.byteLength,
                checksum: "test-checksum",
                status: "ready",
                format: formatForMimeType(input.mimeType),
                artifactRefs: {},
                processingMetadata: {
                  source: "strict_test"
                },
                warnings: [],
                error: null,
                processingAttempts: 0,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
              };
              files.set(fileId, {
                filename: input.filename,
                ...(input.mimeType ? { mimeType: input.mimeType } : {}),
                bytes: input.bytes
              });
              const conversationAttachments =
                attachmentsByConversation.get(input.conversationId) ?? [];
              conversationAttachments.push(attachment);
              attachmentsByConversation.set(input.conversationId, conversationAttachments);
              return attachment;
            },
            async retryDraftAttachment() {
              throw new AppError("NOT_FOUND", "Attachment is not available");
            },
            async deleteDraftAttachment(input) {
              const attachments = attachmentsByConversation.get(input.conversationId) ?? [];
              const deleted = attachments.find((attachment) => attachment.id === input.attachmentId);
              if (!deleted) {
                throw new AppError("NOT_FOUND", "Attachment is not available");
              }
              attachmentsByConversation.set(
                input.conversationId,
                attachments.filter((attachment) => attachment.id !== input.attachmentId)
              );
              return {
                ...deleted,
                status: "deleted" as const,
                deletedAt: new Date().toISOString()
              };
            },
            async deleteConversationAttachments(input) {
              const attachments = attachmentsByConversation.get(input.conversationId) ?? [];
              attachmentsByConversation.set(input.conversationId, []);
              for (const attachment of attachments) {
                files.delete(attachment.fileId);
              }
              return {
                attachmentCount: attachments.length,
                fileObjectKeys: attachments.map((attachment) => attachment.fileId),
                artifactObjectKeys: []
              };
            },
            async readConversationFile(input) {
              const file = files.get(input.fileId);
              if (!file) {
                throw new AppError("NOT_FOUND", "Attachment is not available");
              }
              return {
                fileId: input.fileId as ManagedFileId,
                filename: file.filename,
                ...(file.mimeType ? { mimeType: file.mimeType } : {}),
                byteSize: file.bytes.byteLength,
                bytes: file.bytes
              };
            },
            blockingDraftAttachmentMessage() {
              return undefined;
            },
            createAttachmentManifest(attachments) {
              return {
                version: 1,
                attachments: attachments.map((attachment) => ({
                  kind: "document",
                  fileId: attachment.fileId,
                  attachmentId: attachment.id,
                  filename: attachment.filename,
                  ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
                  byteSize: attachment.byteSize,
                  status: attachment.status,
                  readable: true,
                  metadata: {
                    fileId: attachment.fileId,
                    filename: attachment.filename,
                    mimeType: attachment.mimeType ?? null,
                    byteSize: attachment.byteSize
                  }
                }))
              };
            },
            isInlineDisplayMimeType(mimeType) {
              return mimeType === "image/png";
            }
          }
        ]
      };
    }
  };
}

function formatForMimeType(mimeType: string | undefined): FileAttachmentFormat | undefined {
  if (mimeType === "application/pdf") {
    return "pdf";
  }
  if (mimeType === "image/png") {
    return "png";
  }
  return undefined;
}

async function expectUpload(
  server: Awaited<ReturnType<typeof createClientInstanceApp>>["server"],
  conversationId: string,
  input: {
    filename: string;
    contentType: string;
    content: string;
    expectedFormat: string;
  }
) {
  const response = await uploadFile(server, conversationId, input);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    attachment: {
      filename: input.filename,
      mimeType: input.contentType,
      status: "ready",
      format: input.expectedFormat
    }
  });
}

async function uploadFile(
  server: Awaited<ReturnType<typeof createClientInstanceApp>>["server"],
  conversationId: string,
  input: {
    filename: string;
    contentType: string;
    content: string;
  }
) {
  const multipart = createMultipartFilePayload({
    fieldName: "file",
    ...input
  });
  return server.inject({
    method: "POST",
    url: `/api/conversations/${conversationId}/draft-attachments`,
    headers: multipart.headers,
    payload: multipart.payload
  });
}

function createMultipartFilePayload(input: {
  fieldName: string;
  filename: string;
  contentType: string;
  content: string;
}) {
  const boundary = `----vivd-test-${globalThis.crypto.randomUUID()}`;
  const payload = Buffer.from(
    [
      `--${boundary}`,
      `Content-Disposition: form-data; name="${input.fieldName}"; filename="${input.filename}"`,
      `Content-Type: ${input.contentType}`,
      "",
      input.content,
      `--${boundary}--`,
      ""
    ].join("\r\n")
  );
  return {
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(payload.byteLength)
    },
    payload
  };
}
