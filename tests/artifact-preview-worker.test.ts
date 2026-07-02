import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as XLSX from "../packages/tool-execution/node_modules/xlsx";
import {
  type ArtifactPreviewRenderInput,
  type ArtifactPreviewRenderResult,
  type ArtifactPreviewRenderer,
  type ArtifactPreviewWorkerOptions,
  ArtifactPreviewWorker,
  LibreOfficeArtifactPreviewRenderer,
  createArtifactPreviewSettingsHash,
  type DeletableWorkspaceObjectStorage
} from "@vivd-catalyst/tool-execution";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import type {
  ArtifactPreviewFailureCode,
  ClientInstanceId,
  Conversation,
  ManagedArtifactRecord,
  ManagedFileRecord
} from "@vivd-catalyst/core";
import { asClientInstanceId } from "@vivd-catalyst/core";

describe("ArtifactPreviewWorker", () => {
  it("renders a queued document job into managed preview image artifacts and a ready manifest", async () => {
    const fixture = await createWorkerFixture();
    const renderer = new FakeRenderer({
      result: {
        format: "png",
        pages: [
          {
            bytes: bytes("page-one"),
            mimeType: "image/png",
            pageNumber: 1,
            width: 100,
            height: 200
          },
          {
            bytes: bytes("page-two"),
            mimeType: "image/png",
            pageNumber: 2,
            width: 100,
            height: 210
          }
        ]
      }
    });
    const worker = createWorker(fixture, renderer);

    const result = await worker.runOnce();

    expect(result.status).toBe("claimed");
    if (result.status !== "claimed") {
      throw new Error("Expected preview job to be claimed");
    }
    expect(result.job).toMatchObject({
      status: "completed",
      attempts: 1,
      leaseToken: undefined
    });
    expect(renderer.inputs[0]).toMatchObject({
      sourceKind: "document",
      mimeType: fixture.source.mimeType,
      maxPages: 40,
      previewDpi: 144,
      outputFormat: "png"
    });
    const manifest = await fixture.store.getArtifactPreviewManifest({
      clientInstanceId: fixture.clientInstanceId,
      sourceArtifactId: fixture.source.id
    });
    expect(manifest).toMatchObject({
      status: "ready",
      pageCount: 2,
      pages: [
        expect.objectContaining({ mimeType: "image/png", pageNumber: 1, width: 100 }),
        expect.objectContaining({ mimeType: "image/png", pageNumber: 2, height: 210 })
      ]
    });
    expect(JSON.stringify(manifest)).not.toContain("artifact-previews");
    if (!manifest || manifest.status !== "ready") {
      throw new Error("Expected ready preview manifest");
    }
    const pageArtifact = await fixture.store.getManagedArtifact({
      clientInstanceId: fixture.clientInstanceId,
      artifactId: manifest.pages[0]!.artifactId
    });
    expect(pageArtifact).toMatchObject({
      kind: "document.preview_page_image",
      mimeType: "image/png",
      metadata: {
        sourceArtifactId: fixture.source.id,
        previewRole: "page",
        pageNumber: 1,
        rendererVersion: "preview-contract-v1"
      }
    });
    expect(fixture.objectStore.keys().some((key) => key.startsWith("artifact-previews/"))).toBe(true);
  });

  it("removes staged preview objects when deletion wins before guarded completion", async () => {
    const fixture = await createWorkerFixture();
    const renderer = new FakeRenderer({
      result: {
        format: "png",
        pages: [{ bytes: bytes("page-one"), mimeType: "image/png", pageNumber: 1 }]
      }
    });
    let deletionRan = false;
    fixture.objectStore.onPut = async (key) => {
      if (!deletionRan && key.startsWith("artifact-previews/")) {
        deletionRan = true;
        await fixture.store.markConversationManagedObjectsDeleted({
          clientInstanceId: fixture.clientInstanceId,
          conversationId: fixture.conversation.id,
          deletedAt: "2026-07-01T10:02:00.000Z"
        });
      }
    };
    const worker = createWorker(fixture, renderer);

    const result = await worker.runOnce();

    expect(result.status).toBe("stale");
    expect(deletionRan).toBe(true);
    expect(fixture.objectStore.keys().filter((key) => key.startsWith("artifact-previews/"))).toEqual(
      []
    );
    await expect(
      fixture.store.getArtifactPreviewManifest({
        clientInstanceId: fixture.clientInstanceId,
        sourceArtifactId: fixture.source.id
      })
    ).resolves.toBeUndefined();
    await expect(
      fixture.store.listManagedArtifactsForFile({
        clientInstanceId: fixture.clientInstanceId,
        conversationId: fixture.conversation.id,
        fileId: fixture.sourceFile.id,
        kind: "document.preview_page_image"
      })
    ).resolves.toEqual([]);
  });

  it("renders queued PDF page jobs into managed preview image artifacts and a ready manifest", async () => {
    const fixture = await createWorkerFixture({
      kind: "document.pdf",
      filename: "report.pdf",
      mimeType: "application/pdf"
    });
    const renderer = new FakeRenderer({
      result: {
        format: "png",
        pages: [
          {
            bytes: bytes("pdf-page-two"),
            mimeType: "image/png",
            pageNumber: 2,
            width: 800,
            height: 1000
          }
        ]
      }
    });
    const worker = createWorker(fixture, renderer);

    const result = await worker.runOnce();

    expect(result.status).toBe("claimed");
    if (result.status !== "claimed") {
      throw new Error("Expected preview job to be claimed");
    }
    expect(renderer.inputs[0]).toMatchObject({
      sourceKind: "pdf",
      mimeType: "application/pdf"
    });
    expect(result.job).toMatchObject({
      status: "completed",
      errorCode: undefined
    });
    const manifest = await fixture.store.getArtifactPreviewManifest({
      clientInstanceId: fixture.clientInstanceId,
      sourceArtifactId: fixture.source.id
    });
    expect(manifest).toMatchObject({
      status: "ready",
      pageCount: 1,
      pages: [
        expect.objectContaining({
          mimeType: "image/png",
          pageNumber: 2,
          width: 800,
          height: 1000
        })
      ]
    });
    if (!manifest || manifest.status !== "ready") {
      throw new Error("Expected ready PDF preview manifest");
    }
    const pageArtifact = await fixture.store.getManagedArtifact({
      clientInstanceId: fixture.clientInstanceId,
      artifactId: manifest.pages[0]!.artifactId
    });
    expect(pageArtifact).toMatchObject({
      kind: "document.preview_page_image",
      filename: "report-page-1.png",
      metadata: {
        sourceArtifactId: fixture.source.id,
        previewRole: "page",
        pageNumber: 2,
        rendererVersion: "preview-contract-v1"
      }
    });
  });

  it("renders queued spreadsheet sheet and range jobs into internal preview artifacts", async () => {
    const fixture = await createWorkerFixture({
      kind: "spreadsheet.xlsx",
      filename: "sheet.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      settingsHash: createArtifactPreviewSettingsHash({
        sheets: ["Summary"],
        ranges: ["Summary!A1:H10"],
        maxImages: 1
      })
    });
    const renderer = new FakeRenderer({
      result: {
        format: "png",
        pages: [
          {
            bytes: bytes("xlsx-range"),
            mimeType: "image/png",
            sheet: "Summary",
            range: "Summary!A1:H10",
            width: 900,
            height: 520
          }
        ]
      }
    });
    const worker = createWorker(fixture, renderer);

    const result = await worker.runOnce();

    expect(result.status).toBe("claimed");
    if (result.status !== "claimed") {
      throw new Error("Expected preview job to be claimed");
    }
    expect(renderer.inputs[0]).toMatchObject({
      sourceKind: "spreadsheet",
      sheets: ["Summary"],
      ranges: ["Summary!A1:H10"],
      maxPages: 1
    });
    expect(result.job).toMatchObject({
      status: "completed",
      errorCode: undefined,
      leaseToken: undefined
    });
    const manifest = await fixture.store.getArtifactPreviewManifest({
      clientInstanceId: fixture.clientInstanceId,
      sourceArtifactId: fixture.source.id
    });
    expect(manifest).toMatchObject({
      status: "ready",
      pageCount: 1,
      pages: [
        expect.objectContaining({
          mimeType: "image/png",
          sheet: "Summary",
          range: "Summary!A1:H10",
          width: 900,
          height: 520
        })
      ]
    });
    if (!manifest || manifest.status !== "ready") {
      throw new Error("Expected ready spreadsheet preview manifest");
    }
    const pageArtifact = await fixture.store.getManagedArtifact({
      clientInstanceId: fixture.clientInstanceId,
      artifactId: manifest.pages[0]!.artifactId
    });
    expect(pageArtifact).toMatchObject({
      kind: "spreadsheet.preview_range_image",
      metadata: {
        sourceArtifactId: fixture.source.id,
        previewRole: "range",
        sheet: "Summary",
        range: "Summary!A1:H10",
        rendererVersion: "preview-contract-v1"
      }
    });
  });

  it("renders selected spreadsheet ranges with production pixels", async () => {
    if (!hasPreviewRendererDependencies()) {
      return;
    }
    const renderer = new LibreOfficeArtifactPreviewRenderer();
    const sourceBytes = createDistinctWorkbookBytes();
    const input = {
      sourceKind: "spreadsheet" as const,
      filename: "preview.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: sourceBytes,
      maxPages: 1,
      previewDpi: 96,
      outputFormat: "png" as const,
      conversionTimeoutMs: 60000,
      rasterizationTimeoutMs: 60000
    };

    const summary = await renderer.render({
      ...input,
      ranges: ["Summary!A1:B4"]
    });
    const detail = await renderer.render({
      ...input,
      ranges: ["Detail!A1:B4"]
    });

    expect(summary.pages).toHaveLength(1);
    expect(detail.pages).toHaveLength(1);
    expect(summary.pages[0]).toMatchObject({
      mimeType: "image/png",
      sheet: "Summary",
      range: "Summary!A1:B4"
    });
    expect(detail.pages[0]).toMatchObject({
      mimeType: "image/png",
      sheet: "Detail",
      range: "Detail!A1:B4"
    });
    expect(imageDigest(summary.pages[0]!.bytes)).not.toBe(imageDigest(detail.pages[0]!.bytes));
  });

  it("fails without retrying when the source artifact exceeds the size limit", async () => {
    const fixture = await createWorkerFixture({ byteSize: 6, sourceBytes: bytes("small") });
    const worker = createWorker(fixture, new FakeRenderer({ result: emptyRenderResult() }), {
      maxSourceBytes: 5
    });

    const result = await worker.runOnce();

    expect(result.status).toBe("claimed");
    if (result.status !== "claimed") {
      throw new Error("Expected preview job to be claimed");
    }
    expect(result.job).toMatchObject({
      status: "failed",
      attempts: 1,
      errorCode: "source_too_large"
    });
    await expect(
      fixture.store.getArtifactPreviewManifest({
        clientInstanceId: fixture.clientInstanceId,
        sourceArtifactId: fixture.source.id
      })
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "source_too_large"
    });
  });

  it("retries renderer failures until the configured attempt limit then writes a failed manifest", async () => {
    const fixture = await createWorkerFixture();
    const renderer = new FakeRenderer({
      failure: { code: "conversion_failed", retryable: true }
    });
    const worker = createWorker(fixture, renderer, { maxAttempts: 2 });

    const first = await worker.runOnce();
    expect(first.status).toBe("claimed");
    if (first.status !== "claimed") {
      throw new Error("Expected first preview job attempt");
    }
    expect(first.job).toMatchObject({
      status: "pending",
      attempts: 1,
      errorCode: "conversion_failed",
      leaseToken: undefined
    });
    await expect(
      fixture.store.getArtifactPreviewManifest({
        clientInstanceId: fixture.clientInstanceId,
        sourceArtifactId: fixture.source.id
      })
    ).resolves.toBeUndefined();

    const second = await worker.runOnce();
    expect(second.status).toBe("claimed");
    if (second.status !== "claimed") {
      throw new Error("Expected second preview job attempt");
    }
    expect(second.job).toMatchObject({
      status: "failed",
      attempts: 2,
      errorCode: "conversion_failed",
      leaseToken: undefined
    });
    await expect(
      fixture.store.getArtifactPreviewManifest({
        clientInstanceId: fixture.clientInstanceId,
        sourceArtifactId: fixture.source.id
      })
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "conversion_failed"
    });
  });

  it("waits for active rendering when stopped without cancellation", async () => {
    const fixture = await createWorkerFixture();
    const deferred = createDeferred<ArtifactPreviewRenderResult>();
    const renderer = new FakeRenderer({ deferred });
    const worker = createWorker(fixture, renderer, { pollIntervalMs: 5 });

    const loop = worker.start();
    await renderer.called;
    const stop = worker.stop();
    const stoppedEarly = await Promise.race([stop.then(() => true), sleep(30).then(() => false)]);
    expect(stoppedEarly).toBe(false);

    deferred.resolve({
      format: "png",
      pages: [{ bytes: bytes("page-one"), mimeType: "image/png", pageNumber: 1 }]
    });
    await stop;
    await loop;

    await expect(
      fixture.store.getArtifactPreviewManifest({
        clientInstanceId: fixture.clientInstanceId,
        sourceArtifactId: fixture.source.id
      })
    ).resolves.toMatchObject({ status: "ready" });
  });
});

