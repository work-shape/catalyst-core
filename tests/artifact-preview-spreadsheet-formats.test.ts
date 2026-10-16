import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { LibreOfficeArtifactPreviewRenderer } from "@work-shape/catalyst-tool-execution";

describe("artifact preview spreadsheet source formats", () => {
  it.each([
    { bookType: "biff8", extension: "xls", mimeType: "application/vnd.ms-excel" },
    {
      bookType: "xlsx",
      extension: "xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    },
    {
      bookType: "ods",
      extension: "ods",
      mimeType: "application/vnd.oasis.opendocument.spreadsheet"
    }
  ] as const)(
    "reads and selects a range from $extension in the worker renderer",
    async (format) => {
      const root = await mkdtemp(join(tmpdir(), "preview-sheet-formats-"));
      try {
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(
          workbook,
          XLSX.utils.aoa_to_sheet([
            ["Planet", "Revenue", "Date"],
            ["Earth", 1165.95, new Date("2026-01-02T00:00:00Z")],
            ["Mars", 42]
          ]),
          "Orders"
        );
        const captured = join(root, "selected.xlsx");
        const sofficeCommand = join(root, "soffice");
        const pdfInfoCommand = join(root, "pdfinfo");
        const pdfToPpmCommand = join(root, "pdftoppm");
        // Only the native conversion/rasterization tools are stand-ins. SheetJS reads the
        // original format and writes the selected range before the converter sees it.
        await executable(
          sofficeCommand,
          `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const source = args.at(-1);
fs.copyFileSync(source, ${JSON.stringify(captured)});
fs.writeFileSync(path.join(args[args.indexOf("--outdir") + 1], path.basename(source, path.extname(source)) + ".pdf"), "%PDF-1.4");`
        );
        await executable(pdfInfoCommand, 'console.log("Pages: 1");');
        await executable(
          pdfToPpmCommand,
          `require("node:fs").writeFileSync(process.argv.at(-1) + ".png",
Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));`
        );
        const renderer = new LibreOfficeArtifactPreviewRenderer({
          tempRootDirectory: root,
          sofficeCommand,
          pdfInfoCommand,
          pdfToPpmCommand
        });
        const pages = await renderer.render({
          sourceKind: "spreadsheet",
          filename: `orders.${format.extension}`,
          mimeType: format.mimeType,
          bytes: XLSX.write(workbook, { bookType: format.bookType, type: "buffer" }),
          ranges: ["Orders!A1:C2"],
          maxPages: 1,
          maxConvertedPdfBytes: 1024 * 1024,
          maxOutputBytes: 1024 * 1024,
          maxRasterDimension: 4096,
          previewDpi: 96,
          outputFormat: "png",
          conversionTimeoutMs: 30_000,
          rasterizationTimeoutMs: 30_000
        });
        expect(pages.pages).toEqual([
          expect.objectContaining({ sheet: "Orders", range: "Orders!A1:C2", mimeType: "image/png" })
        ]);
        const selected = XLSX.read(await readFile(captured), { cellDates: true });
        expect(selected.SheetNames).toEqual(["Orders"]);
        const sheet = selected.Sheets.Orders;
        if (!sheet) throw new Error("Expected the selected Orders sheet");
        expect(XLSX.utils.sheet_to_json(sheet, { header: 1 })).toEqual([
          ["Planet", "Revenue", "Date"],
          ["Earth", 1165.95, new Date("2026-01-02T00:00:00Z")]
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});

async function executable(path: string, script: string): Promise<void> {
  await writeFile(path, `#!/usr/bin/env node\n${script}\n`);
  await chmod(path, 0o755);
}
