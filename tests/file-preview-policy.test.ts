import { describe, expect, it } from "vitest";
import {
  detectArtifactPreviewSourceKind,
  resolveFilePreviewCapability
} from "@work-shape/catalyst-core";
import { getSourceFilePreviewKind } from "./support/chat-ui";

describe("file preview policy", () => {
  it.each([
    ["report.pdf", "application/pdf", "native_pdf"],
    ["legacy.ppt", "application/vnd.ms-powerpoint", "office_presentation_pages"],
    ["legacy.doc", "application/msword", "office_document_pages"],
    ["model.xlsm", "application/vnd.ms-excel.sheet.macroEnabled.12", "spreadsheet"],
    ["notes.md", "text/markdown", "markdown"]
  ] as const)("classifies %s by capability", (filename, mimeType, expected) => {
    expect(resolveFilePreviewCapability({ filename, mimeType })).toBe(expected);
  });

  it("previews an image when its MIME metadata is unavailable, but not a name holding an image extension", () => {
    for (const filename of ["IMG_0851.jpeg", "PHOTO.JPG", "photo.heic"]) {
      for (const mimeType of [undefined, "application/octet-stream"]) {
        expect(resolveFilePreviewCapability({ filename, mimeType })).toBe("native_image");
        expect(getSourceFilePreviewKind(filename, mimeType)).toBe("image");
      }
    }
    expect(resolveFilePreviewCapability({ filename: "photo.jpeg.zip" })).toBeUndefined();
    expect(resolveFilePreviewCapability({ filename: "jpeg" })).toBeUndefined();
  });

  it("keeps the renderer source mapping for explicit page-image requests", () => {
    expect(detectArtifactPreviewSourceKind({ filename: "report.pdf" })).toBe("pdf");
    expect(detectArtifactPreviewSourceKind({ filename: "deck.pptx" })).toBe("presentation");
    expect(detectArtifactPreviewSourceKind({ filename: "model.xlsx" })).toBe("spreadsheet");
    expect(detectArtifactPreviewSourceKind({ filename: "notes.txt" })).toBeUndefined();
  });

  it("routes uploaded files through the same capability decisions", () => {
    expect(getSourceFilePreviewKind("deck.pptx")).toBe("office");
    expect(getSourceFilePreviewKind("letter.docx")).toBe("office");
    expect(getSourceFilePreviewKind("report.pdf")).toBe("pdf");
    expect(getSourceFilePreviewKind("model.xlsx")).toBe("spreadsheet");
  });
});