function createWorker(
  fixture: WorkerFixture,
  renderer: ArtifactPreviewRenderer,
  options: Partial<ArtifactPreviewWorkerOptions> = {}
): ArtifactPreviewWorker {
  return new ArtifactPreviewWorker({
    clientInstanceId: fixture.clientInstanceId,
    store: fixture.store,
    objectStore: fixture.objectStore,
    renderer,
    workerId: "artifact-preview-test-worker",
    ...options
  });
}

async function createWorkerFixture(input: {
  kind?: string;
  filename?: string;
  mimeType?: string;
  byteSize?: number;
  sourceBytes?: Uint8Array;
  settingsHash?: string;
} = {}): Promise<WorkerFixture> {
  const clientInstanceId = asClientInstanceId(`preview_worker_${globalThis.crypto.randomUUID()}`);
  const store = new InMemoryPlatformStore();
  const objectStore = new MemoryObjectStorage();
  const conversation = await store.createConversation({
    clientInstanceId,
    ownerUserId: "user-1",
    ownerExternalUserId: "user-1",
    title: "Preview worker",
    retainedUntil: "2030-01-01T00:00:00.000Z"
  });
  const sourceBytes = input.sourceBytes ?? bytes("source-docx");
  const sourceObjectKey = `execution-workspaces/${clientInstanceId}/${conversation.id}/source.docx`;
  const sourceFile = await store.createManagedFile({
    clientInstanceId,
    ownerUserId: "user-1",
    filename: input.filename ?? "report.docx",
    mimeType:
      input.mimeType ?? "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    byteSize: input.byteSize ?? sourceBytes.byteLength,
    checksum: "sha256:source-docx",
    objectKey: sourceObjectKey
  });
  const source = await store.createManagedArtifact({
    clientInstanceId,
    conversationId: conversation.id,
    sourceFileId: sourceFile.id,
    kind: input.kind ?? "document.docx",
    objectKey: sourceObjectKey,
    filename: input.filename ?? "report.docx",
    mimeType:
      input.mimeType ?? "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    byteSize: input.byteSize ?? sourceBytes.byteLength,
    checksum: "sha256:source-docx"
  });
  await objectStore.putObject({
    key: source.objectKey,
    body: sourceBytes,
    contentType: source.mimeType
  });
  await store.enqueueArtifactPreviewJob({
    clientInstanceId,
    conversationId: conversation.id,
    sourceArtifactId: source.id,
    sourceChecksum: source.checksum,
    sourceMimeType: source.mimeType,
    ...(input.settingsHash ? { settingsHash: input.settingsHash } : {}),
    queuedAt: "2026-07-01T10:00:00.000Z"
  });
  return { clientInstanceId, store, objectStore, conversation, sourceFile, source };
}

