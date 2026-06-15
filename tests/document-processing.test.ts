import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  type ConversationAttachment,
  type DocumentPreprocessingConfig
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import {
  createAttachmentManifest,
  DocumentPreprocessingService,
  InMemoryObjectStore,
  MarkItDownDocumentTextConverter,
  resolveS3Credentials,
  type DocumentTextConverter
} from "@vivd-catalyst/document-processing";

describe("document preprocessing", () => {
  it("preprocesses a text document on upload and reads the prepared text by conversation file id", async () => {
    const { service, store, conversationId } = await createDocumentFixture();

    const attachment = await service.uploadDraftAttachment({
      conversationId,
      ownerUserId: "user-1",
      filename: "notes.txt",
      mimeType: "text/plain",
      bytes: new TextEncoder().encode("first page words\nsecond line")
    });
    const ready = await waitForAttachment(store, attachment.id, "ready");

    expect(ready).toMatchObject({
      filename: "notes.txt",
      status: "ready",
      wordCount: 5,
      characterCount: 28
    });

    const read = await service.readDocument({
      conversationId,
      fileId: ready.fileId
    });

    expect(read.preparedDocumentId).toBe(ready.preparedDocumentId);
    expect(read.text).toBe("first page words\nsecond line");
    expect(read.metadata).toMatchObject({
      filename: "notes.txt",
      byteSize: 28,
      wordCount: 5,
      warnings: []
    });
  });

  it("marks unsupported files without starting preprocessing", async () => {
    const { service, conversationId } = await createDocumentFixture();

    const attachment = await service.uploadDraftAttachment({
      conversationId,
      ownerUserId: "user-1",
      filename: "sheet.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: new Uint8Array([1, 2, 3])
    });

    expect(attachment).toMatchObject({
      status: "unsupported",
      error: {
        code: "unsupported_document_format"
      }
    });
  });

  it("creates a metadata-only attachment manifest", async () => {
    const { service, store, conversationId } = await createDocumentFixture();
    const attachment = await service.uploadDraftAttachment({
      conversationId,
      ownerUserId: "user-1",
      filename: "memo.md",
      mimeType: "text/markdown",
      bytes: new TextEncoder().encode("# Memo\n\nRaw text remains in the prepared artifact.")
    });
    const ready = await waitForAttachment(store, attachment.id, "ready");

    const manifest = createAttachmentManifest([ready], "test-preprocessing");

    expect(JSON.stringify(manifest)).not.toContain("Raw text remains");
    expect(manifest.attachments).toEqual([
      expect.objectContaining({
        fileId: ready.fileId,
        filename: "memo.md",
        status: "ready",
        readToolName: "read_document",
        metadata: expect.objectContaining({
          wordCount: 8,
          preprocessingVersion: "test-preprocessing"
        })
      })
    ]);
  });

  it("uses deterministic dummy credentials for local S3Mock endpoints", () => {
    expect(
      resolveS3Credentials(
        {
          kind: "s3",
          bucket: "documents",
          region: "us-east-1",
          endpoint: "http://127.0.0.1:9090",
          forcePathStyle: true
        },
        {}
      )
    ).toEqual({
      accessKeyId: "s3mock",
      secretAccessKey: "s3mock"
    });
    expect(
      resolveS3Credentials(
        {
          kind: "s3",
          bucket: "documents",
          region: "us-east-1",
          endpoint: "http://s3mock:9090",
          forcePathStyle: true
        },
        {}
      )
    ).toEqual({
      accessKeyId: "s3mock",
      secretAccessKey: "s3mock"
    });
  });

  it("keeps real S3 endpoints on the AWS credential provider chain when env credentials are absent", () => {
    expect(
      resolveS3Credentials(
        {
          kind: "s3",
          bucket: "documents",
          region: "eu-central-1",
          endpoint: "https://s3.eu-central-1.amazonaws.com",
          forcePathStyle: false
        },
        {}
      )
    ).toBeUndefined();
  });

  it("reports a clear setup error when markitdown is unavailable", async () => {
    const binDirectory = await mkdtemp(path.join(tmpdir(), "vivd-test-empty-bin-"));
    const originalPath = process.env.PATH;
    process.env.PATH = binDirectory;

    try {
      const converter = new MarkItDownDocumentTextConverter(createPreprocessingConfig());
      await expect(
        converter.convert({
          filename: "missing-converter.txt",
          mimeType: "application/pdf",
          format: "pdf",
          bytes: new TextEncoder().encode("fallback text")
        })
      ).rejects.toThrow(
        "Document converter command 'markitdown' was not found on PATH."
      );
    } finally {
      restorePath(originalPath);
      await rm(binDirectory, { force: true, recursive: true });
    }
  });
});

async function createDocumentFixture() {
  const clientInstanceId = asClientInstanceId("document-client");
  const store = new InMemoryPlatformStore();
  const objectStore = new InMemoryObjectStore();
  const service = new DocumentPreprocessingService({
    clientInstanceId,
    store,
    objectStore,
    converter: createUtf8Converter(),
    config: createPreprocessingConfig()
  });
  const conversation = await store.createConversation({
    clientInstanceId,
    ownerUserId: "user-1",
    ownerExternalUserId: "user-1",
    title: "Documents",
    retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
  });
  return {
    service,
    store,
    conversationId: conversation.id
  };
}

function createUtf8Converter(): DocumentTextConverter {
  return {
    async convert(input) {
      return {
        text: new TextDecoder().decode(input.bytes)
      };
    }
  };
}

function createPreprocessingConfig(): DocumentPreprocessingConfig {
  return {
    enabled: true,
    supportedFormats: ["pdf", "docx", "txt", "md"],
    maxFileBytes: 1024 * 1024,
    maxExtractedTextBytes: 1024 * 1024,
    timeoutMs: 10000,
    perConversationConcurrency: 2,
    globalConcurrency: 4,
    converterCommand: "markitdown",
    converterArgs: [],
    preprocessingVersion: "test-preprocessing"
  };
}

function restorePath(originalPath: string | undefined): void {
  if (originalPath === undefined) {
    delete process.env.PATH;
    return;
  }
  process.env.PATH = originalPath;
}

async function waitForAttachment(
  store: InMemoryPlatformStore,
  attachmentId: ConversationAttachment["id"],
  status: ConversationAttachment["status"]
): Promise<ConversationAttachment> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const attachment = await store.getConversationAttachment({
      clientInstanceId: asClientInstanceId("document-client"),
      attachmentId
    });
    if (attachment?.status === status) {
      return attachment;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Attachment ${attachmentId} did not reach status ${status}`);
}
