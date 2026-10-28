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

describe("file helper runner packages", () => {
  it("installs and smoke-checks the file programs in the runner", () => {
    const system = dockerfile.split(" AS runner-system\n")[1]?.split("\nFROM ")[0] ?? "";
    const runner = dockerfile.split("FROM runner-system AS runner")[1] ?? "";
    for (const dependency of [
      "7zip",
      "libarchive-tools",
      "pillow-heif==1.8.1",
      "extract-msg==0.57.0",
      "tnefparse==1.4.0",
      "numbers-parser==4.22.0",
      "Pillow==13.0.0"
    ])
      expect(system).toContain(dependency);
    for (const smoke of [
      "7z i",
      "bsdtar --version",
      "import extract_msg, tnefparse, numbers_parser, pillow_heif",
      "Image.open(b).load()"
    ])
      expect(runner).toContain(smoke);
  });
});
