import type { ArtifactPreviewJobRecord, JobId, JobWorker, Logger } from "@vivd-catalyst/core";
import { createPostgresJobWorker, type PostgresStores } from "@vivd-catalyst/postgres-store";
import { withTestSql as withSql } from "./support/test-sql";
import {
  createTestInstance,
  createTestInstanceWith,
  type TestStore
} from "./support/test-instance";
import { asCaller, createCallerAuthAdapter } from "./support/route-callers";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import * as XLSX from "../packages/tool-execution/node_modules/xlsx";
import {
  type ArtifactPreviewRenderInput,
  type ArtifactPreviewRenderResult,
  type ArtifactPreviewRenderer,
  type ArtifactPreviewJobHandlerOptions,
  createArtifactPreviewJobHandler,
  LibreOfficeArtifactPreviewRenderer,
  SPREADSHEET_PREVIEW_MAX_CELLS,
  createArtifactPreviewSettingsHash
} from "@vivd-catalyst/tool-execution";

import {
  ARTIFACT_PREVIEW_MAX_PAGES,
  type ArtifactPreviewFailureCode,
  type ClientInstanceId,
  type Conversation,
  type ManagedArtifactRecord,
  type ManagedFileRecord,
  StoreBackedAuditRecorder,
  asClientInstanceId
} from "@vivd-catalyst/core";

const workers: JobWorker[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
});

