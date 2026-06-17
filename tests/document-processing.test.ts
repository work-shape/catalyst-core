import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  asManagedArtifactId,
  type ConversationAttachment,
  type DocumentPreprocessingConfig
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import {
  createAttachmentManifest,
  createReadDocumentTool,
  createViewDocumentPageTool,
  DocumentAttachmentProcessor,
  DocumentPageRenderService,
  DocumentPreprocessingService,
  InMemoryObjectStore,
  PlatformDocumentPreprocessor,
  resolveS3Credentials,
  type DocumentPreprocessor
} from "@vivd-catalyst/document-processing";

describe("document preprocessing", () => {
  it("exposes OpenAI-compatible root object schemas for document tools", () => {
    const reader = {} as ConstructorParameters<typeof createReadDocumentTool>[0];
    const viewer = {} as ConstructorParameters<typeof createViewDocumentPageTool>[0];
    const readTool = createReadDocumentTool(reader);
    const viewTool = createViewDocumentPageTool(viewer);

    expect(readTool.inputJsonSchema).toMatchObject({
      type: "object",
      required: ["fileId", "mode"],
      properties: {
        fileId: expect.any(Object),
        mode: expect.objectContaining({
          enum: ["full", "pages"]
        })
      }
    });
    expect(viewTool.inputJsonSchema).toMatchObject({
      type: "object",
      required: ["fileId", "pageNumber"]
    });
  });

  it("preprocesses a text document on upload and reads the prepared text by conversation file id", async () => {
    const { service, processor, store, conversationId } = await createDocumentFixture();

    const attachment = await service.uploadDraftAttachment({
      conversationId,
      ownerUserId: "user-1",
      filename: "notes.txt",
      mimeType: "text/plain",
      bytes: new TextEncoder().encode("first page words\nsecond line")
    });
    await processNextAttachment(processor);
    const ready = await waitForAttachment(store, attachment.id, "ready");

    expect(ready).toMatchObject({
      filename: "notes.txt",
      status: "ready",
      wordCount: 5,
      characterCount: 28
    });

    const read = await service.readDocument({
      conversationId,
      fileId: ready.fileId,
      mode: "full"
    });

    expect(read.artifactId).toBe(ready.preparedTextArtifactId);
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

  it("marks Word temporary owner files as unsupported", async () => {
    const { service, conversationId } = await createDocumentFixture();

    const attachment = await service.uploadDraftAttachment({
      conversationId,
      ownerUserId: "user-1",
      filename: "~$26-001-rechnung-extrade.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: new TextEncoder().encode("Felix Pahlke\u0000\u0000")
    });

    expect(attachment).toMatchObject({
      status: "unsupported",
      error: {
        code: "unsupported_document_format",
        message: expect.stringContaining("temporary owner files")
      }
    });
  });

  it("marks DOCX uploads without a ZIP package signature as unsupported", async () => {
    const { service, conversationId } = await createDocumentFixture();

    const attachment = await service.uploadDraftAttachment({
      conversationId,
      ownerUserId: "user-1",
      filename: "invoice.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: new TextEncoder().encode("not a zip package")
    });

    expect(attachment).toMatchObject({
      status: "unsupported",
      error: {
        code: "unsupported_document_format",
        message: expect.stringContaining("not a valid Word document package")
      }
    });
  });

  it("claims queued document attachments with lease caps and stale completion protection", async () => {
    const { service, store, conversationId } = await createDocumentFixture();
    const attachment = await service.uploadDraftAttachment({
      conversationId,
      ownerUserId: "user-1",
      filename: "queued.txt",
      mimeType: "text/plain",
      bytes: new TextEncoder().encode("queued document")
    });
    expect(attachment.status).toBe("queued");

    const now = new Date("2026-06-17T10:00:00.000Z");
    const firstClaim = await store.claimNextQueuedDocumentAttachment({
      clientInstanceId: asClientInstanceId("document-client"),
      workerId: "worker-1",
      leaseToken: "lease-1",
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
      perConversationLimit: 1,
      globalLimit: 1
    });
    expect(firstClaim).toMatchObject({
      id: attachment.id,
      status: "preprocessing",
      processingOwnerId: "worker-1",
      processingLeaseToken: "lease-1",
      processingAttempts: 1
    });

    await expect(
      store.claimNextQueuedDocumentAttachment({
        clientInstanceId: asClientInstanceId("document-client"),
        workerId: "worker-2",
        leaseToken: "lease-2",
        now: now.toISOString(),
        leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
        perConversationLimit: 1,
        globalLimit: 1
      })
    ).resolves.toBeUndefined();

    await expect(
      store.completeClaimedDocumentAttachment({
        clientInstanceId: asClientInstanceId("document-client"),
        attachmentId: attachment.id,
        leaseToken: "stale-lease",
        preparedTextArtifactId: asManagedArtifactId("art_stale"),
        preprocessingEngine: "direct_text",
        characterCount: 0,
        wordCount: 0,
        warnings: [],
        completedAt: now.toISOString()
      })
    ).rejects.toThrow("Document preprocessing lease is no longer active");

    const afterExpiry = new Date(now.getTime() + 120_000);
    const reclaimed = await store.claimNextQueuedDocumentAttachment({
      clientInstanceId: asClientInstanceId("document-client"),
      workerId: "worker-2",
      leaseToken: "lease-2",
      now: afterExpiry.toISOString(),
      leaseExpiresAt: new Date(afterExpiry.getTime() + 60_000).toISOString(),
      perConversationLimit: 1,
      globalLimit: 1
    });
    expect(reclaimed).toMatchObject({
      id: attachment.id,
      status: "preprocessing",
      processingOwnerId: "worker-2",
      processingLeaseToken: "lease-2",
      processingAttempts: 2
    });
    await expect(
      store.failClaimedDocumentAttachment({
        clientInstanceId: asClientInstanceId("document-client"),
        attachmentId: attachment.id,
        leaseToken: "lease-1",
        error: {
          code: "stale",
          message: "stale"
        },
        completedAt: afterExpiry.toISOString()
      })
    ).rejects.toThrow("Document preprocessing lease is no longer active");
  });

  it("removes unsupported control characters from prepared text", async () => {
    const { service, processor, store, conversationId } = await createDocumentFixture();
    const attachment = await service.uploadDraftAttachment({
      conversationId,
      ownerUserId: "user-1",
      filename: "padded.txt",
      mimeType: "text/plain",
      bytes: new TextEncoder().encode("Alpha\u0000 Beta\u0007\nGamma\tDelta\u000c")
    });
    await processNextAttachment(processor);
    const ready = await waitForAttachment(store, attachment.id, "ready");

    expect(ready.warnings).toContainEqual(
      expect.objectContaining({
        code: "control_characters_removed"
      })
    );

    const read = await service.readDocument({
      conversationId,
      fileId: ready.fileId,
      mode: "full"
    });
    expect(read.text).toBe("Alpha Beta\nGamma\tDelta");
    expect(read.text).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u);
    expect(read.metadata).toMatchObject({
      characterCount: 22,
      wordCount: 4
    });
  });

  it("preprocesses DOCX as a canonical PDF-backed page-aware document", async () => {
    const { service, processor, store, objectStore, conversationId } = await createDocumentFixture(
      createCanonicalPdfPreprocessor(new TextEncoder().encode("%PDF-fixture"))
    );
    const attachment = await service.uploadDraftAttachment({
      conversationId,
      ownerUserId: "user-1",
      filename: "contract.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: createDocxZipHeader()
    });
    await processNextAttachment(processor);
    const ready = await waitForAttachment(store, attachment.id, "ready");

    expect(ready).toMatchObject({
      filename: "contract.docx",
      status: "ready",
      format: "docx",
      preprocessingEngine: "libreoffice_pdf",
      pageCount: 2
    });
    expect(ready.preparedTextArtifactId).toBeDefined();
    expect(ready.preparedPagesArtifactId).toBeDefined();

    const canonicalArtifacts = await store.listManagedArtifactsForFile({
      clientInstanceId: asClientInstanceId("document-client"),
      conversationId,
      fileId: ready.fileId,
      kind: "document.canonical_pdf"
    });
    expect(canonicalArtifacts).toHaveLength(1);
    expect(canonicalArtifacts[0]).toMatchObject({
      kind: "document.canonical_pdf",
      filename: "contract.docx.canonical.pdf",
      mimeType: "application/pdf",
      metadata: expect.objectContaining({
        sourceFormat: "docx",
        engine: "libreoffice_pdf"
      })
    });
    await expect(objectStore.getObject(canonicalArtifacts[0]?.objectKey ?? "")).resolves.toEqual(
      new TextEncoder().encode("%PDF-fixture")
    );

    const pageTwo = await service.readDocument({
      conversationId,
      fileId: ready.fileId,
      mode: "pages",
      pages: {
        from: 2,
        to: 2
      }
    });
    expect(pageTwo.pages).toHaveLength(1);
    expect(pageTwo.pages[0]?.pageNumber).toBe(2);
    expect(pageTwo.text).toContain("DOCX page two");
  });

  it("creates a metadata-only attachment manifest", async () => {
    const { service, processor, store, conversationId } = await createDocumentFixture();
    const attachment = await service.uploadDraftAttachment({
      conversationId,
      ownerUserId: "user-1",
      filename: "memo.md",
      mimeType: "text/markdown",
      bytes: new TextEncoder().encode("# Memo\n\nRaw text remains in the prepared artifact.")
    });
    await processNextAttachment(processor);
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

  it("keeps uploaded images as ready visual attachments", async () => {
    const { service, conversationId } = await createDocumentFixture();
    const attachment = await service.uploadDraftAttachment({
      conversationId,
      ownerUserId: "user-1",
      filename: "receipt.png",
      mimeType: "image/png; charset=binary",
      bytes: createPngHeader()
    });

    expect(attachment).toMatchObject({
      filename: "receipt.png",
      status: "ready",
      mimeType: "image/png",
      format: "png"
    });
    expect(attachment.preparedTextArtifactId).toBeUndefined();
    await expect(
      service.readConversationFile({
        conversationId,
        fileId: attachment.fileId
      })
    ).resolves.toMatchObject({
      mimeType: "image/png",
      byteSize: 8
    });

    const manifest = createAttachmentManifest([attachment], "test-preprocessing");

    expect(manifest.attachments).toEqual([
      expect.objectContaining({
        kind: "image",
        fileId: attachment.fileId,
        filename: "receipt.png",
        mimeType: "image/png",
        readable: false,
        modelVisibility: {
          type: "image",
          mimeType: "image/png"
        },
        metadata: expect.objectContaining({
          format: "png",
          checksum: attachment.checksum
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

  const pdfTest = hasPdfTooling() ? it : it.skip;
  pdfTest("extracts PDF text page-by-page and renders selected pages", async () => {
    const clientInstanceId = asClientInstanceId("document-client");
    const store = new InMemoryPlatformStore();
    const objectStore = new InMemoryObjectStore();
    const config = createPreprocessingConfig();
    const service = new DocumentPreprocessingService({
      clientInstanceId,
      store,
      objectStore,
      config
    });
    const processor = new DocumentAttachmentProcessor({
      clientInstanceId,
      store,
      objectStore,
      preprocessor: new PlatformDocumentPreprocessor(config),
      config
    });
    const viewer = new DocumentPageRenderService({
      clientInstanceId,
      store,
      objectStore,
      timeoutMs: config.timeoutMs
    });
    const conversation = await store.createConversation({
      clientInstanceId,
      ownerUserId: "user-1",
      ownerExternalUserId: "user-1",
      title: "PDF",
      retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
    });

    const attachment = await service.uploadDraftAttachment({
      conversationId: conversation.id,
      ownerUserId: "user-1",
      filename: "sample.pdf",
      mimeType: "application/pdf",
      bytes: createTwoPagePdf()
    });
    await processNextAttachment(processor);
    const ready = await waitForAttachment(store, attachment.id, "ready");

    expect(ready).toMatchObject({
      status: "ready",
      format: "pdf",
      pageCount: 2,
      preprocessingEngine: "platform_pdf"
    });
    expect(ready.preparedTextArtifactId).toBeDefined();
    expect(ready.preparedPagesArtifactId).toBeDefined();

    const full = await service.readDocument({
      conversationId: conversation.id,
      fileId: ready.fileId,
      mode: "full"
    });
    expect(full.text).toContain("[Page 1]");
    expect(full.text).toContain("First page alpha");
    expect(full.text).toContain("[Page 2]");
    expect(full.text).toContain("Second page beta");
    expect("pages" in full).toBe(false);

    const pageTwo = await service.readDocument({
      conversationId: conversation.id,
      fileId: ready.fileId,
      mode: "pages",
      pages: {
        from: 2,
        to: 2
      }
    });
    expect(pageTwo.pages).toHaveLength(1);
    expect(pageTwo.pages[0]?.pageNumber).toBe(2);
    expect(pageTwo.text).toContain("Second page beta");
    expect(pageTwo.text).not.toContain("First page alpha");

    const rendered = await viewer.viewPage({
      conversationId: conversation.id,
      fileId: ready.fileId,
      pageNumber: 2
    });
    const artifact = await store.getManagedArtifact({
      clientInstanceId,
      artifactId: rendered.image.artifactId
    });
    expect(artifact).toMatchObject({
      kind: "document.page_image",
      mimeType: "image/png"
    });
    const imageBytes = await objectStore.getObject(artifact?.objectKey ?? "");
    expect([...imageBytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  }, 40000);

  pdfTest("renders DOCX pages from the canonical PDF artifact on demand", async () => {
    const clientInstanceId = asClientInstanceId("document-client");
    const store = new InMemoryPlatformStore();
    const objectStore = new InMemoryObjectStore();
    const config = createPreprocessingConfig();
    const service = new DocumentPreprocessingService({
      clientInstanceId,
      store,
      objectStore,
      config
    });
    const processor = new DocumentAttachmentProcessor({
      clientInstanceId,
      store,
      objectStore,
      preprocessor: createCanonicalPdfPreprocessor(createTwoPagePdf()),
      config
    });
    const viewer = new DocumentPageRenderService({
      clientInstanceId,
      store,
      objectStore,
      timeoutMs: config.timeoutMs
    });
    const conversation = await store.createConversation({
      clientInstanceId,
      ownerUserId: "user-1",
      ownerExternalUserId: "user-1",
      title: "DOCX",
      retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
    });

    const attachment = await service.uploadDraftAttachment({
      conversationId: conversation.id,
      ownerUserId: "user-1",
      filename: "contract.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: createDocxZipHeader()
    });
    await processNextAttachment(processor);
    const ready = await waitForAttachment(store, attachment.id, "ready");

    expect(ready).toMatchObject({
      status: "ready",
      format: "docx",
      pageCount: 2,
      preprocessingEngine: "libreoffice_pdf"
    });

    const rendered = await viewer.viewPage({
      conversationId: conversation.id,
      fileId: ready.fileId,
      pageNumber: 1
    });
    const artifact = await store.getManagedArtifact({
      clientInstanceId,
      artifactId: rendered.image.artifactId
    });
    expect(artifact).toMatchObject({
      kind: "document.page_image",
      mimeType: "image/png"
    });
    const imageBytes = await objectStore.getObject(artifact?.objectKey ?? "");
    expect([...imageBytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  }, 40000);

  it("reports a clear setup error when the office converter is unavailable", async () => {
    const binDirectory = await mkdtemp(path.join(tmpdir(), "vivd-test-empty-bin-"));
    const originalPath = process.env.PATH;
    process.env.PATH = binDirectory;

    try {
      const converter = new PlatformDocumentPreprocessor(createPreprocessingConfig());
      await expect(
        converter.convert({
          filename: "missing-converter.txt",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          format: "docx",
          bytes: createDocxZipHeader()
        })
      ).rejects.toThrow(
        "Document converter command 'soffice' was not found on PATH."
      );
    } finally {
      restorePath(originalPath);
      await rm(binDirectory, { force: true, recursive: true });
    }
  });
});

async function createDocumentFixture(preprocessor: DocumentPreprocessor = createUtf8Preprocessor()) {
  const clientInstanceId = asClientInstanceId("document-client");
  const store = new InMemoryPlatformStore();
  const objectStore = new InMemoryObjectStore();
  const config = createPreprocessingConfig();
  const service = new DocumentPreprocessingService({
    clientInstanceId,
    store,
    objectStore,
    config
  });
  const processor = new DocumentAttachmentProcessor({
    clientInstanceId,
    store,
    objectStore,
    preprocessor,
    config
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
    processor,
    store,
    objectStore,
    conversationId: conversation.id
  };
}

function createUtf8Preprocessor(): DocumentPreprocessor {
  return {
    async convert(input) {
      return {
        engine: "direct_text",
        text: new TextDecoder().decode(input.bytes),
        textMimeType: input.format === "md" ? "text/markdown" : "text/plain",
        warnings: []
      };
    }
  };
}

function createCanonicalPdfPreprocessor(canonicalPdfBytes: Uint8Array): DocumentPreprocessor {
  return {
    async convert() {
      return {
        engine: "libreoffice_pdf",
        text: "[Page 1]\nDOCX page one\n\n[Page 2]\nDOCX page two",
        textMimeType: "text/plain",
        pageCount: 2,
        pages: {
          format: "pdf",
          pageCount: 2,
          pages: [
            {
              pageNumber: 1,
              text: "DOCX page one",
              characterCount: 13,
              wordCount: 3,
              warnings: []
            },
            {
              pageNumber: 2,
              text: "DOCX page two",
              characterCount: 13,
              wordCount: 3,
              warnings: []
            }
          ]
        },
        canonicalPdf: {
          bytes: canonicalPdfBytes,
          mimeType: "application/pdf"
        },
        warnings: []
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
    timeoutMs: 30000,
    perConversationConcurrency: 2,
    globalConcurrency: 4,
    preprocessingVersion: "test-preprocessing"
  };
}

function hasPdfTooling(): boolean {
  return (
    commandWorks(DEFAULT_DOCUMENT_COMMANDS.pdfInfo, ["-v"]) &&
    commandWorks(DEFAULT_DOCUMENT_COMMANDS.pdfRenderer, ["-v"]) &&
    commandWorks(DEFAULT_DOCUMENT_COMMANDS.python, ["-c", "import pdfplumber, pypdf, reportlab"])
  );
}

function commandWorks(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, {
    stdio: "ignore"
  });
  return result.status === 0;
}

function createTwoPagePdf(): Uint8Array {
  const script = String.raw`
from io import BytesIO
import sys
from reportlab.pdfgen import canvas

buffer = BytesIO()
pdf = canvas.Canvas(buffer, pagesize=(612, 792))
for text in ("First page alpha", "Second page beta"):
    pdf.setFont("Helvetica", 18)
    pdf.drawString(72, 720, text)
    pdf.showPage()
pdf.save()
sys.stdout.buffer.write(buffer.getvalue())
`;
  const result = spawnSync(DEFAULT_DOCUMENT_COMMANDS.python, ["-c", script], {
    maxBuffer: 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.toString("utf8") || "Failed to generate PDF fixture");
  }
  return new Uint8Array(result.stdout);
}

function createDocxZipHeader(): Uint8Array {
  return new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
}

function createPngHeader(): Uint8Array {
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
}

const DEFAULT_DOCUMENT_COMMANDS = {
  python: "python3",
  pdfInfo: "pdfinfo",
  pdfRenderer: "pdftoppm"
};

function restorePath(originalPath: string | undefined): void {
  if (originalPath === undefined) {
    delete process.env.PATH;
    return;
  }
  process.env.PATH = originalPath;
}

async function processNextAttachment(processor: DocumentAttachmentProcessor): Promise<void> {
  const result = await processor.processNext({
    workerId: "test-worker"
  });
  expect(result.status).toBe("processed");
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
