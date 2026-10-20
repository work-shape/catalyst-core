import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(
  new URL("../packages/deployment-kit/docker/deployment.Dockerfile", import.meta.url),
  "utf8"
);

describe("deployment kit system layers", () => {
  it("ships local OCR and German and English language data in the document worker", () => {
    const stage = dockerfile.split(" AS document-runtime\n")[1]?.split("\nFROM ")[0];
    const packages = stage
      ?.split(/apt-get install[^\n]*\n/u)[1]
      ?.split("  &&")[0]
      ?.split("\n")
      .map((line) => line.replace(/\\$/u, "").trim())
      .filter(Boolean);

    expect(packages).toEqual([
      "libreoffice-writer-nogui",
      "python3",
      "python3-pip",
      "poppler-utils",
      "ocrmypdf",
      "tesseract-ocr",
      "tesseract-ocr-deu",
      "tesseract-ocr-eng"
    ]);
    expect(dockerfile).toContain("FROM document-runtime AS doc-worker");
  });
});
