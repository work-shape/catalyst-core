import { describe, expect, it } from "vitest";
import type { ArtifactPreviewResponse } from "@vivd-catalyst/api-client";
import {
  ARTIFACT_PREVIEW_POLL_DELAYS_MS,
  artifactPreviewPollDelayMs,
  createArtifactPreviewView,
  createImagePagesArtifactPreviewLoadPlan,
  getArtifactSourceFallbackKind,
  shouldUseLiveArtifactPreviewState
} from "../packages/chat-ui/src/artifact-preview";
import type { ToolArtifactDownloadRef } from "../packages/chat-ui/src/tool-artifacts";

describe("chat UI artifact preview state", () => {
  it("backs off while pending and stops polling after the short cap", () => {
    expect(
      ARTIFACT_PREVIEW_POLL_DELAYS_MS.map((_, index) =>
        artifactPreviewPollDelayMs({ status: "pending", pendingAttempt: index })
      )
    ).toEqual([1000, 2000, 3000, 5000, 5000, 5000, 5000, 5000]);
    expect(
      artifactPreviewPollDelayMs({
        status: "pending",
        pendingAttempt: ARTIFACT_PREVIEW_POLL_DELAYS_MS.length
      })
    ).toBeUndefined();
    expect(artifactPreviewPollDelayMs({ status: "ready", pendingAttempt: 0 })).toBeUndefined();
    expect(artifactPreviewPollDelayMs({ status: "failed", pendingAttempt: 0 })).toBeUndefined();
    expect(artifactPreviewPollDelayMs({ status: "unsupported", pendingAttempt: 0 })).toBeUndefined();
  });

  it("uses embedded ready snapshots only until live preview state replaces them", () => {
    const embeddedReady: ArtifactPreviewResponse = {
      status: "ready",
      artifactId: "art_docx",
      type: "image_pages",
      format: "png",
      pages: [
        {
          artifactId: "art_embedded_page",
          mimeType: "image/png",
          pageNumber: 1
        }
      ]
    };
    const artifact: ToolArtifactDownloadRef = {
      artifactId: "art_docx",
      filename: "final.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      preview: embeddedReady
    };

    expect(
      createArtifactPreviewView({
        artifact,
        preview: artifact.preview,
        refreshing: true,
        apiError: false,
        pendingAttempt: 0
      })
    ).toMatchObject({
      kind: "ready",
      refreshing: true,
      preview: embeddedReady
    });

    expect(
      createArtifactPreviewView({
        artifact,
        preview: {
          status: "pending",
          artifactId: "art_docx"
        },
        refreshing: false,
        apiError: false,
        pendingAttempt: 0
      })
    ).toEqual({
      kind: "pending",
      pollDelayMs: 1000,
      fallbackKind: undefined
    });

    const liveReady: ArtifactPreviewResponse = {
      ...embeddedReady,
      pages: [
        {
          artifactId: "art_live_page",
          mimeType: "image/png",
          pageNumber: 1
        }
      ]
    };
    expect(
      createArtifactPreviewView({
        artifact,
        preview: liveReady,
        refreshing: false,
        apiError: false,
        pendingAttempt: 1
      })
    ).toMatchObject({
      kind: "ready",
      refreshing: false,
      preview: liveReady
    });
  });

  it("represents failed, unsupported, and API-failure states without blocking download data", () => {
    const pdfArtifact: ToolArtifactDownloadRef = {
      artifactId: "art_pdf",
      filename: "report.pdf",
      mimeType: "application/pdf"
    };
    const officeArtifact: ToolArtifactDownloadRef = {
      artifactId: "art_docx",
      filename: "report.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    };
    const imageArtifact: ToolArtifactDownloadRef = {
      artifactId: "art_image",
      filename: "chart.png",
      mimeType: "image/png"
    };

    expect(getArtifactSourceFallbackKind(pdfArtifact)).toBe("pdf");
    expect(getArtifactSourceFallbackKind(officeArtifact)).toBeUndefined();
    expect(getArtifactSourceFallbackKind(imageArtifact)).toBe("image");

    expect(
      createArtifactPreviewView({
        artifact: pdfArtifact,
        preview: {
          status: "unsupported",
          artifactId: "art_pdf",
          errorCode: "unsupported_type"
        },
        refreshing: false,
        apiError: false,
        pendingAttempt: 0
      })
    ).toEqual({
      kind: "unsupported",
      errorCode: "unsupported_type",
      fallbackKind: "pdf"
    });

    expect(
      createArtifactPreviewView({
        artifact: officeArtifact,
        preview: {
          status: "failed",
          artifactId: "art_docx",
          errorCode: "conversion_failed"
        },
        refreshing: false,
        apiError: false,
        pendingAttempt: 0
      })
    ).toEqual({
      kind: "failed",
      errorCode: "conversion_failed",
      retryable: false,
      fallbackKind: undefined
    });

    expect(
      createArtifactPreviewView({
        artifact: officeArtifact,
        preview: {
          status: "failed",
          artifactId: "art_docx",
          errorCode: "conversion_failed",
          retryable: true
        },
        refreshing: false,
        apiError: false,
        pendingAttempt: 0
      })
    ).toEqual({
      kind: "failed",
      errorCode: "conversion_failed",
      retryable: true,
      fallbackKind: undefined
    });

    expect(
      createArtifactPreviewView({
        artifact: imageArtifact,
        preview: undefined,
        refreshing: false,
        apiError: true,
        pendingAttempt: 0
      })
    ).toEqual({
      kind: "error",
      fallbackKind: "image"
    });
  });

  it("uses live preview state for PDF, document, and presentation page-image previews", () => {
    expect(shouldUseLiveArtifactPreviewState({
      artifactId: "art_docx",
      filename: "memo.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    })).toBe(true);
    expect(shouldUseLiveArtifactPreviewState({
      artifactId: "art_pptx",
      filename: "deck.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    })).toBe(true);
    expect(shouldUseLiveArtifactPreviewState({
      artifactId: "art_pdf",
      filename: "report.pdf",
      mimeType: "application/pdf"
    })).toBe(true);
    expect(shouldUseLiveArtifactPreviewState({
      artifactId: "art_xlsx",
      filename: "analysis.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    })).toBe(false);
    expect(shouldUseLiveArtifactPreviewState({
      artifactId: "art_docx",
      filename: "memo.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      preview: {
        status: "ready",
        artifactId: "art_docx",
        type: "image_pages",
        format: "png",
        pages: [{ artifactId: "art_docx_page_1", mimeType: "image/png" }]
      }
    })).toBe(true);
  });

  it("uses a stable primitive load key for image-page preview fetches", () => {
    const firstArtifact: ToolArtifactDownloadRef = {
      artifactId: "art_pptx",
      filename: "deck.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      preview: {
        status: "ready",
        artifactId: "art_pptx",
        type: "image_pages",
        format: "png",
        pages: [
          { artifactId: "art_slide_1", mimeType: "image/png", slideNumber: 1 },
          { artifactId: "art_slide_2", mimeType: "image/png", slideNumber: 2 }
        ]
      }
    };
    const rerenderedArtifact: ToolArtifactDownloadRef = {
      ...firstArtifact,
      preview: {
        status: "ready",
        artifactId: "art_pptx",
        type: "image_pages",
        format: "png",
        pages: [
          { artifactId: "art_slide_1", mimeType: "image/png", slideNumber: 1 },
          { artifactId: "art_slide_2", mimeType: "image/png", slideNumber: 2 }
        ]
      }
    };
    const changedArtifact: ToolArtifactDownloadRef = {
      ...firstArtifact,
      preview: {
        status: "ready",
        artifactId: "art_pptx",
        type: "image_pages",
        format: "png",
        pages: [
          { artifactId: "art_slide_1", mimeType: "image/png", slideNumber: 1 },
          { artifactId: "art_slide_3", mimeType: "image/png", slideNumber: 3 }
        ]
      }
    };

    const firstPlan = createImagePagesArtifactPreviewLoadPlan(firstArtifact);
    const rerenderedPlan = createImagePagesArtifactPreviewLoadPlan(rerenderedArtifact);
    const changedPlan = createImagePagesArtifactPreviewLoadPlan(changedArtifact);

    expect(firstPlan?.pages).not.toBe(rerenderedPlan?.pages);
    expect(firstPlan?.key).toBe(rerenderedPlan?.key);
    expect(changedPlan?.key).not.toBe(firstPlan?.key);
  });
});
