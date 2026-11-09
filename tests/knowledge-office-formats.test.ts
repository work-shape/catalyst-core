import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_DOCUMENT_FORMATS,
  knowledgeDocumentFormatOf,
  knowledgeExtractJobPayloadSchema,
  readKnowledgeCitationSources
} from "@work-shape/catalyst-core";
import {
  chunkKnowledgeText,
  estimateKnowledgeTokens,
  KNOWLEDGE_CHUNK_MAX_TOKENS,
  knowledgeProcessingOf
} from "@work-shape/catalyst-data-stores";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

describe("the office formats of a Knowledge Base", () => {
  it("reads XLSX and PPTX by name and by media type", () => {
    expect(knowledgeDocumentFormatOf({ filename: "Preise.XLSX" })).toBe("xlsx");
    expect(knowledgeDocumentFormatOf({ filename: "angebot.pptx" })).toBe("pptx");
    expect(knowledgeDocumentFormatOf({ filename: "preise", mimeType: XLSX })).toBe("xlsx");
    expect(knowledgeDocumentFormatOf({ filename: "angebot", mimeType: PPTX })).toBe("pptx");
    expect(KNOWLEDGE_DOCUMENT_FORMATS).toEqual(expect.arrayContaining(["xlsx", "pptx"]));
    expect(knowledgeExtractJobPayloadSchema.shape.format.options).toEqual(
      expect.arrayContaining(["xlsx", "pptx"])
    );
  });

  it("refuses the legacy formats and the macro-enabled ones, whatever their media type says", () => {
    for (const file of [
      { filename: "preise.xls" },
      { filename: "angebot.ppt" },
      { filename: "preise.xls", mimeType: XLSX },
      { filename: "angebot.ppt", mimeType: PPTX },
      { filename: "preise", mimeType: "application/vnd.ms-excel" },
      { filename: "angebot", mimeType: "application/vnd.ms-powerpoint" },
      { filename: "preise.xlsm" },
      { filename: "angebot.pptm" }
    ]) {
      expect(knowledgeDocumentFormatOf(file), JSON.stringify(file)).toBeUndefined();
    }
  });

  it("cuts a spreadsheet by rows and a deck by page unless a rule says otherwise", () => {
    const of = (format: "xlsx" | "pptx" | "pdf" | "docx" | "markdown" | "txt") =>
      knowledgeProcessingOf(undefined, { path: "", name: "file", mime: "", format }).chunking;
    expect(of("xlsx")).toBe("sheet_rows");
    expect(of("pptx")).toBe("page");
    expect(of("pdf")).toBe("page");
    expect(of("docx")).toBe("page");
    expect(of("txt")).toBe("page");
    expect(of("markdown")).toBe("heading");
  });
});

/** A sheet's text as the document-processing capability answers it. */
function sheet(rows: number): string {
  return [
    "Preisliste 2026",
    [
      "| Art.-Nr. | Bezeichnung | Preis / Netto | Preis / Brutto |",
      "| --- | --- | --- | --- |",
      ...Array.from(
        { length: rows },
        (_, index) =>
          `| A-${index} | Einhebelmischer Modell ${index} | ${100 + index} | ${119 + index} |`
      )
    ].join("\n"),
    "| Stufe | Rabatt |\n| --- | --- |\n| A | 5% |"
  ].join("\n\n");
}

const output = (pages: { page: number; text: string }[], titles: string[]) => ({
  documents: [{ pageFrom: 1, pageTo: pages.length }],
  pages,
  sections: titles.map((title, index) => ({ title, pageFrom: index + 1, pageTo: index + 1 })),
  fields: {}
});