interface WorkerFixture {
  clientInstanceId: ClientInstanceId;
  store: InMemoryPlatformStore;
  objectStore: MemoryObjectStorage;
  conversation: Conversation;
  sourceFile: ManagedFileRecord;
  source: ManagedArtifactRecord;
}

class FakeRenderer implements ArtifactPreviewRenderer {
  readonly inputs: ArtifactPreviewRenderInput[] = [];
  readonly called: Promise<void>;
  private resolveCalled!: () => void;

  constructor(
    private readonly behavior: {
      result?: ArtifactPreviewRenderResult;
      failure?: { code: ArtifactPreviewFailureCode; retryable: boolean };
      deferred?: ReturnType<typeof createDeferred<ArtifactPreviewRenderResult>>;
    }
  ) {
    this.called = new Promise((resolve) => {
      this.resolveCalled = resolve;
    });
  }

  async render(input: ArtifactPreviewRenderInput): Promise<ArtifactPreviewRenderResult> {
    this.inputs.push(input);
    this.resolveCalled();
    if (this.behavior.failure) {
      throw this.behavior.failure;
    }
    if (this.behavior.deferred) {
      return this.behavior.deferred.promise;
    }
    return this.behavior.result ?? emptyRenderResult();
  }
}

class MemoryObjectStorage implements DeletableWorkspaceObjectStorage {
  private readonly objects = new Map<string, Uint8Array>();
  onPut?: (key: string) => Promise<void> | void;

