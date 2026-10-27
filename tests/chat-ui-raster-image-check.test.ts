import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SUPPORTED_IMAGE_MIME_TYPES } from "@work-shape/catalyst-core";
import {
  FilePart,
  isImageAttachment,
  readArtifactImagePagesPreview,
  readToolArtifactRefs
} from "./support/chat-ui";
import { TranslationProvider } from "./support/chat-ui/shared";

const state = vi.hoisted(() => ({ part: {} }));
vi.mock("@assistant-ui/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@assistant-ui/react")>()),
  useAuiState: (selector: (value: typeof state) => unknown) => selector(state)
}));

const cases = [
  ...SUPPORTED_IMAGE_MIME_TYPES.flatMap((type) => [
    { mimeType: type, expected: type },
    { mimeType: ` ${type.toUpperCase()}; charset=binary `, expected: type }
  ]),
  ...[
    "image/svg+xml",
    "image/avif",
    "image/bmp",
    "application/pdf",
    "image/png,text/html",
    "image/png;x=1,text/html",
    "",
    undefined
  ].map((mimeType) => ({ mimeType, expected: undefined }))
];

describe("raster image checks across chat files", () => {
  it.each(cases)("classifies $mimeType consistently", ({ mimeType, expected }) => {
    // A filename or the attachment library's image tag must not override the declared MIME.
    expect(isImageAttachment({ type: "image", name: "photo.png", contentType: mimeType })).toBe(
      Boolean(expected)
    );

    state.part = {
      type: "file",
      mediaType: mimeType,
      filename: "photo.png",
      url: "https://example.test/photo.png"
    };
    const markup = renderToStaticMarkup(
      createElement(TranslationProvider, {
        locale: "en",
        children: createElement(FilePart)
      })
    );
    expect(markup.includes("<img")).toBe(Boolean(expected));
    expect(markup).toContain("photo.png");

    const [artifact] = readToolArtifactRefs({
      artifacts: [
        {
          artifactId: "art_document",
          metadata: {
            preview: {
              type: "image_pages",
              format: "png",
              pages: [{ artifactId: "art_page", mimeType }]
            }
          }
        }
      ]
    });
    expect(artifact && readArtifactImagePagesPreview(artifact)?.pages).toEqual(
      expected ? [{ artifactId: "art_page", mimeType: expected }] : undefined
    );
  });
});