describe("the passages of a spreadsheet", () => {
  const text = sheet(120);
  const pages = [
    { page: 1, text },
    { page: 2, text: "" }
  ];
  const chunks = chunkKnowledgeText({
    format: "xlsx",
    pages,
    output: output(pages, ["Armaturen", "Leer"]),
    title: "Preisliste",
    fileName: "preisliste.xlsx"
  });

  it("names each passage after its sheet, on its page, and gives an empty sheet none", () => {
    expect(new Set(chunks.map((chunk) => chunk.heading))).toEqual(new Set(["Armaturen"]));
    expect(new Set(chunks.map((chunk) => chunk.page))).toEqual(new Set([1]));
  });

  it("repeats the header in every group and never splits a row", () => {
    const table = chunks.filter((chunk) => chunk.text.includes("Art.-Nr."));
    expect(table.length).toBeGreaterThan(1);
    const seen: string[] = [];
    for (const chunk of table) {
      const [header, separator, ...rows] = chunk.text.split("\n");
      expect(header).toBe("| Art.-Nr. | Bezeichnung | Preis / Netto | Preis / Brutto |");
      expect(separator).toBe("| --- | --- | --- | --- |");
      for (const row of rows) expect(row).toMatch(/^\| A-\d+ \| .+ \| \d+ \| \d+ \|$/u);
      seen.push(...rows.map((row) => row.split(" | ")[0] ?? ""));
      expect(estimateKnowledgeTokens(chunk.text)).toBeLessThanOrEqual(KNOWLEDGE_CHUNK_MAX_TOKENS);
    }
    expect(seen).toEqual(Array.from({ length: 120 }, (_, index) => `| A-${index}`));
  });

  it("keeps a second table under its own header and the title apart", () => {
    expect(chunks[0]?.text).toBe("Preisliste 2026");
    expect(chunks.at(-1)?.text).toBe("| Stufe | Rabatt |\n| --- | --- |\n| A | 5% |");
  });

  it("leaves the cut of every other format as it was", () => {
    const chunksOf = (format: "pdf" | "docx") =>
      chunkKnowledgeText({
        format,
        pages: [{ page: 1, text: "Vorwort\n\n| a | b |\n| --- | --- |\n| 1 | 2 |" }],
        output: {
          documents: [{ pageFrom: 1, pageTo: 1 }],
          pages: [{ page: 1, text: "" }],
          sections: [{ title: "Kapitel", pageFrom: 1, pageTo: 1 }],
          fields: {}
        },
        strategy: "sheet_rows",
        title: "t",
        fileName: "f"
      });
    expect(chunksOf("pdf")).toEqual([
      {
        position: 0,
        page: 1,
        text: "Vorwort\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
        tokenCount: estimateKnowledgeTokens("Vorwort\n\n| a | b |\n| --- | --- |\n| 1 | 2 |")
      }
    ]);
  });

  it("cuts by the rule's strategy when one is named, keeping the sheet's name", () => {
    const whole = chunkKnowledgeText({
      format: "xlsx",
      pages,
      output: output(pages, ["Armaturen", "Leer"]),
      strategy: "page",
      title: "Preisliste",
      fileName: "preisliste.xlsx"
    });
    expect(whole[0]).toMatchObject({ page: 1, heading: "Armaturen" });
  });
});

describe("the citation of an office file", () => {
  const passage = {
    ref: "K1",
    knowledgeBase: "preise",
    documentId: "kbdoc_1",
    fileId: "file_1",
    fileName: "preisliste.xlsx",
    title: "Preisliste",
    page: 2,
    heading: "Armaturen",
    text: "the passage",
    score: 0.5
  };

  it("keeps the sheet of a spreadsheet's passage, never the passage's text", () => {
    expect(readKnowledgeCitationSources([passage])).toEqual([
      {
        ref: "K1",
        knowledgeBase: "preise",
        documentId: "kbdoc_1",
        fileId: "file_1",
        fileName: "preisliste.xlsx",
        page: 2,
        sheet: "Armaturen"
      }
    ]);
  });

  it("reads back a stored sheet and leaves the heading of any other file behind", () => {
    const [stored] = readKnowledgeCitationSources([passage]);
    expect(readKnowledgeCitationSources([stored])).toEqual([stored]);
    const [pdf] = readKnowledgeCitationSources([{ ...passage, fileName: "preise.pdf" }]);
    expect(pdf).not.toHaveProperty("sheet");
    expect(pdf).not.toHaveProperty("heading");
  });
});