  async putObject(input: { key: string; body: Uint8Array; contentType?: string }): Promise<void> {
    this.objects.set(input.key, input.body);
    await this.onPut?.(input.key);
    void input.contentType;
  }

  async getObject(key: string): Promise<Uint8Array> {
    const value = this.objects.get(key);
    if (!value) {
      throw new Error(`Missing object ${key}`);
    }
    return value;
  }

  keys(): string[] {
    return [...this.objects.keys()];
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

function emptyRenderResult(): ArtifactPreviewRenderResult {
  return { format: "png", pages: [] };
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function createDistinctWorkbookBytes(): Uint8Array {
  const workbook = XLSX.utils.book_new();
  const summary = XLSX.utils.aoa_to_sheet([
    ["SUMMARY ONLY", "alpha"],
    ["Revenue", 1200],
    ["Cost", 800],
    ["Status", "green"]
  ]);
  const detail = XLSX.utils.aoa_to_sheet([
    ["DETAIL ONLY", "omega"],
    ["Tickets", 42],
    ["Latency", 315],
    ["Status", "red"]
  ]);
  summary["!cols"] = [{ wch: 18 }, { wch: 14 }];
  detail["!cols"] = [{ wch: 18 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(workbook, summary, "Summary");
  XLSX.utils.book_append_sheet(workbook, detail, "Detail");
  const output = XLSX.write(workbook, {
    bookType: "xlsx",
    type: "buffer"
  }) as Uint8Array | string;
  return typeof output === "string" ? Buffer.from(output, "binary") : output;
}

function hasPreviewRendererDependencies(): boolean {
  return ["soffice", "pdfinfo", "pdftoppm"].every((command) => {
    const result = spawnSync("sh", ["-lc", `command -v ${command}`], {
      stdio: "ignore"
    });
    return result.status === 0;
  });
}

function imageDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
