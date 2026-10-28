import { required } from "./support/assertions";
import { workspaceInfrastructure } from "./support/fixtures";

import { uploadContent } from "./support/chat-server-attachment-harness";
import { type TestInstance, createTestInstance } from "./support/test-instance";

import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AppError,
  asClientInstanceId,
  asConversationId,
  createPlatformId,
  type Conversation,
  type ConversationAttachment,
  type DraftAttachment,
  type FileAttachmentFormat,
  type ManagedFileId
} from "@work-shape/catalyst-core";

import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import {
  createExecutionWorkspaceSourceAttachmentHandler,
  detectWorkspaceSourceFileFormat,
  type ClientInstanceCapability,
  WORKSPACE_SOURCE_ACCEPTED_FILE_TYPES
} from "@work-shape/catalyst-client-assembly";
import { createFilesystemObjectStorage } from "@work-shape/catalyst-object-storage";

describe("execution workspace source attachments", () => {
  const sourceFiles = [
    {
      extension: "html",
      mimeType: "text/html",
      content: "<script>globalThis.sourceRan = true</script>"
    },
    { extension: "css", mimeType: "text/css", content: "body { color: red; }" },
    { extension: "js", mimeType: "text/javascript", content: "globalThis.sourceRan = true;" },
    {
      extension: "svg",
      mimeType: "image/svg+xml",
      content: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'
    },
    {
      extension: "xml",
      mimeType: "application/xml",
      content: '<?xml version="1.0"?><source>Text</source>'
    },
    { extension: "md", mimeType: "text/markdown", content: "# Source" }
  ];

  it("advertises source code and detects its extension despite generic browser MIME types", () => {
    for (const { extension, mimeType } of sourceFiles) {
      const format = extension === "md" ? "markdown" : extension;
      expect(WORKSPACE_SOURCE_ACCEPTED_FILE_TYPES).toContain(`.${extension}`);
      expect(WORKSPACE_SOURCE_ACCEPTED_FILE_TYPES).toContain(mimeType);
      for (const browserMime of [undefined, "application/octet-stream", "text/plain", mimeType]) {
        expect(
          detectWorkspaceSourceFileFormat(`SOURCE.${extension.toUpperCase()}`, browserMime)
        ).toBe(format);
      }
      expect(detectWorkspaceSourceFileFormat("source", `${mimeType}; charset=utf-8`)).toBe(format);
    }
    expect(detectWorkspaceSourceFileFormat("source", "application/javascript")).toBe("js");
    expect(detectWorkspaceSourceFileFormat("source", "text/xml")).toBe("xml");
  });

  it("keeps source code readable as raw bytes and serves sent sources only as downloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "catalyst-source-code-"));
    const app = await createTestInstance({
      config: createWorkspaceAttachmentConfig({ root }),
      capabilities: [],
      tools: []
    });
    try {
      const created = await app.call("conversations.create", {
        payload: { title: "Source files" }
      });
      expect(created.statusCode).toBe(200);
      const conversationId = asConversationId(created.json().id);
      const handler = createExecutionWorkspaceSourceAttachmentHandler({
        clientInstanceId: asClientInstanceId("workspace-source-local"),
        files: app.stores.files,
        objectStore: createFilesystemObjectStorage(root),
        markDeletedOnDelete: true
      });
      for (const { extension, mimeType, content } of sourceFiles) {
        const filename = `source.${extension}`;
        const uploaded = await uploadFile(app, conversationId, {
          filename,
          contentType: mimeType,
          content
        });
        expect(uploaded.statusCode, uploaded.body).toBe(200);
        const { attachment } = uploaded.json<{ attachment: DraftAttachment }>();
        expect(attachment).toMatchObject({
          status: "ready",
          format: extension === "md" ? "markdown" : extension
        });

        // The agent's importer reads the original managed file, without rendering or conversion.
        const source = await handler.readConversationFile({
          conversationId,
          fileId: attachment.fileId
        });
        expect(new TextDecoder().decode(source.bytes)).toBe(content);
        const manifest = handler.createAttachmentManifest([attachment]);
        expect(manifest.attachments[0]).toMatchObject({
          fileId: attachment.fileId,
          kind: "workspace_source",
          modelContext: { text: expect.stringContaining("workspace.import_files") }
        });

        const inline = await app.call("conversations.files.get_content", {
          params: { conversationId, fileId: attachment.fileId }
        });
        expect(inline.statusCode).toBe(422);

        // Downloads are available only after the attachment belongs to a sent message.
        const message = await app.stores.conversations.appendMessage({
          clientInstanceId: asClientInstanceId("workspace-source-local"),
          conversationId,
          role: "user",
          text: "Read this source file"
        });
        await app.stores.files.claimReadyDraftAttachmentsForMessage({
          clientInstanceId: asClientInstanceId("workspace-source-local"),
          conversationId,
          messageId: message.id,
          claimedAt: new Date().toISOString()
        });
        const downloaded = await app.call("conversations.files.get_content", {
          params: { conversationId, fileId: attachment.fileId },
          query: { download: "true" }
        });
        expect(downloaded.statusCode, downloaded.body).toBe(200);
        expect(downloaded.headers["content-disposition"]).toMatch(/^attachment;/u);
        expect(downloaded.headers["x-content-type-options"]).toBe("nosniff");
        expect(downloaded.body).toBe(content);
      }
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts chat Markdown and TXT without document processing and advertises them in the picker", async () => {
    const root = await mkdtemp(join(tmpdir(), "catalyst-text-upload-"));
    const app = await createTestInstance({
      config: createWorkspaceAttachmentConfig({ root }),
      capabilities: [],
      tools: []
    });
    try {
      const configuration = await app.call("config.get", {});
      const accept = configuration.json().features.attachments.accept.split(",");
      expect(accept).toEqual(expect.arrayContaining([".txt", ".md", "text/markdown"]));
      const created = await app.call("conversations.create", {
        payload: { title: "Create a Knowledge Base with these text files" }
      });
      expect(created.statusCode).toBe(200);
      const conversationId: string = created.json().id;
      for (const file of [
        {
          filename: "reisen.md",
          contentType: "text/markdown",
          content: "# Reisen\nBahnreisen",
          expectedFormat: "markdown"
        },
        {
          filename: "urlaub.txt",
          contentType: "text/plain",
          content: "Urlaubstage",
          expectedFormat: "txt"
        },
        {
          filename: "support.md",
          contentType: "application/octet-stream",
          content: "# Support",
          expectedFormat: "markdown"
        }
      ]) {
        await expectUpload(app, conversationId, file);
      }
      const listed = await app.call("conversations.draft_attachments.list", {
        params: { conversationId }
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ filename: "reisen.md", status: "ready" }),
          expect.objectContaining({ filename: "urlaub.txt", status: "ready" }),
          expect.objectContaining({ filename: "support.md", status: "ready" })
        ])
      );
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts PDF, DOCX and JSON from the same list advertised by the picker (ACCEPT-FIX-12 attachments)", () => {
    for (const [extension, mime] of [
      ["pdf", "application/pdf"],
      ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["json", "application/json"]
    ]) {
      expect(WORKSPACE_SOURCE_ACCEPTED_FILE_TYPES).toContain(`.${extension}`);
      expect(WORKSPACE_SOURCE_ACCEPTED_FILE_TYPES).toContain(mime);
      expect(
        detectWorkspaceSourceFileFormat(`source.${extension}`, "application/octet-stream")
      ).toBe(extension);
      expect(detectWorkspaceSourceFileFormat("source", mime)).toBe(extension);
    }
  });

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
    expect(detectWorkspaceSourceFileFormat("notes.txt", undefined)).toBe("txt");
    expect(detectWorkspaceSourceFileFormat("notes.md", undefined)).toBe("markdown");
    expect(detectWorkspaceSourceFileFormat("notes.md", "text/plain")).toBe("markdown");
    expect(detectWorkspaceSourceFileFormat("notes.markdown", undefined)).toBe("markdown");
    expect(detectWorkspaceSourceFileFormat("source.csv", "text/plain")).toBe("csv");
    expect(detectWorkspaceSourceFileFormat("notes", "text/plain")).toBe("txt");
    for (const filename of ["script.py", "archive.bin"]) {
      expect(detectWorkspaceSourceFileFormat(filename, "text/plain")).toBeUndefined();
    }
    expect(detectWorkspaceSourceFileFormat("notes", "text/markdown; charset=utf-8")).toBe(
      "markdown"
    );
    expect(detectWorkspaceSourceFileFormat("archive.zip", "application/zip")).toBeUndefined();
    expect(WORKSPACE_SOURCE_ACCEPTED_FILE_TYPES).toEqual(
      expect.arrayContaining([
        ".xlsx",
        ".pptx",
        ".doc",
        ".csv",
        ".txt",
        ".md",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      ])
    );
  });

  it("stores uploaded source files as managed conversation refs without exposing object keys", async () => {
    const fixture = await createSourceAttachmentFixture();
    try {
      const bytes = new TextEncoder().encode("name,total\nAda,42\n");
      const { attachment } = await fixture.handler.uploadDraftAttachment({
        conversationId: fixture.conversation.id,
        ownerUserId: "user-1",
        filename: "analysis.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        content: uploadContent(bytes)
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
        "use the returned importedFiles[].path exactly"
      );
      expect(manifest.attachments[0]?.modelContext?.text).toContain(
        "do not guess or shorten filenames"
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
          locale: "de",
          filename: "kaputt.docx",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          content: uploadContent(new TextEncoder().encode("kaputt"))
        })
      ).rejects.toMatchObject({
        message:
          "Diese DOCX-Datei ist kein lesbares Word-Dokument. Hänge die ursprüngliche DOCX-Datei an."
      });
      await expect(
        fixture.handler.uploadDraftAttachment({
          conversationId: fixture.conversation.id,
          ownerUserId: "user-1",
          filename: "archive.zip",
          mimeType: "application/zip",
          content: uploadContent(new TextEncoder().encode("zip"))
        })
      ).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        message: expect.stringContaining("Supported types:")
      });

      await expect(
        fixture.handler.uploadDraftAttachment({
          conversationId: fixture.conversation.id,
          ownerUserId: "user-1",
          filename: "large.csv",
          mimeType: "text/csv",
          content: uploadContent(new TextEncoder().encode("too-large"))
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

      const artifact = await fixture.store.files.createManagedArtifact({
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
        fixture.store.files.getManagedArtifact({
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
    const app = await createTestInstance({
      config: createWorkspaceAttachmentConfig({ root }),
      capabilities: [createStrictUploadCapability()],
      tools: []
    });
    try {
      const config = await app.call("config.get", {});
      expect(config.statusCode).toBe(200);
      const accept = (config.json() as { features: { attachments: { accept: string } } }).features
        .attachments.accept;
      expect(accept).toContain(".xlsx");
      expect(accept).toContain("application/pdf");
      expect(accept).toContain("image/png");

      const created = await app.call("conversations.create", {
        payload: { title: "Dropzone source artifact test" }
      });
      expect(created.statusCode).toBe(200);
      const conversation = created.json() as { id: string };

      await expectUpload(app, conversation.id, {
        filename: "analysis.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        content: "spreadsheet",
        expectedFormat: "xlsx"
      });
      await expectUpload(app, conversation.id, {
        filename: "scan.pdf",
        contentType: "application/pdf",
        content: "%PDF-1.4",
        expectedFormat: "pdf"
      });
      await expectUpload(app, conversation.id, {
        filename: "photo.png",
        contentType: "image/png",
        content: "png",
        expectedFormat: "png"
      });
      await expectUpload(app, conversation.id, {
        filename: "notes.md",
        contentType: "text/markdown",
        content: "# Notes",
        expectedFormat: "markdown"
      });
      await expectUpload(app, conversation.id, {
        filename: "notes.txt",
        contentType: "text/plain",
        content: "Notes",
        expectedFormat: "txt"
      });

      const unsupported = await uploadFile(app, conversation.id, {
        filename: "archive.zip",
        contentType: "application/zip",
        content: "zip"
      });
      const german = await uploadFile(app, conversation.id, {
        filename: "kaputt.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        content: "kaputt",
        locale: "de"
      });
      expect(german.statusCode).toBe(422);
      expect(german.json()).toMatchObject({
        error: {
          message:
            "Diese DOCX-Datei ist kein lesbares Word-Dokument. Hänge die ursprüngliche DOCX-Datei an."
        }
      });
      expect(unsupported.statusCode).toBe(400);
      expect(unsupported.json()).toMatchObject({
        error: {
          code: "BAD_REQUEST",
          message: expect.stringContaining("Supported types:")
        }
      });

      const oversized = await uploadFile(app, conversation.id, {
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
    const app = await createTestInstance({
      config: createWorkspaceAttachmentConfig({ root }),
      capabilities: [
        createWorkspaceArtifactSeedingCapability(root),
        createBroadCleanupMarkerCapability(root, expectedDeletedObjectKeys)
      ],
      tools: []
    });
    try {
      const created = await app.call("conversations.create", {
        payload: { title: "Workspace cleanup ordering test" }
      });
      expect(created.statusCode).toBe(200);
      const conversation = created.json() as { id: string };

      const sourceContent = "source,total\nAda,42\n";
      const uploadedSource = await uploadFile(app, conversation.id, {
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
      const uploadedArtifact = await uploadFile(app, conversation.id, {
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

      const deleted = await app.call("conversations.delete", {
        params: { conversationId: conversation.id }
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
    const app = await createTestInstance({
      config: createWorkspaceAttachmentConfig({ root }),
      capabilities: [
        createWorkspaceArtifactSeedingCapability(root),
        createBroadManagedObjectReaderCapability()
      ],
      tools: []
    });
    try {
      const created = await app.call("conversations.create", {
        payload: { title: "Workspace artifact dispatch test" }
      });
      expect(created.statusCode).toBe(200);
      const conversation = created.json() as { id: string };

      const uploaded = await uploadFile(app, conversation.id, {
        filename: "source.seed",
        contentType: "text/x-workspace-artifact-test",
        content: "name,total\nAda,42\n"
      });
      expect(uploaded.statusCode).toBe(200);
      const artifactId = (uploaded.json() as { attachment: { artifactRefs: { final?: string } } })
        .attachment.artifactRefs.final;
      expect(artifactId).toEqual(expect.any(String));

      const downloaded = await app.call("conversations.artifacts.get_content", {
        params: { conversationId: conversation.id, artifactId: required(artifactId) }
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
    const app = await createTestInstance({
      config: createWorkspaceAttachmentConfig({ root }),
      capabilities: [
        createWorkspacePreviewArtifactSeedingCapability(root),
        createBroadManagedObjectReaderCapability()
      ],
      tools: []
    });
    try {
      const created = await app.call("conversations.create", {
        payload: { title: "Workspace preview artifact dispatch test" }
      });
      expect(created.statusCode).toBe(200);
      const conversation = created.json() as { id: string };

      const uploaded = await uploadFile(app, conversation.id, {
        filename: "deck.preview-seed",
        contentType: "text/x-workspace-preview-test",
        content: "PNG-preview"
      });
      expect(uploaded.statusCode).toBe(200);
      const previewArtifactId = (
        uploaded.json() as { attachment: { artifactRefs: { preview?: string } } }
      ).attachment.artifactRefs.preview;
      expect(previewArtifactId).toEqual(expect.any(String));

      const downloaded = await app.call("conversations.artifacts.get_content", {
        params: { conversationId: conversation.id, artifactId: required(previewArtifactId) }
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
  const store = (await createTestInstance()).stores;
  const conversation = await store.createConversationForTesting({
    clientInstanceId,
    createdByUserId: "user-1",
    createdByExternalUserId: "user-1",
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
      files: store.files,
      objectStore: createFilesystemObjectStorage(root),
      markDeletedOnDelete: true,
      ...input
    }),
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    }
  };
}

function createWorkspaceAttachmentConfig(input: { toolNames?: string[]; root?: string } = {}) {
  return parseClientInstanceConfig({
    version: 1,
    clientInstance: {
      id: "workspace-source-local",
      displayName: "Workspace Source",
      environment: "development"
    },
    auth: {
      development: {
        enabled: true,
        user: { permissionRefs: ["demo-tools"] }
      }
    },
    infrastructure: {
      models: { local: { provider: "deterministic", model: "local" } },
      ...workspaceInfrastructure(input.root)
    },
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
        byteStore: createFilesystemObjectStorage(root),
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
              const bytes = await readUploadBytes(input);
              const file = await managedObjects.createFile({
                ownerUserId: input.ownerUserId,
                conversationId: input.conversationId,
                filename: input.filename,
                mimeType: "text/x-workspace-artifact-test",
                bytes
              });
              const artifact = await managedObjects.createArtifact({
                conversationId: input.conversationId,
                sourceFileId: file.id,
                kind: "text/csv",
                filename: "final.csv",
                mimeType: "text/csv",
                bytes,
                metadata: {
                  source: "execution_workspace",
                  workspacePath: "scratch/final.csv"
                }
              });
              const attachment = await context.files.createConversationAttachment({
                clientInstanceId: context.clientInstanceId,
                conversationId: input.conversationId,
                fileId: file.id,
                filename: input.filename,
                mimeType: "text/x-workspace-artifact-test",
                byteSize: bytes.byteLength,
                checksum: file.checksum,
                status: "ready",
                artifactRefs: {
                  final: artifact.id
                },
                processingMetadata: {
                  source: "workspace_artifact_seeding"
                },
                warnings: []
              });
              return { attachment, outcome: "created" };
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
        byteStore: createFilesystemObjectStorage(root),
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
              const bytes = await readUploadBytes(input);
              const file = await managedObjects.createFile({
                ownerUserId: input.ownerUserId,
                conversationId: input.conversationId,
                filename: input.filename,
                mimeType: "text/x-workspace-preview-test",
                bytes
              });
              const source = await managedObjects.createArtifact({
                conversationId: input.conversationId,
                kind: "presentation.pptx",
                filename: "deck.pptx",
                mimeType:
                  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
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
                bytes,
                metadata: {
                  sourceArtifactId: source.id,
                  previewRole: "slide",
                  slideNumber: 1,
                  rendererVersion: "test"
                }
              });
              const attachment = await context.files.createConversationAttachment({
                clientInstanceId: context.clientInstanceId,
                conversationId: input.conversationId,
                fileId: file.id,
                filename: input.filename,
                mimeType: "text/x-workspace-preview-test",
                byteSize: bytes.byteLength,
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
              });
              return { attachment, outcome: "created" };
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
            acceptedFileTypes: ["application/pdf", "image/png", "text/plain", "text/markdown"],
            acceptsFile(file) {
              return formatForMimeType(file.mimeType) !== undefined;
            },
            async listDraftAttachments(conversationId) {
              return attachmentsByConversation.get(conversationId) ?? [];
            },
            async uploadDraftAttachment(input) {
              const bytes = await readUploadBytes(input);
              if (bytes.byteLength > maxFileBytes) {
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
                byteSize: bytes.byteLength,
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
                bytes
              });
              const conversationAttachments =
                attachmentsByConversation.get(input.conversationId) ?? [];
              conversationAttachments.push(attachment);
              attachmentsByConversation.set(input.conversationId, conversationAttachments);
              return { attachment, outcome: "created" };
            },
            async retryDraftAttachment() {
              throw new AppError("NOT_FOUND", "Attachment is not available");
            },
            async deleteDraftAttachment(input) {
              const attachments = attachmentsByConversation.get(input.conversationId) ?? [];
              const deleted = attachments.find(
                (attachment) => attachment.id === input.attachmentId
              );
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
  if (mimeType === "text/plain") return "txt";
  if (mimeType === "text/markdown") return "markdown";
  if (mimeType === "application/pdf") {
    return "pdf";
  }
  if (mimeType === "image/png") {
    return "png";
  }
  return undefined;
}

async function expectUpload(
  server: TestInstance,
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
  server: TestInstance,
  conversationId: string,
  input: {
    filename: string;
    contentType: string;
    content: string;
    locale?: string;
  }
) {
  const multipart = createMultipartFilePayload({
    fieldName: "file",
    ...input
  });
  return server.call("conversations.draft_attachments.upload", {
    params: { conversationId: conversationId },
    headers: { ...multipart.headers, ...(input.locale ? { "accept-language": input.locale } : {}) },
    payload: multipart.payload
  });
}

async function readUploadBytes(input: {
  bytes?: Uint8Array;
  content?: { openStream(): AsyncIterable<Uint8Array> };
}): Promise<Uint8Array> {
  if (input.bytes) {
    return input.bytes;
  }
  if (!input.content) {
    throw new Error("Upload content is missing");
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of input.content.openStream()) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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
