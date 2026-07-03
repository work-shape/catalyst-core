import { describe, expect, it } from "vitest";
import { asManagedArtifactId } from "@vivd-catalyst/core";
import { createArtifactPreviewSettingsHash } from "@vivd-catalyst/tool-execution";
import { createModelVisibleToolOutput } from "../packages/agent-runtime/src/model-context-projection";
import { createWorkspaceHarness, encode } from "./workspace-tools-harness";

describe("workspace.preview_images", () => {
  it("loads ready preview images as model-visible artifacts without exposing internal storage", async () => {
    const harness = await createWorkspaceHarness();
    const source = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "document.pdf",
      objectKey: "execution-workspaces/private/report.pdf",
      filename: "report.pdf",
      mimeType: "application/pdf",
      byteSize: 128,
      checksum: "sha256:report"
    });
    const previewBytes = encode("page-1-png");
    const settingsHash = createArtifactPreviewSettingsHash({ pages: [1], maxImages: 1 });
    harness.objectStore.putObject("artifact-previews/private/report-page-1.png", previewBytes);
    const previewPage = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "document.preview_page_image",
      objectKey: "artifact-previews/private/report-page-1.png",
      filename: "report-page-1.png",
      mimeType: "image/png",
      byteSize: previewBytes.byteLength,
      checksum: "sha256:preview-page-1",
      metadata: {
        sourceArtifactId: source.id,
        previewRole: "page",
        pageNumber: 1
      }
    });
    await harness.store.writeArtifactPreviewManifest({
      status: "ready",
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      sourceArtifactId: source.id,
      settingsHash,
      type: "image_pages",
      format: "png",
      pages: [
        {
          artifactId: previewPage.id,
          mimeType: "image/png",
          pageNumber: 1,
          width: 640,
          height: 480
        }
      ],
      writtenAt: "2026-06-29T12:02:00.000Z"
    });

    const result = await harness.runTool("workspace.preview_images", {
      artifactId: source.id,
      pages: [1],
      maxImages: 1
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected preview_images to succeed");
    }
    expect(result.output).toEqual({
      artifactId: source.id,
      status: "ready",
      maxImages: 1,
      images: [
        {
          sourceArtifactId: source.id,
          imageArtifactId: previewPage.id,
          mimeType: "image/png",
          status: "ready",
          pageNumber: 1,
          width: 640,
          height: 480
        }
      ],
      warnings: []
    });
    expect(result.artifacts).toEqual([
      {
        artifactId: previewPage.id,
        kind: "document.preview_page_image",
        filename: "report-page-1.png",
        mimeType: "image/png",
        modelVisibility: {
          type: "image",
          mimeType: "image/png"
        },
        metadata: {
          sourceArtifactId: source.id,
          status: "ready",
          pageNumber: 1,
          width: 640,
          height: 480
        }
      }
    ]);
    expect(JSON.stringify(result)).not.toContain("objectKey");
    expect(JSON.stringify(result)).not.toContain("artifact-previews/private");

    const modelOutput = await createModelVisibleToolOutput(result, {
      clientInstanceId: harness.clientInstanceId,
      toolOutput: { maxTokens: 60_000 },
      artifactReader: {
        async readArtifact(input) {
          const artifact = await harness.store.getManagedArtifact({
            clientInstanceId: input.clientInstanceId,
            artifactId: input.artifactId
          });
          if (!artifact) {
            throw new Error("Missing artifact");
          }
          return {
            bytes: await harness.objectStore.getObject(artifact.objectKey),
            mimeType: artifact.mimeType
          };
        }
      }
    });
    expect(Array.isArray(modelOutput.content)).toBe(true);
    const imageParts = Array.isArray(modelOutput.content)
      ? modelOutput.content.filter((part) => part.type === "image")
      : [];
    expect(imageParts).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        data: previewBytes
      }
    ]);
    expect(modelOutput.text).toContain("[Visual context loaded]");
    expect(modelOutput.text).toContain("page: 1");
    expect(modelOutput.text).toContain("size: 640x480");
  });

  it("loads ready spreadsheet sheet and range previews as model-visible artifacts", async () => {
    const harness = await createWorkspaceHarness();
    const source = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "spreadsheet.xlsx",
      objectKey: "execution-workspaces/private/workbook.xlsx",
      filename: "workbook.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      byteSize: 128,
      checksum: "sha256:workbook"
    });
    const previewBytes = encode("summary-range-png");
    const settingsHash = createArtifactPreviewSettingsHash({
      sheets: ["Summary"],
      ranges: ["Summary!A1:H10"],
      maxImages: 1
    });
    harness.objectStore.putObject("artifact-previews/private/workbook-summary-range.png", previewBytes);
    const previewRange = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "spreadsheet.preview_range_image",
      objectKey: "artifact-previews/private/workbook-summary-range.png",
      filename: "workbook-summary-range.png",
      mimeType: "image/png",
      byteSize: previewBytes.byteLength,
      checksum: "sha256:preview-range",
      metadata: {
        sourceArtifactId: source.id,
        previewRole: "range",
        sheet: "Summary",
        range: "Summary!A1:H10"
      }
    });
    await harness.store.writeArtifactPreviewManifest({
      status: "ready",
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      sourceArtifactId: source.id,
      settingsHash,
      type: "image_pages",
      format: "png",
      pages: [
        {
          artifactId: previewRange.id,
          mimeType: "image/png",
          sheet: "Summary",
          range: "Summary!A1:H10",
          width: 900,
          height: 520
        }
      ],
      writtenAt: "2026-06-29T12:02:00.000Z"
    });

    const result = await harness.runTool("workspace.preview_images", {
      artifactId: source.id,
      sheets: ["Summary"],
      ranges: ["Summary!A1:H10"],
      maxImages: 1
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected preview_images to succeed");
    }
    expect(result.output).toEqual({
      artifactId: source.id,
      status: "ready",
      maxImages: 1,
      images: [
        {
          sourceArtifactId: source.id,
          imageArtifactId: previewRange.id,
          mimeType: "image/png",
          status: "ready",
          sheet: "Summary",
          range: "Summary!A1:H10",
          width: 900,
          height: 520
        }
      ],
      warnings: []
    });
    expect(result.artifacts).toEqual([
      {
        artifactId: previewRange.id,
        kind: "spreadsheet.preview_range_image",
        filename: "workbook-summary-range.png",
        mimeType: "image/png",
        modelVisibility: {
          type: "image",
          mimeType: "image/png"
        },
        metadata: {
          sourceArtifactId: source.id,
          status: "ready",
          sheet: "Summary",
          range: "Summary!A1:H10",
          width: 900,
          height: 520
        }
      }
    ]);

    const modelOutput = await createModelVisibleToolOutput(result, {
      clientInstanceId: harness.clientInstanceId,
      toolOutput: { maxTokens: 60_000 },
      artifactReader: {
        async readArtifact(input) {
          const artifact = await harness.store.getManagedArtifact({
            clientInstanceId: input.clientInstanceId,
            artifactId: input.artifactId
          });
          if (!artifact) {
            throw new Error("Missing artifact");
          }
          return {
            bytes: await harness.objectStore.getObject(artifact.objectKey),
            mimeType: artifact.mimeType
          };
        }
      }
    });
    const imageParts = Array.isArray(modelOutput.content)
      ? modelOutput.content.filter((part) => part.type === "image")
      : [];
    expect(imageParts).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        data: previewBytes
      }
    ]);
    expect(JSON.stringify(result)).not.toContain("objectKey");
    expect(JSON.stringify(result)).not.toContain("artifact-previews/private");
  });

  it("canonicalizes unqualified spreadsheet ranges with a single sheet selector", async () => {
    const harness = await createWorkspaceHarness();
    const source = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "spreadsheet.xlsx",
      objectKey: "execution-workspaces/private/workbook.xlsx",
      filename: "workbook.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      byteSize: 128,
      checksum: "sha256:workbook"
    });

    const pending = await harness.runTool("workspace.preview_images", {
      artifactId: source.id,
      sheets: ["Summary"],
      ranges: ["A1:B4"],
      maxImages: 1
    });
    expect(pending.status).toBe("success");
    if (pending.status !== "success") {
      throw new Error("Expected pending preview_images result");
    }
    expect(pending.output).toMatchObject({
      artifactId: source.id,
      status: "pending",
      images: [],
      warnings: [expect.objectContaining({ code: "preview_pending" })]
    });

    const previewBytes = encode("summary-a1-b4-png");
    const settingsHash = createArtifactPreviewSettingsHash({
      sheets: ["Summary"],
      ranges: ["Summary!A1:B4"],
      maxImages: 1
    });
    harness.objectStore.putObject("artifact-previews/private/workbook-summary-a1-b4.png", previewBytes);
    const previewRange = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "spreadsheet.preview_range_image",
      objectKey: "artifact-previews/private/workbook-summary-a1-b4.png",
      filename: "workbook-summary-a1-b4.png",
      mimeType: "image/png",
      byteSize: previewBytes.byteLength,
      checksum: "sha256:preview-summary-a1-b4",
      metadata: {
        sourceArtifactId: source.id,
        previewRole: "range",
        sheet: "Summary",
        range: "Summary!A1:B4"
      }
    });
    await harness.store.writeArtifactPreviewManifest({
      status: "ready",
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      sourceArtifactId: source.id,
      settingsHash,
      type: "image_pages",
      format: "png",
      pages: [
        {
          artifactId: previewRange.id,
          mimeType: "image/png",
          sheet: "Summary",
          range: "Summary!A1:B4",
          width: 400,
          height: 240
        }
      ]
    });

    const ready = await harness.runTool("workspace.preview_images", {
      artifactId: source.id,
      sheets: ["Summary"],
      ranges: ["A1:B4"],
      maxImages: 1
    });

    expect(ready.status).toBe("success");
    if (ready.status !== "success") {
      throw new Error("Expected ready preview_images result");
    }
    expect(ready.output).toEqual({
      artifactId: source.id,
      status: "ready",
      maxImages: 1,
      images: [
        {
          sourceArtifactId: source.id,
          imageArtifactId: previewRange.id,
          mimeType: "image/png",
          status: "ready",
          sheet: "Summary",
          range: "Summary!A1:B4",
          width: 400,
          height: 240
        }
      ],
      warnings: []
    });
    expect(ready.artifacts).toEqual([
      expect.objectContaining({
        artifactId: previewRange.id,
        modelVisibility: {
          type: "image",
          mimeType: "image/png"
        },
        metadata: expect.objectContaining({
          sheet: "Summary",
          range: "Summary!A1:B4"
        })
      })
    ]);
  });

  it("rejects selector requests that exceed maxImages before queueing", async () => {
    const harness = await createWorkspaceHarness();
    const source = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "spreadsheet.xlsx",
      objectKey: "execution-workspaces/private/workbook.xlsx",
      filename: "workbook.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      byteSize: 128,
      checksum: "sha256:workbook"
    });

    const result = await harness.runTool("workspace.preview_images", {
      artifactId: source.id,
      sheets: ["Summary", "Detail"],
      ranges: ["Summary!A1:B4", "Detail!A1:B4"],
      maxImages: 1
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("Expected selector validation failure");
    }
    expect(result.error).toMatchObject({
      code: "handler_failed",
      message: "workspace.preview_images selector count exceeds maxImages"
    });
    await expect(
      harness.store.getArtifactPreviewJob({
        clientInstanceId: harness.clientInstanceId,
        sourceArtifactId: source.id
      })
    ).resolves.toBeUndefined();
  });

  it("attaches image artifacts directly as model-visible preview images", async () => {
    const harness = await createWorkspaceHarness();
    const image = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "image.png",
      objectKey: "execution-workspaces/private/chart.png",
      filename: "chart.png",
      mimeType: "image/png",
      byteSize: 16,
      checksum: "sha256:chart"
    });

    const result = await harness.runTool("workspace.preview_images", {
      artifactId: image.id,
      maxImages: 1
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected preview_images to succeed");
    }
    expect(result.output).toEqual({
      artifactId: image.id,
      status: "ready",
      maxImages: 1,
      images: [
        {
          sourceArtifactId: image.id,
          imageArtifactId: image.id,
          mimeType: "image/png",
          status: "ready"
        }
      ],
      warnings: []
    });
    expect(result.artifacts).toEqual([
      {
        artifactId: image.id,
        kind: "image.png",
        filename: "chart.png",
        mimeType: "image/png",
        modelVisibility: {
          type: "image",
          mimeType: "image/png"
        },
        metadata: {
          sourceArtifactId: image.id,
          status: "ready"
        }
      }
    ]);
  });

  it("loads rendered workspace preview images from /workspace/previews paths", async () => {
    const harness = await createWorkspaceHarness();
    const previewBytes = encode("rendered-docx-page-1");
    await harness.putWorkspaceFile({
      path: "previews/report/page-1.png",
      objectKey: "execution-workspaces/private/previews/report/page-1.png",
      bytes: previewBytes,
      mimeType: "image/png"
    });

    const result = await harness.runTool("workspace.preview_images", {
      path: "/workspace/previews/report/page-1.png",
      maxImages: 1
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected preview_images to succeed");
    }
    expect(result.output).toEqual({
      artifactId: expect.any(String),
      status: "ready",
      maxImages: 1,
      images: [
        {
          sourceArtifactId: result.output.artifactId,
          imageArtifactId: result.output.artifactId,
          mimeType: "image/png",
          status: "ready"
        }
      ],
      warnings: []
    });
    expect(result.artifacts).toEqual([
      {
        artifactId: result.output.artifactId,
        kind: "image.png",
        filename: "page-1.png",
        mimeType: "image/png",
        modelVisibility: {
          type: "image",
          mimeType: "image/png"
        },
        metadata: {
          sourceArtifactId: result.output.artifactId,
          status: "ready",
          workspacePath: "previews/report/page-1.png"
        }
      }
    ]);
    expect(JSON.stringify(result)).not.toContain("objectKey");
    expect(JSON.stringify(result)).not.toContain("execution-workspaces/private");

    const modelOutput = await createModelVisibleToolOutput(result, {
      clientInstanceId: harness.clientInstanceId,
      toolOutput: { maxTokens: 60_000 },
      artifactReader: {
        async readArtifact(input) {
          const artifact = await harness.store.getManagedArtifact({
            clientInstanceId: input.clientInstanceId,
            artifactId: input.artifactId
          });
          if (!artifact) {
            throw new Error("Missing artifact");
          }
          return {
            bytes: await harness.objectStore.getObject(artifact.objectKey),
            mimeType: artifact.mimeType
          };
        }
      }
    });
    const imageParts = Array.isArray(modelOutput.content)
      ? modelOutput.content.filter((part) => part.type === "image")
      : [];
    expect(imageParts).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        data: previewBytes
      }
    ]);
    expect(modelOutput.text).toContain("[Visual context loaded]");
  });

  it("queues selector-specific previews when an existing manifest does not cover the request", async () => {
    const harness = await createWorkspaceHarness();
    const pdf = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "document.pdf",
      objectKey: "execution-workspaces/private/report.pdf",
      filename: "report.pdf",
      mimeType: "application/pdf",
      byteSize: 128,
      checksum: "sha256:report"
    });
    await harness.store.writeArtifactPreviewManifest({
      status: "ready",
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      sourceArtifactId: pdf.id,
      type: "image_pages",
      format: "png",
      pages: [
        {
          artifactId: asManagedArtifactId("art_pdf_page_1"),
          mimeType: "image/png",
          pageNumber: 1
        }
      ]
    });

    const pdfPage2 = await harness.runTool("workspace.preview_images", {
      artifactId: pdf.id,
      pages: [2],
      maxImages: 1
    });
    expect(pdfPage2.status).toBe("success");
    if (pdfPage2.status !== "success") {
      throw new Error("Expected pending PDF preview result");
    }
    expect(pdfPage2.output).toMatchObject({
      artifactId: pdf.id,
      status: "pending",
      images: [],
      warnings: [expect.objectContaining({ code: "preview_pending" })]
    });

    const deck = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "presentation.pptx",
      objectKey: "execution-workspaces/private/deck.pptx",
      filename: "deck.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      byteSize: 128,
      checksum: "sha256:deck"
    });
    await harness.store.writeArtifactPreviewManifest({
      status: "ready",
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      sourceArtifactId: deck.id,
      type: "image_pages",
      format: "png",
      pages: [
        {
          artifactId: asManagedArtifactId("art_deck_slide_1"),
          mimeType: "image/png",
          slideNumber: 1
        }
      ]
    });

    const slide2 = await harness.runTool("workspace.preview_images", {
      artifactId: deck.id,
      slides: [2],
      maxImages: 1
    });
    expect(slide2.status).toBe("success");
    if (slide2.status !== "success") {
      throw new Error("Expected pending slide preview result");
    }
    expect(slide2.output).toMatchObject({
      artifactId: deck.id,
      status: "pending",
      images: [],
      warnings: [expect.objectContaining({ code: "preview_pending" })]
    });

    const workbook = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "spreadsheet.xlsx",
      objectKey: "execution-workspaces/private/workbook.xlsx",
      filename: "workbook.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      byteSize: 128,
      checksum: "sha256:workbook"
    });
    await harness.store.writeArtifactPreviewManifest({
      status: "ready",
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      sourceArtifactId: workbook.id,
      type: "image_pages",
      format: "png",
      pages: [
        {
          artifactId: asManagedArtifactId("art_summary_range"),
          mimeType: "image/png",
          sheet: "Summary",
          range: "Summary!A1:H10"
        }
      ]
    });

    const detail = await harness.runTool("workspace.preview_images", {
      artifactId: workbook.id,
      sheets: ["Detail"],
      ranges: ["Detail!A1:H10"],
      maxImages: 1
    });
    expect(detail.status).toBe("success");
    if (detail.status !== "success") {
      throw new Error("Expected pending spreadsheet preview result");
    }
    expect(detail.output).toMatchObject({
      artifactId: workbook.id,
      status: "pending",
      images: [],
      warnings: [expect.objectContaining({ code: "preview_pending" })]
    });
    expect(JSON.stringify([pdfPage2, slide2, detail])).not.toContain("selection_empty");
  });

  it("queues selector-specific previews instead of reusing a default failed manifest", async () => {
    const harness = await createWorkspaceHarness();
    const source = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "document.pdf",
      objectKey: "execution-workspaces/private/report.pdf",
      filename: "report.pdf",
      mimeType: "application/pdf",
      byteSize: 128,
      checksum: "sha256:report"
    });
    await harness.store.writeArtifactPreviewManifest({
      status: "failed",
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      sourceArtifactId: source.id,
      errorCode: "conversion_failed"
    });

    const result = await harness.runTool("workspace.preview_images", {
      artifactId: source.id,
      pages: [2],
      maxImages: 1
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected pending selector-specific preview result");
    }
    expect(result.output).toMatchObject({
      artifactId: source.id,
      status: "pending",
      images: [],
      warnings: [expect.objectContaining({ code: "preview_pending" })]
    });
    await expect(
      harness.store.getArtifactPreviewManifest({
        clientInstanceId: harness.clientInstanceId,
        sourceArtifactId: source.id
      })
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "conversion_failed"
    });
    await expect(
      harness.store.getArtifactPreviewJob({
        clientInstanceId: harness.clientInstanceId,
        sourceArtifactId: source.id,
        settingsHash: createArtifactPreviewSettingsHash({ pages: [2], maxImages: 1 })
      })
    ).resolves.toMatchObject({
      status: "pending",
      settingsHash: createArtifactPreviewSettingsHash({ pages: [2], maxImages: 1 })
    });
  });

  it("reports pending and unsupported preview states without attaching images", async () => {
    const harness = await createWorkspaceHarness();
    const document = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "document.docx",
      objectKey: "execution-workspaces/private/report.docx",
      filename: "report.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      byteSize: 128,
      checksum: "sha256:report-docx"
    });
    const pending = await harness.runTool("workspace.preview_images", {
      artifactId: document.id
    });
    expect(pending.status).toBe("success");
    if (pending.status !== "success") {
      throw new Error("Expected pending preview_images result");
    }
    expect(pending.output).toMatchObject({
      artifactId: document.id,
      status: "pending",
      images: [],
      warnings: [expect.objectContaining({ code: "preview_pending" })]
    });
    expect(pending.artifacts).toBeUndefined();

    const workbook = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "spreadsheet.xlsx",
      objectKey: "execution-workspaces/private/workbook.xlsx",
      filename: "workbook.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      byteSize: 128,
      checksum: "sha256:workbook"
    });
    const workbookPending = await harness.runTool("workspace.preview_images", {
      artifactId: workbook.id,
      sheets: ["Summary"]
    });
    expect(workbookPending.status).toBe("success");
    if (workbookPending.status !== "success") {
      throw new Error("Expected pending workbook preview_images result");
    }
    expect(workbookPending.output).toMatchObject({
      artifactId: workbook.id,
      status: "pending",
      images: [],
      warnings: [expect.objectContaining({ code: "preview_pending" })]
    });
    expect(workbookPending.artifacts).toBeUndefined();

    const archive = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "archive.zip",
      objectKey: "execution-workspaces/private/archive.zip",
      filename: "archive.zip",
      mimeType: "application/zip",
      byteSize: 128,
      checksum: "sha256:archive"
    });
    const unsupported = await harness.runTool("workspace.preview_images", {
      artifactId: archive.id
    });
    expect(unsupported.status).toBe("success");
    if (unsupported.status !== "success") {
      throw new Error("Expected unsupported preview_images result");
    }
    expect(unsupported.output).toMatchObject({
      artifactId: archive.id,
      status: "unsupported",
      images: [],
      errorCode: "unsupported_type",
      warnings: [expect.objectContaining({ code: "unsupported_type" })]
    });
    expect(unsupported.artifacts).toBeUndefined();
  });
});
