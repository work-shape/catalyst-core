import { spawnSync } from "node:child_process";
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
  DocumentPageRenderService,
  DocumentPreprocessingService,
  InMemoryObjectStore,
  PlatformDocumentPreprocessor,
  resolveS3Credentials,
  type DocumentPreprocessor
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

  it("reports a clear setup error when markitdown is unavailable", async () => {
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
    preprocessor: createUtf8Preprocessor(),
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