describe("the artifact preview job handler", () => {
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
      maxPages: 80,
      previewDpi: 144,
      outputFormat: "png"
    });
    const manifest = await fixture.store.files.getArtifactPreviewManifest({
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
    const pageArtifact = await fixture.store.files.getManagedArtifact({
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
        rendererVersion: "preview-contract-v2"
      }
    });
    expect(fixture.objectStore.keys().some((key) => key.startsWith("artifact-previews/"))).toBe(
      true
    );
  });

  it("reads attachment-backed preview sources through the configured managed-object reader", async () => {
    const fixture = await createWorkerFixture();
    await fixture.objectStore.delete(fixture.source.objectKey);
    const renderer = new FakeRenderer({
      result: {
        format: "png",
        pages: [{ bytes: bytes("page-one"), mimeType: "image/png", pageNumber: 1 }]
      }
    });
    const sourceReaderCalls: string[] = [];
    const worker = createWorker(fixture, renderer, {
      sourceReader: {
        async readArtifact(input) {
          sourceReaderCalls.push(input.artifactId);
          return { bytes: bytes("attachment-backed-docx") };
        }
      }
    });

    const result = await worker.runOnce();

    expect(result).toMatchObject({ status: "claimed", job: { status: "completed" } });
    expect(sourceReaderCalls).toEqual([fixture.source.id]);
    expect(renderer.inputs[0]?.bytes).toEqual(bytes("attachment-backed-docx"));
  });

  it("copies the job's lease onto the row and extends it with each heartbeat", async () => {
    const fixture = await createWorkerFixture();
    const deferred = createDeferred<ArtifactPreviewRenderResult>();
    const renderer = new FakeRenderer({ deferred });
    const worker = createWorker(fixture, renderer);

    const running = worker.runOnce();
    await renderer.called;
    const claimed = await readPreviewJob(fixture);
    const [job] = await platformJobs(fixture);
    // Mirror: a worker of the previous release sees the row as held, under the job's token.
    expect(claimed).toMatchObject({
      status: "processing",
      attempts: 1,
      leaseOwnerId: `job:${job?.id}`,
      leaseToken: job?.lease_token
    });
    expect(claimed?.leaseExpiresAt).toBeDefined();

    // What the executor does at each heartbeat, in the heartbeat's own transaction.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fixture.store.transaction((stores) =>
      worker.handler.bind(jobFor(fixture, job)).onHeartbeat!(
        { leaseToken: job?.lease_token ?? "" },
        stores
      )
    );
    const renewed = await readPreviewJob(fixture);
    expect(renewed!.leaseExpiresAt! > claimed!.leaseExpiresAt!).toBe(true);

    deferred.resolve({
      format: "png",
      pages: [{ bytes: bytes("page-one"), mimeType: "image/png", pageNumber: 1 }]
    });
    await expect(running).resolves.toMatchObject({
      status: "claimed",
      job: { status: "completed", leaseToken: undefined }
    });
  });

  it("records the full page count when only a bounded partial preview is rendered", async () => {
    const fixture = await createWorkerFixture();
    const worker = createWorker(
      fixture,
      new FakeRenderer({
        result: {
          format: "png",
          pageCount: 350,
          pages: [
            { bytes: bytes("page-one"), mimeType: "image/png", pageNumber: 1 },
            { bytes: bytes("page-two"), mimeType: "image/png", pageNumber: 2 }
          ]
        }
      })
    );

    await worker.runOnce();

    await expect(
      fixture.store.files.getArtifactPreviewManifest({
        clientInstanceId: fixture.clientInstanceId,
        sourceArtifactId: fixture.source.id
      })
    ).resolves.toMatchObject({
      status: "ready",
      pageCount: 350,
      pages: [{ pageNumber: 1 }, { pageNumber: 2 }]
    });
  });

  it("reads attachment-backed preview sources through the configured managed-object reader", async () => {
    const fixture = await createWorkerFixture();
    await fixture.objectStore.delete(fixture.source.objectKey);
    const renderer = new FakeRenderer({
      result: {
        format: "png",
        pages: [{ bytes: bytes("page-one"), mimeType: "image/png", pageNumber: 1 }]
      }
    });
    const sourceReaderCalls: string[] = [];
    const worker = createWorker(fixture, renderer, {
      sourceReader: {
        async readArtifact(input) {
          sourceReaderCalls.push(input.artifactId);
          return { bytes: bytes("attachment-backed-docx") };
        }
      }
    });

    const result = await worker.runOnce();

    expect(result).toMatchObject({ status: "claimed", job: { status: "completed" } });
    expect(sourceReaderCalls).toEqual([fixture.source.id]);
    expect(renderer.inputs[0]?.bytes).toEqual(bytes("attachment-backed-docx"));
  });

  it("records the full page count when only a bounded partial preview is rendered", async () => {
    const fixture = await createWorkerFixture();
    const worker = createWorker(
      fixture,
      new FakeRenderer({
        result: {
          format: "png",
          pageCount: 350,
          pages: [
            { bytes: bytes("page-one"), mimeType: "image/png", pageNumber: 1 },
            { bytes: bytes("page-two"), mimeType: "image/png", pageNumber: 2 }
          ]
        }
      })
    );

    await worker.runOnce();

    await expect(
      fixture.store.files.getArtifactPreviewManifest({
        clientInstanceId: fixture.clientInstanceId,
        sourceArtifactId: fixture.source.id
      })
    ).resolves.toMatchObject({
      status: "ready",
      pageCount: 350,
      pages: [{ pageNumber: 1 }, { pageNumber: 2 }]
    });
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
        await fixture.store.files.markConversationManagedObjectsDeleted({
          clientInstanceId: fixture.clientInstanceId,
          conversationId: fixture.conversation.id,
          deletedAt: "2026-07-01T10:02:00.000Z"
        });
      }
    };
    const worker = createWorker(fixture, renderer);

    const result = await worker.runOnce();

    // The row went with its conversation: the job has nothing left to write and ends.
    expect(result.status).toBe("idle");
    expect(deletionRan).toBe(true);
    expect(await platformJobs(fixture)).toMatchObject([{ status: "succeeded" }]);
    expect(
      fixture.objectStore.keys().filter((key) => key.startsWith("artifact-previews/"))
    ).toEqual([]);
    await expect(
      fixture.store.files.getArtifactPreviewManifest({
        clientInstanceId: fixture.clientInstanceId,
        sourceArtifactId: fixture.source.id
      })
    ).resolves.toBeUndefined();
    await expect(
      fixture.store.files.listManagedArtifactsForFile({
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
    const manifest = await fixture.store.files.getArtifactPreviewManifest({
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
    const pageArtifact = await fixture.store.files.getManagedArtifact({
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
        rendererVersion: "preview-contract-v2"
      }
    });
  });

  it("renders queued spreadsheet sheet and range jobs into internal preview artifacts", async () => {
    const settingsHash = createArtifactPreviewSettingsHash({
      sheets: ["Summary"],
      ranges: ["Summary!A1:H10"],
      maxImages: 1
    });
    const fixture = await createWorkerFixture({
      kind: "spreadsheet.xlsx",
      filename: "sheet.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      settingsHash
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
    const manifest = await fixture.store.files.getArtifactPreviewManifest({
      clientInstanceId: fixture.clientInstanceId,
      sourceArtifactId: fixture.source.id,
      settingsHash
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
    const pageArtifact = await fixture.store.files.getManagedArtifact({
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
        rendererVersion: "preview-contract-v2"
      }
    });
  });

  it("reports a conversion failure for a missing spreadsheet sheet", async () => {
    const renderer = new LibreOfficeArtifactPreviewRenderer();

    await expect(
      renderer.render({
        sourceKind: "spreadsheet",
        filename: "preview.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        bytes: createDistinctWorkbookBytes(),
        ranges: ["Missing!A1:B4"],
        maxPages: 1,
        maxConvertedPdfBytes: 1024 * 1024,
        maxOutputBytes: 1024 * 1024,
        maxRasterDimension: 4096,
        previewDpi: 96,
        outputFormat: "png",
        conversionTimeoutMs: 60_000,
        rasterizationTimeoutMs: 60_000
      })
    ).rejects.toEqual({ code: "conversion_failed", retryable: false });
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
      maxConvertedPdfBytes: 1024 * 1024,
      maxOutputBytes: 1024 * 1024,
      maxRasterDimension: 4096,
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
  }, 30000);

  it("previews a sheet of 20,000 cells and one at the limit of 50,000 cells", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-preview-renderer-cells-"));
    try {
      const commands = await writeFakeRendererCommands(root);
      const renderer = new LibreOfficeArtifactPreviewRenderer({
        tempRootDirectory: join(root, "tmp"),
        ...commands.options
      });

      for (const rows of [2_000, 5_000]) {
        const result = await renderer.render({
          ...spreadsheetRenderInput(createGridWorkbookBytes(rows, 10)),
          sheets: ["Grid"]
        });

        expect(result.pages).toEqual([
          expect.objectContaining({ mimeType: "image/png", sheet: "Grid", width: 1, height: 1 })
        ]);
        // The whole used range reaches the converter, not a cut-down part of it.
        const converted = XLSX.read(await readFile(commands.convertedSourcePath), {
          type: "buffer"
        });
        expect(converted.Sheets.Grid?.["!ref"]).toBe(`A1:J${rows}`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses a sheet above 50,000 cells and names the limit", async () => {
    expect(SPREADSHEET_PREVIEW_MAX_CELLS).toBe(50_000);
    const renderer = new LibreOfficeArtifactPreviewRenderer();
    const input = spreadsheetRenderInput(createGridWorkbookBytes(5_001, 10));

    await expect(renderer.render({ ...input, sheets: ["Grid"] })).rejects.toEqual({
      code: "page_limit_exceeded",
      retryable: false,
      message: "Spreadsheet range of 50010 cells exceeds the preview limit of 50000 cells"
    });
  });

  it("stores the limit a failure names and caps the page setting at the shared ceiling", async () => {
    const fixture = await createWorkerFixture();
    const message = "Spreadsheet range of 50010 cells exceeds the preview limit of 50000 cells";
    const renderer = new FakeRenderer({
      failure: { code: "page_limit_exceeded", retryable: false, message }
    });
    const worker = createWorker(fixture, renderer, { maxPages: ARTIFACT_PREVIEW_MAX_PAGES + 1 });

    const result = await worker.runOnce();

    expect(renderer.inputs[0]?.maxPages).toBe(ARTIFACT_PREVIEW_MAX_PAGES);
    expect(result).toMatchObject({
      status: "claimed",
      job: { status: "failed", errorCode: "page_limit_exceeded", errorMessage: message }
    });
  });

  it("creates the configured renderer temp root before rendering", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-preview-renderer-temp-root-"));
    try {
      const bin = join(root, "bin");
      const missingTempRoot = join(root, "missing", "preview-tmp");
      await mkdir(bin);
      const pdfInfo = join(bin, "fake-pdfinfo");
      const pdfToPpm = join(bin, "fake-pdftoppm");
      await writeExecutable(pdfInfo, `#!/usr/bin/env node\nconsole.log("Pages: 1");\n`);
      await writeExecutable(pdfToPpm, fakePdfToPpmScript());

      const renderer = new LibreOfficeArtifactPreviewRenderer({
        tempRootDirectory: missingTempRoot,
        pdfInfoCommand: pdfInfo,
        pdfToPpmCommand: pdfToPpm
      });
      const result = await renderer.render({
        sourceKind: "pdf",
        filename: "source.pdf",
        mimeType: "application/pdf",
        bytes: bytes("%PDF fake"),
        maxPages: 1,
        maxConvertedPdfBytes: 1024 * 1024,
        maxOutputBytes: 1024 * 1024,
        maxRasterDimension: 4096,
        previewDpi: 96,
        outputFormat: "png",
        conversionTimeoutMs: 1000,
        rasterizationTimeoutMs: 1000
      });

      expect(result.pages).toHaveLength(1);
      expect(result.pages[0]).toMatchObject({
        mimeType: "image/png",
        pageNumber: 1,
        width: 1,
        height: 1
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the preview when the rendition for the model fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-preview-renderer-model-failure-"));
    try {
      const pdfInfo = join(root, "fake-pdfinfo");
      const pdfToPpm = join(root, "fake-pdftoppm");
      await writeExecutable(
        pdfInfo,
        `#!/usr/bin/env node\nconsole.log("Pages: 1\\nPage    1 size: 595 x 842 pts (A4)");\n`
      );
      await writeExecutable(
        pdfToPpm,
        [
          "#!/usr/bin/env node",
          'const fs = require("node:fs");',
          "const args = process.argv.slice(2);",
          'if (args.includes("-jpeg")) {',
          "  process.exit(1);",
          "}",
          `fs.writeFileSync(args.at(-1) + ".png", Buffer.from("${onePixelPngHex()}", "hex"));`,
          ""
        ].join("\n")
      );

      const result = await new LibreOfficeArtifactPreviewRenderer({
        pdfInfoCommand: pdfInfo,
        pdfToPpmCommand: pdfToPpm
      }).render({
        sourceKind: "pdf",
        filename: "source.pdf",
        mimeType: "application/pdf",
        bytes: bytes("%PDF fake"),
        maxPages: 1,
        maxConvertedPdfBytes: 1024 * 1024,
        maxOutputBytes: 1024 * 1024,
        maxRasterDimension: 4096,
        previewDpi: 144,
        outputFormat: "png",
        conversionTimeoutMs: 1000,
        rasterizationTimeoutMs: 1000
      });

      const [page] = result.pages;
      if (!page || result.pages.length !== 1) {
        throw new Error("Expected one rendered page");
      }
      expect(Buffer.from(page.bytes).toString("hex")).toBe(onePixelPngHex());
      expect(page).toMatchObject({ mimeType: "image/png", pageNumber: 1, width: 1, height: 1 });
      expect(page.modelImage).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders each page a second time for the model and leaves the page image as it was", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-preview-renderer-model-image-"));
    try {
      const pdfInfo = join(root, "fake-pdfinfo");
      const pdfToPpm = join(root, "fake-pdftoppm");
      const argumentLog = join(root, "pdftoppm-arguments.log");
      await writeExecutable(
        pdfInfo,
        `#!/usr/bin/env node\nconsole.log("Pages: 1\\nPage    1 size: 595 x 842 pts (A4)");\n`
      );
      await writeExecutable(pdfToPpm, fakePdfToPpmScript(argumentLog));

      const result = await new LibreOfficeArtifactPreviewRenderer({
        pdfInfoCommand: pdfInfo,
        pdfToPpmCommand: pdfToPpm
      }).render({
        sourceKind: "pdf",
        filename: "source.pdf",
        mimeType: "application/pdf",
        bytes: bytes("%PDF fake"),
        maxPages: 1,
        maxConvertedPdfBytes: 1024 * 1024,
        maxOutputBytes: 1024 * 1024,
        maxRasterDimension: 4096,
        previewDpi: 144,
        outputFormat: "png",
        conversionTimeoutMs: 1000,
        rasterizationTimeoutMs: 1000
      });

      const [page] = result.pages;
      if (!page || result.pages.length !== 1) {
        throw new Error("Expected one rendered page");
      }
      expect(Buffer.from(page.bytes).toString("hex")).toBe(onePixelPngHex());
      expect(page).toMatchObject({ mimeType: "image/png", pageNumber: 1, width: 1, height: 1 });
      expect(page.modelImage).toMatchObject({ mimeType: "image/jpeg", width: 1109, height: 1568 });
      const calls = (await readFile(argumentLog, "utf8")).trim().split("\n");
      expect(calls.map((line): unknown => JSON.parse(line))).toEqual([
        ["-png", "-singlefile", "-r", "144", "-scale-to", "4096", "-f", "1", "-l", "1"],
        [
          "-jpeg",
          "-jpegopt",
          "quality=80",
          "-singlefile",
          "-scale-to",
          "1568",
          "-f",
          "1",
          "-l",
          "1"
        ]
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stores the model's rendition beside the page image a person sees", async () => {
    const fixture = await createWorkerFixture();
    const renderer = new FakeRenderer({
      result: {
        format: "png",
        pages: [
          {
            bytes: bytes("page-one-for-a-person"),
            mimeType: "image/png",
            pageNumber: 1,
            width: 2895,
            height: 4096,
            modelImage: {
              bytes: bytes("page-one-for-the-model"),
              mimeType: "image/jpeg",
              width: 1109,
              height: 1568
            }
          }
        ]
      }
    });

    await createWorker(fixture, renderer).runOnce();

    const manifest = await fixture.store.files.getArtifactPreviewManifest({
      clientInstanceId: fixture.clientInstanceId,
      sourceArtifactId: fixture.source.id
    });
    const page = manifest?.status === "ready" ? manifest.pages[0] : undefined;
    if (!page?.modelImage) {
      throw new Error("Expected a ready preview page with a model image");
    }
    expect(page).toMatchObject({ mimeType: "image/png", pageNumber: 1, width: 2895, height: 4096 });
    expect(page.modelImage).toMatchObject({ mimeType: "image/jpeg", width: 1109, height: 1568 });
    const read = async (artifactId: ManagedArtifactRecord["id"]) => {
      const artifact = await fixture.store.files.getManagedArtifact({
        clientInstanceId: fixture.clientInstanceId,
        artifactId
      });
      if (!artifact) {
        throw new Error("Expected a stored preview artifact");
      }
      return { artifact, bytes: fixture.objectStore.bytes(artifact.objectKey) };
    };
    const forPerson = await read(page.artifactId);
    expect(forPerson.bytes).toEqual(bytes("page-one-for-a-person"));
    expect(forPerson.artifact).toMatchObject({
      mimeType: "image/png",
      filename: expect.stringMatching(/\.png$/u)
    });
    expect(forPerson.artifact.metadata).not.toHaveProperty("previewRendition");
    const forModel = await read(page.modelImage.artifactId);
    expect(forModel.bytes).toEqual(bytes("page-one-for-the-model"));
    expect(forModel.artifact).toMatchObject({
      kind: "document.preview_page_image",
      mimeType: "image/jpeg",
      filename: expect.stringMatching(/\.model\.jpg$/u),
      metadata: { sourceArtifactId: fixture.source.id, previewRendition: "model", pageNumber: 1 }
    });
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
      fixture.store.files.getArtifactPreviewManifest({
        clientInstanceId: fixture.clientInstanceId,
        sourceArtifactId: fixture.source.id
      })
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "source_too_large"
    });
  });

  it("fails safely when rendered pages exceed the cumulative output limit", async () => {
    const fixture = await createWorkerFixture();
    const renderer = new FakeRenderer({
      result: {
        format: "png",
        pages: [{ bytes: bytes("too-large"), mimeType: "image/png", pageNumber: 1 }]
      }
    });
    const worker = createWorker(fixture, renderer, { maxOutputBytes: 4 });

    const result = await worker.runOnce();

    expect(result.status).toBe("claimed");
    if (result.status !== "claimed") {
      throw new Error("Expected preview job to be claimed");
    }
    expect(result.job).toMatchObject({
      status: "failed",
      attempts: 1,
      errorCode: "output_too_large"
    });
    expect(fixture.objectStore.keys()).toEqual([fixture.source.objectKey]);
  });

  it("retries a renderer failure once, then fails the row with a manifest and the job is dead", async () => {
    const fixture = await createWorkerFixture();
    const renderer = new FakeRenderer({
      failure: { code: "conversion_failed", retryable: true }
    });
    const worker = createWorker(fixture, renderer);

    const first = await worker.runOnce();
    // The row stays held by the job between its attempts; nothing is final yet.
    expect(first).toMatchObject({ status: "claimed", job: { status: "processing", attempts: 1 } });
    expect(await platformJobs(fixture)).toMatchObject([{ status: "queued", attempts: 1 }]);
    await expect(
      fixture.store.files.getArtifactPreviewManifest({
        clientInstanceId: fixture.clientInstanceId,
        sourceArtifactId: fixture.source.id
      })
    ).resolves.toBeUndefined();

    await makeJobsDue(fixture);
    const second = await worker.runOnce();
    expect(second).toMatchObject({
      status: "claimed",
      job: { status: "failed", attempts: 2, errorCode: "conversion_failed", leaseToken: undefined }
    });
    expect(await platformJobs(fixture)).toMatchObject([{ status: "dead", attempts: 2 }]);
    await expect(
      fixture.store.files.getArtifactPreviewManifest({
        clientInstanceId: fixture.clientInstanceId,
        sourceArtifactId: fixture.source.id
      })
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "conversion_failed"
    });
  });

  it("marks the job failed, not dead, when another attempt cannot help", async () => {
    const fixture = await createWorkerFixture({ byteSize: 6, sourceBytes: bytes("small") });
    const worker = createWorker(fixture, new FakeRenderer({ result: emptyRenderResult() }), {
      maxSourceBytes: 5
    });

    await worker.runOnce();

    expect(await platformJobs(fixture)).toMatchObject([{ status: "failed", attempts: 1 }]);
  });

  it("gives the job back when the worker stops and the next worker finishes the row", async () => {
    const fixture = await createWorkerFixture();
    const renderer = new FakeRenderer({ abortable: true });
    const worker = createWorker(fixture, renderer);

    const running = worker.jobs.runDue();
    await renderer.called;
    await worker.jobs.stop();
    await running;

    // Queued again, due at once, the attempt given back. The row is still held by the job.
    expect(await platformJobs(fixture)).toMatchObject([
      { status: "queued", attempts: 0, due: true }
    ]);
    expect(await readPreviewJob(fixture)).toMatchObject({ status: "processing" });

    const next = createWorker(
      fixture,
      new FakeRenderer({
        result: {
          format: "png",
          pages: [{ bytes: bytes("page-one"), mimeType: "image/png", pageNumber: 1 }]
        }
      })
    );
    // The same job takes its row over at once, without waiting for the lease it left on it.
    await expect(next.runOnce()).resolves.toMatchObject({
      status: "claimed",
      job: { status: "completed" }
    });
    expect(await platformJobs(fixture)).toMatchObject([{ status: "succeeded", attempts: 1 }]);
  });
});

describe("the preview job beside a worker of the previous release", () => {
  const onePage: ArtifactPreviewRenderResult = {
    format: "png",
    pages: [{ bytes: bytes("page-one"), mimeType: "image/png", pageNumber: 1 }]
  };

  it("adopts a row the previous release inserted without a job, once", async () => {
    const fixture = await createWorkerFixture();
    // The previous release's API writes the row and knows nothing of jobs.
    await withSql(
      (sql) => sql`delete from platform_jobs where client_instance_id = ${fixture.clientInstanceId}`
    );
    const adopt = () =>
      fixture.store.files.adoptArtifactPreviewJobs({
        clientInstanceId: fixture.clientInstanceId,
        limit: 10
      });

    await expect(adopt()).resolves.toBe(1);
    // A row with an unfinished job is left alone.
    await expect(adopt()).resolves.toBe(0);
    expect(await platformJobs(fixture)).toMatchObject([{ status: "queued", attempts: 0 }]);

    const worker = createWorker(fixture, new FakeRenderer({ result: onePage }));
    await expect(worker.runOnce()).resolves.toMatchObject({
      status: "claimed",
      job: { status: "completed", attempts: 1 }
    });
    // A finished row is not adopted again.
    await expect(adopt()).resolves.toBe(0);
    expect(await platformJobs(fixture)).toMatchObject([{ status: "succeeded" }]);
  });

  it("does nothing when the previous release's worker finishes the row it holds", async () => {
    const fixture = await createWorkerFixture();
    const legacy = await legacyClaim(fixture, "legacy-worker", "legacy-lease");
    expect(legacy).toBe(fixture.previewJobId);
    const renderer = new FakeRenderer({ result: onePage });
    const worker = createWorker(fixture, renderer, { yieldCheckIntervalMs: 20 });

    const running = worker.jobs.runDue();
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Yield: the job waits while the foreign lease is alive.
    expect(renderer.inputs).toHaveLength(0);
    expect(await platformJobs(fixture)).toMatchObject([{ status: "running" }]);
    expect(await readPreviewJob(fixture)).toMatchObject({
      leaseOwnerId: "legacy-worker",
      attempts: 1
    });

    await fixture.store.files.markClaimedArtifactPreviewJobUnsupported({
      clientInstanceId: fixture.clientInstanceId,
      jobId: fixture.previewJobId,
      leaseToken: "legacy-lease",
      errorCode: "unsupported_type",
      unsupportedAt: new Date().toISOString()
    });
    await running;

    // One result, the previous release's. The job ends without having rendered.
    expect(renderer.inputs).toHaveLength(0);
    expect(await platformJobs(fixture)).toMatchObject([{ status: "succeeded", attempts: 1 }]);
    expect(await readPreviewJob(fixture)).toMatchObject({
      status: "unsupported",
      attempts: 1
    });
  });

  it("finishes a row whose previous-release worker was killed, after that lease expires", async () => {
    const fixture = await createWorkerFixture();
    await legacyClaim(fixture, "legacy-worker", "legacy-lease");
    const renderer = new FakeRenderer({ result: onePage });
    const worker = createWorker(fixture, renderer, { yieldCheckIntervalMs: 20 });

    const running = worker.jobs.runDue();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(renderer.inputs).toHaveLength(0);
    await withSql(
      (sql) => sql`
        update artifact_preview_jobs set lease_expires_at = now() - interval '1 second'
        where id = ${fixture.previewJobId}
      `
    );
    await running;

    expect(renderer.inputs).toHaveLength(1);
    expect(await readPreviewJob(fixture)).toMatchObject({ status: "completed", attempts: 2 });
    expect(await platformJobs(fixture)).toMatchObject([{ status: "succeeded", attempts: 1 }]);
    // The killed worker's token finishes nothing afterwards.
    await expect(
      fixture.store.files.failClaimedArtifactPreviewJob({
        clientInstanceId: fixture.clientInstanceId,
        jobId: fixture.previewJobId,
        leaseToken: "legacy-lease",
        errorCode: "conversion_failed",
        failedAt: new Date().toISOString()
      })
    ).rejects.toThrow();
    expect(await readPreviewJob(fixture)).toMatchObject({ status: "completed" });
  });

  it("keeps the previous release's worker off a row the job holds, and lets it continue after a rollback", async () => {
    const fixture = await createWorkerFixture();
    const deferred = createDeferred<ArtifactPreviewRenderResult>();
    const renderer = new FakeRenderer({ deferred });
    const worker = createWorker(fixture, renderer);

    const running = worker.jobs.runDue();
    await renderer.called;
    // The mirror makes the row look held to the previous release: neither its claim nor its
    // stale-lease recovery touches it.
    await expect(legacyClaim(fixture, "legacy-worker", "legacy-lease")).resolves.toBeUndefined();
    await expect(legacyRecoverStale(fixture)).resolves.toBe(0);

    // The rollback: the new worker is gone mid-attempt and only the previous release runs. Its
    // recovery returns the row to pending once the mirrored lease has run out, and it claims it.
    await withSql(
      (sql) => sql`
        update artifact_preview_jobs set lease_expires_at = now() - interval '1 second'
        where id = ${fixture.previewJobId}
      `
    );
    await expect(legacyRecoverStale(fixture)).resolves.toBe(1);
    await expect(legacyClaim(fixture, "legacy-worker", "legacy-lease")).resolves.toBe(
      fixture.previewJobId
    );

    // The attempt that lost the row writes no second result.
    deferred.resolve(onePage);
    await running;
    expect(await readPreviewJob(fixture)).toMatchObject({
      status: "processing",
      leaseOwnerId: "legacy-worker",
      leaseToken: "legacy-lease"
    });
    await expect(
      fixture.store.files.getArtifactPreviewManifest({
        clientInstanceId: fixture.clientInstanceId,
        sourceArtifactId: fixture.source.id
      })
    ).resolves.toBeUndefined();
  });

  it("fails the row when the worker crashed on the job's last attempt", async () => {
    const fixture = await createWorkerFixture();
    const worker = createWorker(fixture, new FakeRenderer({ result: onePage }));
    // A worker that claimed the last attempt, mirrored its lease and then died.
    await withSql(async (sql) => {
      const [job] = await sql<{ id: string }[]>`
        update platform_jobs
        set status = 'running', attempts = max_attempts, lease_token = 'crashed',
            lease_expires_at = now() - interval '1 second'
        where client_instance_id = ${fixture.clientInstanceId}
        returning id
      `;
      await sql`
        update artifact_preview_jobs
        set status = 'processing', attempts = 2, lease_owner_id = ${`job:${job?.id}`},
            lease_token = 'crashed', lease_expires_at = now() - interval '1 second'
        where id = ${fixture.previewJobId}
      `;
    });

    await worker.jobs.runDue();

    expect(await platformJobs(fixture)).toMatchObject([{ status: "dead", attempts: 2 }]);
    expect(await readPreviewJob(fixture)).toMatchObject({
      status: "failed",
      errorCode: "stale_lease",
      leaseToken: undefined
    });
    await expect(
      fixture.store.files.getArtifactPreviewManifest({
        clientInstanceId: fixture.clientInstanceId,
        sourceArtifactId: fixture.source.id
      })
    ).resolves.toMatchObject({ status: "failed", errorCode: "stale_lease" });
  });

  it("renders the preview after an operator retried the dead job", async () => {
    const server = await createTestInstanceWith((stores) => ({
      authAdapter: createCallerAuthAdapter(),
      auditRecorder: new StoreBackedAuditRecorder({
        clientInstanceId: asClientInstanceId("demo-local"),
        store: stores.audit
      })
    }));
    const fixture = await createWorkerFixture({ server });
    const renderer = new FakeRenderer({ result: onePage });
    const worker = createWorker(fixture, renderer);
    // A worker that claimed the last attempt and died: the job is dead, the row failed.
    await withSql(async (sql) => {
      const [job] = await sql<{ id: string }[]>`
        update platform_jobs
        set status = 'running', attempts = max_attempts, lease_token = 'crashed',
            lease_expires_at = now() - interval '1 second'
        where client_instance_id = ${fixture.clientInstanceId}
        returning id
      `;
      await sql`
        update artifact_preview_jobs
        set status = 'processing', attempts = 2, lease_owner_id = ${`job:${job?.id}`},
            lease_token = 'crashed', lease_expires_at = now() - interval '1 second'
        where id = ${fixture.previewJobId}
      `;
    });
    await worker.jobs.runDue();
    const [dead] = await platformJobs(fixture);
    expect(dead).toMatchObject({ status: "dead" });
    expect(await readPreviewJob(fixture)).toMatchObject({ status: "failed" });
    expect(renderer.inputs).toHaveLength(0);

    const retried = await server.call(
      "instance.jobs.retry",
      { params: { jobId: dead?.id ?? "" } },
      asCaller({ id: "usr_root", roles: ["superadmin"] })
    );

    // The job and its row wait for work again, together.
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ status: "queued", attempts: 0 });
    expect(await readPreviewJob(fixture)).toMatchObject({
      status: "pending",
      attempts: 0,
      errorCode: undefined,
      leaseToken: undefined
    });

    await worker.jobs.runDue();

    expect(renderer.inputs).toHaveLength(1);
    expect(await platformJobs(fixture)).toMatchObject([{ status: "succeeded", attempts: 1 }]);
    expect(await readPreviewJob(fixture)).toMatchObject({ status: "completed" });
    await expect(
      fixture.store.files.getArtifactPreviewManifest({
        clientInstanceId: fixture.clientInstanceId,
        sourceArtifactId: fixture.source.id
      })
    ).resolves.toMatchObject({ status: "ready", pageCount: 1 });
  });
});

/**
 * The claim of the previous release's preview worker, as that release runs it: the oldest
 * pending row, whoever inserted it.
 */
function legacyClaim(
  fixture: WorkerFixture,
  workerId: string,
  leaseToken: string
): Promise<string | undefined> {
  return withSql(async (sql) => {
    const rows = await sql<{ id: string }[]>`
      with candidate as (
        select id
        from artifact_preview_jobs
        where client_instance_id = ${fixture.clientInstanceId}
          and status = 'pending'
          and (next_attempt_at is null or next_attempt_at <= now())
        order by coalesce(next_attempt_at, created_at) asc, created_at asc, id asc
        limit 1
        for update skip locked
      )
      update artifact_preview_jobs apj
      set status = 'processing',
          attempts = apj.attempts + 1,
          next_attempt_at = null,
          lease_owner_id = ${workerId},
          lease_token = ${leaseToken},
          lease_expires_at = now() + interval '5 minutes',
          error_code = null,
          error_message = null,
          updated_at = now()
      from candidate
      where apj.id = candidate.id
      returning apj.id
    `;
    return rows[0]?.id;
  });
}

/** The previous release's stale-lease recovery for a row with attempts left. */
function legacyRecoverStale(fixture: WorkerFixture): Promise<number> {
  return withSql(async (sql) => {
    const rows = await sql`
      update artifact_preview_jobs
      set status = 'pending', next_attempt_at = now(), lease_owner_id = null,
          lease_token = null, lease_expires_at = null, error_code = 'stale_lease'
      where client_instance_id = ${fixture.clientInstanceId}
        and status = 'processing'
        and lease_expires_at is not null
        and lease_expires_at < now()
      returning id
    `;
    return rows.length;
  });
}

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silentLogger
};

interface PlatformJobRow {
  id: JobId;
  status: string;
  attempts: number;
  lease_token: string | null;
  due: boolean;
}

function platformJobs(fixture: WorkerFixture): Promise<PlatformJobRow[]> {
  return withSql(
    (sql) => sql<PlatformJobRow[]>`
      select id, status, attempts, lease_token, run_after <= now() as due
      from platform_jobs
      where client_instance_id = ${fixture.clientInstanceId}
      order by created_at, id
    `
  );
}

/** As if the backoff had passed. */
async function makeJobsDue(fixture: WorkerFixture): Promise<void> {
  await withSql(
    (sql) => sql`
      update platform_jobs set run_after = now()
      where client_instance_id = ${fixture.clientInstanceId} and status = 'queued'
    `
  );
}

function readPreviewJob(fixture: WorkerFixture): Promise<ArtifactPreviewJobRecord | undefined> {
  return fixture.store.files.getArtifactPreviewJob({
    clientInstanceId: fixture.clientInstanceId,
    sourceArtifactId: fixture.source.id,
    ...(fixture.settingsHash ? { settingsHash: fixture.settingsHash } : {})
  });
}

function jobFor(fixture: WorkerFixture, row: PlatformJobRow | undefined) {
  if (!row) throw new Error("Expected a platform job");
  return {
    id: row.id,
    clientInstanceId: fixture.clientInstanceId,
    kind: "artifact_preview.render",
    payload: { previewJobId: fixture.previewJobId },
    status: "running" as const,
    runAfter: new Date().toISOString(),
    attempts: row.attempts,
    maxAttempts: 2,
    correlationId: "corr_test",
    createdAt: new Date().toISOString()
  };
}

/**
 * A job worker that serves the preview kind for the fixture. `runOnce` is one pass of it and
 * answers with the preview row as the pass left it.
 */
function createWorker(
  fixture: WorkerFixture,
  renderer: ArtifactPreviewRenderer,
  options: Partial<ArtifactPreviewJobHandlerOptions> = {}
) {
  const handler = createArtifactPreviewJobHandler({
    stores: fixture.store,
    objectStore: fixture.objectStore,
    renderer,
    ...options
  });
  const jobs = createPostgresJobWorker({
    stores: fixture.store,
    clientInstanceId: fixture.clientInstanceId,
    handlers: [handler],
    logger: silentLogger
  });
  workers.push(jobs);
  return {
    handler,
    jobs,
    async runOnce(): Promise<
      { status: "idle" } | { status: "claimed"; job: ArtifactPreviewJobRecord }
    > {
      await jobs.runDue();
      const job = await readPreviewJob(fixture);
      return job ? { status: "claimed", job } : { status: "idle" };
    }
  };
}

async function createWorkerFixture(
  input: {
    kind?: string;
    filename?: string;
    mimeType?: string;
    byteSize?: number;
    sourceBytes?: Uint8Array;
    settingsHash?: string;
    /** The instance whose API a test calls. Without one the fixture has an id of its own. */
    server?: { stores: TestStore };
  } = {}
): Promise<WorkerFixture> {
  const clientInstanceId = asClientInstanceId(
    input.server ? "demo-local" : `preview_worker_${globalThis.crypto.randomUUID()}`
  );
  const store = (input.server ?? (await createTestInstance())).stores;
  const objectStore = new HookedObjectStorage();
  const conversation = await store.createConversationForTesting({
    clientInstanceId,
    createdByUserId: "user-1",
    createdByExternalUserId: "user-1",
    title: "Preview worker",
    retainedUntil: "2030-01-01T00:00:00.000Z"
  });
  const sourceBytes = input.sourceBytes ?? bytes("source-docx");
  const sourceObjectKey = `execution-workspaces/${clientInstanceId}/${conversation.id}/source.docx`;
  const sourceFile = await store.files.createManagedFile({
    clientInstanceId,
    ownerUserId: "user-1",
    filename: input.filename ?? "report.docx",
    mimeType:
      input.mimeType ?? "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    byteSize: input.byteSize ?? sourceBytes.byteLength,
    checksum: "sha256:source-docx",
    objectKey: sourceObjectKey
  });
  const source = await store.files.createManagedArtifact({
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
  await objectStore.put(source.objectKey, sourceBytes, { contentType: source.mimeType });
  const previewJob = await store.files.enqueueArtifactPreviewJob({
    clientInstanceId,
    conversationId: conversation.id,
    sourceArtifactId: source.id,
    sourceChecksum: source.checksum,
    sourceMimeType: source.mimeType,
    ...(input.settingsHash ? { settingsHash: input.settingsHash } : {}),
    queuedAt: "2026-07-01T10:00:00.000Z"
  });
  return {
    clientInstanceId,
    store,
    objectStore,
    conversation,
    sourceFile,
    source,
    previewJobId: previewJob.id,
    settingsHash: input.settingsHash
  };
}

interface WorkerFixture {
  clientInstanceId: ClientInstanceId;
  store: PostgresStores;
  objectStore: HookedObjectStorage;
  conversation: Conversation;
  sourceFile: ManagedFileRecord;
  source: ManagedArtifactRecord;
  previewJobId: string;
  settingsHash?: string;
}

class FakeRenderer implements ArtifactPreviewRenderer {
  readonly inputs: ArtifactPreviewRenderInput[] = [];
  readonly called: Promise<void>;
  private resolveCalled!: () => void;

  constructor(
    private readonly behavior: {
      result?: ArtifactPreviewRenderResult;
      failure?: { code: ArtifactPreviewFailureCode; retryable: boolean; message?: string };
      deferred?: ReturnType<typeof createDeferred<ArtifactPreviewRenderResult>>;
      /** Renders until the attempt is aborted, as the real renderer does. */
      abortable?: boolean;
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
    if (this.behavior.abortable) {
      const signal = input.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("render aborted")));
      });
    }
    return this.behavior.result ?? emptyRenderResult();
  }
}

/** The store in memory with a hook that runs after each write. */
class HookedObjectStorage extends MemoryObjectStorage {
  onPut?: (key: string) => Promise<void> | void;

  override async put(...input: Parameters<MemoryObjectStorage["put"]>): Promise<void> {
    await super.put(...input);
    await this.onPut?.(input[0]);
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
  return workbookBytes(workbook);
}

function workbookBytes(workbook: XLSX.WorkBook): Uint8Array {
  const output = XLSX.write(workbook, {
    bookType: "xlsx",
    type: "buffer"
  }) as Uint8Array | string;
  return typeof output === "string" ? Buffer.from(output, "binary") : output;
}

function createGridWorkbookBytes(rows: number, columns: number): Uint8Array {
  const workbook = XLSX.utils.book_new();
  const grid = XLSX.utils.aoa_to_sheet(
    Array.from({ length: rows }, (_, row) =>
      Array.from({ length: columns }, (_, column) => row * columns + column)
    )
  );
  XLSX.utils.book_append_sheet(workbook, grid, "Grid");
  return workbookBytes(workbook);
}

function spreadsheetRenderInput(sourceBytes: Uint8Array): ArtifactPreviewRenderInput {
  return {
    sourceKind: "spreadsheet",
    filename: "grid.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bytes: sourceBytes,
    maxPages: 1,
    maxConvertedPdfBytes: 1024 * 1024,
    maxOutputBytes: 1024 * 1024,
    maxRasterDimension: 4096,
    previewDpi: 96,
    outputFormat: "png",
    conversionTimeoutMs: 60_000,
    rasterizationTimeoutMs: 60_000
  };
}

/** Stand-ins for the native tools. The converter keeps a copy of the workbook it was handed. */
async function writeFakeRendererCommands(root: string): Promise<{
  convertedSourcePath: string;
  options: { sofficeCommand: string; pdfInfoCommand: string; pdfToPpmCommand: string };
}> {
  const bin = join(root, "bin");
  await mkdir(bin);
  const convertedSourcePath = join(root, "converted-source.xlsx");
  const options = {
    sofficeCommand: join(bin, "fake-soffice"),
    pdfInfoCommand: join(bin, "fake-pdfinfo"),
    pdfToPpmCommand: join(bin, "fake-pdftoppm")
  };
  await writeExecutable(
    options.sofficeCommand,
    `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst args = process.argv.slice(2);\nconst source = args[args.length - 1];\nconst outdir = args[args.indexOf("--outdir") + 1];\nfs.copyFileSync(source, ${JSON.stringify(convertedSourcePath)});\nfs.writeFileSync(path.join(outdir, path.basename(source, path.extname(source)) + ".pdf"), "%PDF-1.4");\n`
  );
  await writeExecutable(options.pdfInfoCommand, `#!/usr/bin/env node\nconsole.log("Pages: 1");\n`);
  await writeExecutable(options.pdfToPpmCommand, fakePdfToPpmScript());
  return { convertedSourcePath, options };
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

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
}

/**
 * Stands in for pdftoppm: a one-pixel PNG, or for a JPEG call a frame header of 1109 by 1568
 * pixels. With a log path it appends the arguments of each call as one JSON line.
 */
function fakePdfToPpmScript(argumentLogPath?: string): string {
  return [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    "const args = process.argv.slice(2);",
    ...(argumentLogPath
      ? [
          `fs.appendFileSync(${JSON.stringify(argumentLogPath)}, JSON.stringify(args.slice(0, -2)) + "\\n");`
        ]
      : []),
    'if (args.includes("-jpeg")) {',
    `  fs.writeFileSync(args.at(-1) + ".jpg", Buffer.from("${modelJpegHex()}", "hex"));`,
    "} else {",
    `  fs.writeFileSync(args.at(-1) + ".png", Buffer.from("${onePixelPngHex()}", "hex"));`,
    "}",
    ""
  ].join("\n");
}

function modelJpegHex(): string {
  // Start of image, a baseline frame header (height 0x0620, width 0x0455, three components), end.
  return [
    "ffd8",
    "ffc0",
    "0011",
    "08",
    "0620",
    "0455",
    "03",
    "012200",
    "021101",
    "031101",
    "ffd9"
  ].join("");
}

function onePixelPngHex(): string {
  return [
    "89504e470d0a1a0a",
    "0000000d49484452",
    "0000000100000001",
    "08060000001f15c489",
    "0000000049454e44",
    "ae426082"
  ].join("");
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
