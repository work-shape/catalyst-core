import { describe, expect, it } from "vitest";
import {
  detectArtifactPreviewSourceKind,
  resolveFilePreviewCapability
} from "@vivd-catalyst/core";
import { getSourceFilePreviewKind } from "../packages/chat-ui/src/source-file-preview";

describe("file preview policy", () => {
  it.each([
    ["report.pdf", "application/pdf", "native_pdf"],
    ["photo.webp", "image/webp", "native_image"],
    ["deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "office_presentation_pages"],
    ["legacy.ppt", "application/vnd.ms-powerpoint", "office_presentation_pages"],
    ["letter.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "office_document_pages"],
    ["legacy.doc", "application/msword", "office_document_pages"],
    ["model.xlsm", "application/vnd.ms-excel.sheet.macroEnabled.12", "spreadsheet"],
    ["notes.md", "text/markdown", "markdown"],
    ["data.json", "application/json", "text"]
  ] as const)("classifies %s by capability", (filename, mimeType, expected) => {
    expect(resolveFilePreviewCapability({ filename, mimeType })).toBe(expected);
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
