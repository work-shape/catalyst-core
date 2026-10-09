import { describe, expect, it } from "vitest";
import {
  ARTIFACT_PREVIEW_MAX_PAGES,
  asClientInstanceId,
  asConversationId,
  asManagedArtifactId,
  resolveArtifactPreviewLifecycle,
  type ArtifactPreviewJobRecord,
  type JsonObject,
  type ArtifactPreviewManifest
} from "@vivd-catalyst/core";

const clientInstanceId = asClientInstanceId("preview-lifecycle-test");
const conversationId = asConversationId("conv_preview_lifecycle");
const sourceArtifactId = asManagedArtifactId("art_preview_source");
const createdAt = "2026-08-03T12:00:00.000Z";

describe("artifact preview lifecycle", () => {
  it("keeps a ready manifest authoritative while retaining an active selector job", () => {
    const state = resolveArtifactPreviewLifecycle({
      job: job("processing"),
      manifest: readyManifest()
    });

    expect(state).toMatchObject({
      status: "ready",
      source: "manifest",
      pageCount: 2,
      activeQueuedAt: createdAt,
      pages: [{ artifactId: "art_preview_page", pageNumber: 1 }]
    });
  });

  it("prioritizes active work over terminal state and the bounded embedded snapshot", () => {
    const state = resolveArtifactPreviewLifecycle({
      job: job("pending"),
      manifest: failedManifest(),
      metadata: embeddedMetadata()
    });

    expect(state).toEqual({ status: "active", queuedAt: createdAt });
  });

  it("uses the sanitized embedded snapshot before a completed job without a manifest", () => {
    const state = resolveArtifactPreviewLifecycle({
      job: job("completed"),
      metadata: embeddedMetadata()
    });

    expect(state).toEqual({
      status: "ready",
      source: "embedded",
      format: "png",
      pages: [
        {
          artifactId: "art_embedded_page",
          mimeType: "image/png",
          filename: "page-1.png",
          pageNumber: 1
        }
      ]
    });
  });

  it("reads an embedded snapshot up to the worker's page ceiling and no further", () => {
    expect(ARTIFACT_PREVIEW_MAX_PAGES).toBe(500);
    const read = (count: number) => {
      const state = resolveArtifactPreviewLifecycle({
        metadata: { preview: { type: "image_pages", format: "png", pages: embeddedPages(count) } }
      });
      return state.status === "ready" ? state.pages.length : 0;
    };

    expect(read(ARTIFACT_PREVIEW_MAX_PAGES)).toBe(ARTIFACT_PREVIEW_MAX_PAGES);
    expect(read(ARTIFACT_PREVIEW_MAX_PAGES + 1)).toBe(ARTIFACT_PREVIEW_MAX_PAGES);
  });
});

function embeddedPages(count: number): JsonObject[] {
  return Array.from({ length: count }, (_, index) => ({
    artifactId: `art_embedded_page_${index + 1}`,
    mimeType: "image/png",
    pageNumber: index + 1
  }));
}

function job(status: ArtifactPreviewJobRecord["status"]): ArtifactPreviewJobRecord {
  return {
    id: "preview-job",
    clientInstanceId,
    conversationId,
    sourceArtifactId,
    sourceChecksum: "sha256:source",
    sourceMimeType: "application/pdf",
    renderer: "artifact-preview-worker",
    rendererVersion: "preview-contract-v1",
    settingsHash: "default-image-pages-v1",
    status,
    attempts: 1,
    createdAt,
    updatedAt: createdAt
  };
}

function readyManifest(): Extract<ArtifactPreviewManifest, { status: "ready" }> {
  return {
    status: "ready",
    clientInstanceId,
    conversationId,
    sourceArtifactId,
    renderer: "artifact-preview-worker",
    rendererVersion: "preview-contract-v1",
    settingsHash: "default-image-pages-v1",
    type: "image_pages",
    format: "png",
    pageCount: 2,
    pages: [
      {
        artifactId: asManagedArtifactId("art_preview_page"),
        mimeType: "image/png",
        pageNumber: 1
      }
    ],
    createdAt,
    updatedAt: createdAt
  };
}

function failedManifest(): Extract<ArtifactPreviewManifest, { status: "failed" | "unsupported" }> {
  return {
    status: "failed",
    clientInstanceId,
    conversationId,
    sourceArtifactId,
    renderer: "artifact-preview-worker",
    rendererVersion: "preview-contract-v1",
    settingsHash: "default-image-pages-v1",
    errorCode: "conversion_failed",
    createdAt,
    updatedAt: createdAt
  };
}

function embeddedMetadata(): JsonObject {
  return {
    preview: {
      type: "image_pages",
      format: "png",
      pages: [
        {
          artifactId: "art_embedded_page",
          mimeType: "image/png",
          filename: "page-1.png",
          pageNumber: 1,
          objectKey: "must-not-leak"
        },
        { artifactId: "art_invalid_page", mimeType: "text/plain" }
      ]
    }
  };
}
