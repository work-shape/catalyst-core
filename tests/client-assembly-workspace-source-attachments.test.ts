import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
      expect(manifest.attachments[0]?.modelContext?.text).toContain(
        `"path": "inputs/${attachment.fileId}.xlsx"`
      );
      expect(manifest.attachments[0]?.modelContext?.text).toContain(
        "use the returned importedFiles[].path exactly"
      );
      expect(manifest.attachments[0]?.modelContext?.text).toContain(
        "do not guess a shorter filename"
      );
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

  it("deletes promoted workspace artifact bytes during conversation cleanup", async () => {
    const fixture = await createSourceAttachmentFixture();
    try {
      const artifactObjectKey = [
        "execution-workspaces",
        fixture.clientInstanceId,
        fixture.conversation.id,
        "ews_cleanup",
        "wcmd_cleanup",
        "final.csv"
      ].join("/");
      const artifactPathParts = artifactObjectKey.split("/");
      const artifactPath = join(fixture.root, ...artifactPathParts);
      await mkdir(join(fixture.root, ...artifactPathParts.slice(0, -1)), { recursive: true });
      await writeFile(artifactPath, "final,total\nAda,42\n", "utf8");

      const artifact = await fixture.store.createManagedArtifact({
        clientInstanceId: fixture.clientInstanceId,
        conversationId: fixture.conversation.id,
        kind: "text/csv",
        objectKey: artifactObjectKey,
        filename: "final.csv",
        mimeType: "text/csv",
        byteSize: 19,
        checksum: "sha256:final",
        metadata: {
          source: "execution_workspace",
          workspacePath: "scratch/final.csv"
        }
      });

      const deletion = await fixture.handler.deleteConversationAttachments({
        conversationId: fixture.conversation.id,
        deletedAt: "2026-07-01T00:00:00.000Z"
      });

      expect(deletion.artifactObjectKeys).toContain(artifactObjectKey);
      await expect(access(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fixture.store.getManagedArtifact({
          clientInstanceId: fixture.clientInstanceId,
          artifactId: artifact.id
        })
      ).resolves.toBeUndefined();
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

  it("deletes workspace bytes before broad cleanup handlers mark records deleted", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivd-workspace-cleanup-app-"));
    const expectedDeletedObjectKeys: string[] = [];
    const app = await createClientInstanceApp({
      config: createWorkspaceAttachmentConfig(),
      env: {
        EXECUTION_WORKSPACE_OBJECT_ROOT: root
      },
      storeMode: "memory",
      capabilities: [
        createWorkspaceArtifactSeedingCapability(root),
        createBroadCleanupMarkerCapability(root, expectedDeletedObjectKeys)
      ],
      tools: []
    });
    try {
      const created = await app.server.inject({
        method: "POST",
        url: "/api/conversations",
        payload: { title: "Workspace cleanup ordering test" }
      });
      expect(created.statusCode).toBe(200);
      const conversation = created.json() as { id: string };

      const sourceContent = "source,total\nAda,42\n";
      const uploadedSource = await uploadFile(app.server, conversation.id, {
        filename: "source.csv",
        contentType: "text/csv",
        content: sourceContent
      });
      expect(uploadedSource.statusCode).toBe(200);
      const sourceObjectKey = createExpectedSourceObjectKey({
        clientInstanceId: "workspace-source-local",
        conversationId: conversation.id,
        checksum: checksumString(sourceContent),
        filename: "source.csv"
      });

      const artifactContent = "name,total\nAda,42\n";
      const uploadedArtifact = await uploadFile(app.server, conversation.id, {
        filename: "source.seed",
        contentType: "text/x-workspace-artifact-test",
        content: artifactContent
      });
      expect(uploadedArtifact.statusCode).toBe(200);
      const artifactObjectKey = createExpectedSeedArtifactObjectKey({
        clientInstanceId: "workspace-source-local",
        conversationId: conversation.id,
        checksum: checksumString(artifactContent),
        filename: "final.csv"
      });
      expectedDeletedObjectKeys.push(sourceObjectKey, artifactObjectKey);

      await expect(access(objectPath(root, sourceObjectKey))).resolves.toBeUndefined();
      await expect(access(objectPath(root, artifactObjectKey))).resolves.toBeUndefined();

      const deleted = await app.server.inject({
        method: "DELETE",
        url: `/api/conversations/${conversation.id}`
      });
      expect(deleted.statusCode).toBe(200);
      await expect(access(objectPath(root, sourceObjectKey))).rejects.toMatchObject({
        code: "ENOENT"
      });
      await expect(access(objectPath(root, artifactObjectKey))).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serves promoted workspace artifacts before broad managed-object readers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivd-workspace-source-app-"));
    const app = await createClientInstanceApp({
      config: createWorkspaceAttachmentConfig(),
      env: {
        EXECUTION_WORKSPACE_OBJECT_ROOT: root
      },
      storeMode: "memory",
      capabilities: [
        createWorkspaceArtifactSeedingCapability(root),
        createBroadManagedObjectReaderCapability()
      ],
      tools: []
    });
    try {
      const created = await app.server.inject({
        method: "POST",
        url: "/api/conversations",
        payload: { title: "Workspace artifact dispatch test" }
      });
      expect(created.statusCode).toBe(200);
      const conversation = created.json() as { id: string };

      const uploaded = await uploadFile(app.server, conversation.id, {
        filename: "source.seed",
        contentType: "text/x-workspace-artifact-test",
        content: "name,total\nAda,42\n"
      });
      expect(uploaded.statusCode).toBe(200);
      const artifactId = (uploaded.json() as { attachment: { artifactRefs: { final?: string } } })
        .attachment.artifactRefs.final;
      expect(artifactId).toEqual(expect.any(String));

      const downloaded = await app.server.inject({
        method: "GET",
        url: `/api/conversations/${conversation.id}/artifacts/${artifactId}/content`
      });
      expect(downloaded.statusCode).toBe(200);
      expect(downloaded.payload).toBe("name,total\nAda,42\n");
      expect(downloaded.headers["content-type"]).toContain("text/csv");
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serves managed artifact-preview image artifacts before broad managed-object readers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivd-workspace-preview-app-"));
    const app = await createClientInstanceApp({
      config: createWorkspaceAttachmentConfig(),
      env: {
        EXECUTION_WORKSPACE_OBJECT_ROOT: root
      },
      storeMode: "memory",
      capabilities: [
        createWorkspacePreviewArtifactSeedingCapability(root),
        createBroadManagedObjectReaderCapability()
      ],
      tools: []
    });
    try {
      const created = await app.server.inject({
        method: "POST",
        url: "/api/conversations",
        payload: { title: "Workspace preview artifact dispatch test" }
      });
      expect(created.statusCode).toBe(200);
      const conversation = created.json() as { id: string };

      const uploaded = await uploadFile(app.server, conversation.id, {
        filename: "deck.preview-seed",
        contentType: "text/x-workspace-preview-test",
        content: "PNG-preview"
      });
      expect(uploaded.statusCode).toBe(200);
      const previewArtifactId = (uploaded.json() as { attachment: { artifactRefs: { preview?: string } } })
        .attachment.artifactRefs.preview;
      expect(previewArtifactId).toEqual(expect.any(String));

      const downloaded = await app.server.inject({
        method: "GET",
        url: `/api/conversations/${conversation.id}/artifacts/${previewArtifactId}/content`
      });
      expect(downloaded.statusCode).toBe(200);
      expect(downloaded.payload).toBe("PNG-preview");
      expect(downloaded.headers["content-type"]).toContain("image/png");
      expect(downloaded.headers["content-disposition"]).toContain("deck-slide-1.png");
      expect(JSON.stringify(downloaded.headers)).not.toContain("artifact-previews");
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
    root,
    clientInstanceId,
    conversation: conversation as Conversation,
    store,
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

function createWorkspaceAttachmentConfig(input: { toolNames?: string[] } = {}) {
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
        modelProviderId: "local",
        toolNames: input.toolNames ?? []
      }
    ],
    modelProviders: [{ id: "local", type: "deterministic", model: "local" }],
    executionWorkspaces: {
      enabled: true
    },
    tools: (input.toolNames ?? []).map((name) => ({ name, enabled: true }))
  });
}

function createBroadManagedObjectReaderCapability(): ClientInstanceCapability {
  return {
    name: "broad-managed-object-reader",
    create() {
      return {
        managedObjects: [
          {
            name: "broad-managed-object-reader",
            async readArtifact() {
              throw new AppError(
                "INTERNAL",
                "Broad managed-object reader must not handle workspace artifacts"
              );
            },
            async readFile() {
              throw new AppError("NOT_FOUND", "No files are owned by this test reader");
            }
          }
        ]
      };
    }
  };
}

function createBroadCleanupMarkerCapability(
  root: string,
  expectedDeletedObjectKeys: readonly string[]
): ClientInstanceCapability {
  return {
    name: "broad-cleanup-marker",
    create(context) {
      return {
        attachments: [
          {
            name: "broad-cleanup-marker",
            maxFileBytes: 1,
            acceptedFileTypes: [],
            acceptsFile() {
              return false;
            },
            async listDraftAttachments() {
              return [];
            },
            async uploadDraftAttachment() {
              throw new AppError("NOT_FOUND", "Attachment is not available");
            },
            async retryDraftAttachment() {
              throw new AppError("NOT_FOUND", "Attachment is not available");
            },
            async deleteDraftAttachment() {
              throw new AppError("NOT_FOUND", "Attachment is not available");
            },
            async deleteConversationAttachments(input) {
              for (const objectKey of expectedDeletedObjectKeys) {
                await expectObjectMissing(root, objectKey);
              }
              return context.files.markConversationManagedObjectsDeleted({
                clientInstanceId: context.clientInstanceId,
                conversationId: input.conversationId,
                deletedAt: input.deletedAt
              });
            },
            async readConversationFile() {
              throw new AppError("NOT_FOUND", "Attachment is not available");
            },
            blockingDraftAttachmentMessage() {
              return undefined;
            },
            createAttachmentManifest() {
              return {
                version: 1,
                attachments: []
              };
            },
            isInlineDisplayMimeType() {
              return false;
            }
          }
        ]
      };
    }
  };
}

function createWorkspaceArtifactSeedingCapability(root: string): ClientInstanceCapability {
  return {
    name: "workspace-artifact-seeding",
    create(context) {
      const managedObjects = context.managedObjectAccess.createAccess({
        byteStore: createWorkspaceArtifactSeedByteStore(root),
        keyFactory: createWorkspaceArtifactSeedKeyFactory()
      });
      return {
        attachments: [
          {
            name: "workspace-artifact-seeding",
            maxFileBytes: 1024,
            acceptedFileTypes: ["text/x-workspace-artifact-test"],
            acceptsFile(file) {
              return file.mimeType === "text/x-workspace-artifact-test";
            },
            async listDraftAttachments(conversationId) {
              return context.files.listDraftAttachments({
                clientInstanceId: context.clientInstanceId,
                conversationId
              });
            },
            async uploadDraftAttachment(input) {
              const file = await managedObjects.createFile({
                ownerUserId: input.ownerUserId,
                conversationId: input.conversationId,
                filename: input.filename,
                mimeType: "text/x-workspace-artifact-test",
                bytes: input.bytes
              });
              const artifact = await managedObjects.createArtifact({
                conversationId: input.conversationId,
                sourceFileId: file.id,
                kind: "text/csv",
                filename: "final.csv",
                mimeType: "text/csv",
                bytes: input.bytes,
                metadata: {
                  source: "execution_workspace",
                  workspacePath: "scratch/final.csv"
                }
              });
              return context.files.createConversationAttachment({
                clientInstanceId: context.clientInstanceId,
                conversationId: input.conversationId,
                fileId: file.id,
                filename: input.filename,
                mimeType: "text/x-workspace-artifact-test",
                byteSize: input.bytes.byteLength,
                checksum: file.checksum,
                status: "ready",
                artifactRefs: {
                  final: artifact.id
                },
                processingMetadata: {
                  source: "workspace_artifact_seeding"
                },
                warnings: []
              }) as Promise<DraftAttachment>;
            },
            async retryDraftAttachment() {
              throw new AppError("NOT_FOUND", "Attachment is not available");
            },
            async deleteDraftAttachment() {
              throw new AppError("NOT_FOUND", "Attachment is not available");
            },
            async deleteConversationAttachments() {
              return {
                attachmentCount: 0,
                fileObjectKeys: [],
                artifactObjectKeys: []
              };
            },
            async readConversationFile() {
              throw new AppError("NOT_FOUND", "Attachment is not available");
            },
            blockingDraftAttachmentMessage() {
              return undefined;
            },
            createAttachmentManifest() {
              return {
                version: 1,
                attachments: []
              };
            },
            isInlineDisplayMimeType() {
              return false;
            }
          }
        ]
      };
    }
  };
}

function createWorkspacePreviewArtifactSeedingCapability(root: string): ClientInstanceCapability {
  return {
    name: "workspace-preview-artifact-seeding",
    create(context) {
      const managedObjects = context.managedObjectAccess.createAccess({
        byteStore: createWorkspaceArtifactSeedByteStore(root),
        keyFactory: createWorkspacePreviewArtifactSeedKeyFactory()
      });
      return {
        attachments: [
          {
            name: "workspace-preview-artifact-seeding",
            maxFileBytes: 1024,
            acceptedFileTypes: ["text/x-workspace-preview-test"],
            acceptsFile(file) {
              return file.mimeType === "text/x-workspace-preview-test";
            },
            async listDraftAttachments(conversationId) {
              return context.files.listDraftAttachments({
                clientInstanceId: context.clientInstanceId,
                conversationId
              });
            },
            async uploadDraftAttachment(input) {
              const file = await managedObjects.createFile({
                ownerUserId: input.ownerUserId,
                conversationId: input.conversationId,
                filename: input.filename,
                mimeType: "text/x-workspace-preview-test",
                bytes: input.bytes
              });
              const source = await managedObjects.createArtifact({
                conversationId: input.conversationId,
                kind: "presentation.pptx",
                filename: "deck.pptx",
                mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                bytes: new TextEncoder().encode("pptx-source"),
                metadata: {
                  source: "execution_workspace",
                  workspacePath: "deck.pptx"
                }
              });
              const preview = await managedObjects.createArtifact({
                conversationId: input.conversationId,
                sourceFileId: file.id,
                kind: "presentation.preview_slide_image",
                filename: "deck-slide-1.png",
                mimeType: "image/png",
                bytes: input.bytes,
                metadata: {
                  sourceArtifactId: source.id,
                  previewRole: "slide",
                  slideNumber: 1,
                  rendererVersion: "test"
                }
              });
              return context.files.createConversationAttachment({
                clientInstanceId: context.clientInstanceId,
                conversationId: input.conversationId,
                fileId: file.id,
                filename: input.filename,
                mimeType: "text/x-workspace-preview-test",
                byteSize: input.bytes.byteLength,
                checksum: file.checksum,
                status: "ready",
                artifactRefs: {
                  source: source.id,
                  preview: preview.id
                },
                processingMetadata: {
                  source: "workspace_preview_artifact_seeding"
                },
                warnings: []
              }) as Promise<DraftAttachment>;
            },
            async retryDraftAttachment() {
              throw new AppError("NOT_FOUND", "Attachment is not available");
            },
            async deleteDraftAttachment() {
              throw new AppError("NOT_FOUND", "Attachment is not available");
            },
            async deleteConversationAttachments() {
              return {
                attachmentCount: 0,
                fileObjectKeys: [],
                artifactObjectKeys: []
              };
            },
            async readConversationFile() {
              throw new AppError("NOT_FOUND", "Attachment is not available");
            },
            blockingDraftAttachmentMessage() {
              return undefined;
            },
            createAttachmentManifest() {
              return {
                version: 1,
                attachments: []
              };
            },
            isInlineDisplayMimeType() {
              return false;
            }
          }
        ]
      };
    }
  };
}

function createWorkspaceArtifactSeedByteStore(root: string) {
  return {
    async putObject(input: { key: string; body: Uint8Array }) {
      const path = objectPath(root, input.key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, input.body);
    },
    async getObject(key: string) {
      return readFile(objectPath(root, key));
    },
    async deleteObject(key: string) {
      await rm(objectPath(root, key), { force: true });
    }
  };
}

function createWorkspaceArtifactSeedKeyFactory() {
  return {
    createFileObjectKey(input: {
      clientInstanceId: string;
      conversationId?: string;
      checksum: string;
      filename: string;
    }) {
      return [
        "workspace-artifact-seeding-source",
        encodeURIComponent(input.clientInstanceId),
        encodeURIComponent(input.conversationId ?? "conversationless"),
        encodeURIComponent(input.checksum),
        encodeURIComponent(input.filename)
      ].join("/");
    },
    createArtifactObjectKey(input: {
      clientInstanceId: string;
      conversationId: string;
      checksum: string;
      filename?: string;
    }) {
      return [
        "execution-workspaces",
        encodeURIComponent(input.clientInstanceId),
        encodeURIComponent(input.conversationId),
        "ews_seed",
        "wcmd_seed",
        encodeURIComponent(input.checksum),
        encodeURIComponent(input.filename ?? "final.csv")
      ].join("/");
    }
  };
}

function createWorkspacePreviewArtifactSeedKeyFactory() {
  return {
    createFileObjectKey(input: {
      clientInstanceId: string;
      conversationId?: string;
      checksum: string;
      filename: string;
    }) {
      return [
        "workspace-preview-seeding-source",
        encodeURIComponent(input.clientInstanceId),
        encodeURIComponent(input.conversationId ?? "conversationless"),
        encodeURIComponent(input.checksum),
        encodeURIComponent(input.filename)
      ].join("/");
    },
    createArtifactObjectKey(input: {
      clientInstanceId: string;
      conversationId: string;
      checksum: string;
      filename?: string;
      kind: string;
    }) {
      if (input.kind === "presentation.preview_slide_image") {
        return [
          "artifact-previews",
          encodeURIComponent(input.clientInstanceId),
          encodeURIComponent(input.conversationId),
          "preview_seed",
          encodeURIComponent(input.checksum),
          encodeURIComponent(input.filename ?? "deck-slide-1.png")
        ].join("/");
      }
      return [
        "execution-workspaces",
        encodeURIComponent(input.clientInstanceId),
        encodeURIComponent(input.conversationId),
        "ews_preview_seed",
        "wcmd_preview_seed",
        encodeURIComponent(input.checksum),
        encodeURIComponent(input.filename ?? "deck.pptx")
      ].join("/");
    }
  };
}

async function expectObjectMissing(root: string, objectKey: string): Promise<void> {
  try {
    await access(objectPath(root, objectKey));
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    throw error;
  }
  throw new Error(`Expected workspace object '${objectKey}' to be deleted before broad cleanup`);
}

function objectPath(root: string, objectKey: string): string {
  return join(root, ...objectKey.split("/"));
}

function createExpectedSourceObjectKey(input: {
  clientInstanceId: string;
  conversationId: string;
  checksum: string;
  filename: string;
}): string {
  return [
    "execution-workspace-source-files",
    encodeURIComponent(input.clientInstanceId),
    encodeURIComponent(input.conversationId),
    encodeURIComponent(input.checksum),
    encodeURIComponent(input.filename)
  ].join("/");
}

function createExpectedSeedArtifactObjectKey(input: {
  clientInstanceId: string;
  conversationId: string;
  checksum: string;
  filename: string;
}): string {
  return [
    "execution-workspaces",
    encodeURIComponent(input.clientInstanceId),
    encodeURIComponent(input.conversationId),
    "ews_seed",
    "wcmd_seed",
    encodeURIComponent(input.checksum),
    encodeURIComponent(input.filename)
  ].join("/");
}

function checksumString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
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
