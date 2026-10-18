import { describe, expect, it } from "vitest";
import {
  knowledgeDocumentTypesSchema,
  knowledgeProcessingOf,
  validateKnowledgeProcessingOutput,
  chunkKnowledgeText
} from "@work-shape/catalyst-data-stores";
import {
  KnowledgeExtractionError,
  knowledgeExtractionResultSchema,
  parseKnowledgeProcessorOutput,
  runKnowledgeExtraction
} from "@work-shape/catalyst-core";

const types = knowledgeDocumentTypesSchema.parse([
  {
    id: "contracts",
    match: { path: ["**/contracts/**"], mime: ["application/pdf"] },
    processor: "tables",
    chunking: "page"
  },
  { id: "reports", match: { name: ["report*"] }, chunking: "heading" },
  { id: "notes", match: { mime: ["text/plain"] }, chunking: "whole" }
]);
const item = {
  name: "contract.pdf",
  path: "/contracts/contract.pdf",
  mime: "application/pdf",
  format: "pdf"
} as const;
const output = {
  documents: [{ pageFrom: 1, pageTo: 2 }],
  pages: [
    { page: 1, text: "# First\nA" },
    { page: 2, text: "# Second\nB" }
  ],
  fields: {}
};

describe("document types and the frozen processor contract (KB 80, 95)", () => {
  it("classifies by path, name and MIME with a default and deterministic first match", () => {
    expect(knowledgeProcessingOf(types, item)).toMatchObject({
      type: "contracts",
      processorRevision: "tables@1",
      chunking: "page"
    });
    expect(
      knowledgeProcessingOf(types, { ...item, name: "report.pdf", path: "/other.pdf" }).type
    ).toBe("reports");
    expect(knowledgeProcessingOf(types, { ...item, mime: "text/plain" }).type).toBe("notes");
    expect(
      knowledgeProcessingOf(types, { ...item, mime: "image/png", path: "/image.png" }).type
    ).toBe("default");
    const changed = knowledgeDocumentTypesSchema.parse(
      types.map((type) => (type.id === "reports" ? { ...type, chunking: "whole" } : type))
    );
    expect(knowledgeProcessingOf(changed, item).key).toBe(knowledgeProcessingOf(types, item).key);
    expect(
      knowledgeProcessingOf(changed, { ...item, name: "report.pdf", path: "/other.pdf" }).key
    ).not.toBe(
      knowledgeProcessingOf(types, { ...item, name: "report.pdf", path: "/other.pdf" }).key
    );
  });
  it.each([{ processor: "custom" }, { processor: "ocr" }, { workflow: "process-documents" }])(
    "refuses an unavailable processor or workflow field: %j",
    (extra) => {
      expect(() =>
        knowledgeDocumentTypesSchema.parse([{ id: "example", match: { name: ["*"] }, ...extra }])
      ).toThrow(/documentTypes|data Workflow/u);
    }
  );
  it("bounds and validates declared JSON Schema, malformed output, unknown fields and pages", () => {
    expect(() =>
      knowledgeDocumentTypesSchema.parse([
        { id: "example", match: { name: ["*"] }, schema: { type: "not-a-json-schema-type" } }
      ])
    ).toThrow(/JSON Schema/u);
    const declared = knowledgeDocumentTypesSchema.parse([
      {
        id: "example",
        match: { name: ["*"] },
        schema: {
          type: "object",
          properties: { amount: { type: "number" } },
          allOf: [{ required: ["amount"] }],
          additionalProperties: false
        }
      }
    ]);
    const processing = knowledgeProcessingOf(declared, item);
    expect(validateKnowledgeProcessingOutput(output, processing, 2)).toEqual(
      parseKnowledgeProcessorOutput(output)
    );
    expect(() =>
      validateKnowledgeProcessingOutput({ ...output, fields: { outside: "secret" } }, processing, 2)
    ).toThrow(/fields/u);
    expect(() =>
      validateKnowledgeProcessingOutput({ ...output, pages: "invalid" }, processing, 2)
    ).toThrow(/contract/u);
    expect(() => validateKnowledgeProcessingOutput(output, processing, 1)).toThrow(
      /maxPagesPerDocument/u
    );
    expect(() => validateKnowledgeProcessingOutput("not JSON", processing, 2)).toThrow(/contract/u);
  });
  it("keeps page, heading, section and logical-document boundaries and caps whole/table chunks", () => {
    const common = {
      format: "pdf",
      pages: output.pages,
      title: "Title",
      fileName: "file.pdf"
    } as const;
    expect(chunkKnowledgeText({ ...common, strategy: "page" })).toHaveLength(2);
    expect(
      chunkKnowledgeText({ ...common, strategy: "heading" }).map((chunk) => chunk.heading)
    ).toEqual(["First", "Second"]);
    expect(chunkKnowledgeText({ ...common, strategy: "whole" })).toHaveLength(1);
    expect(
      chunkKnowledgeText({
        ...common,
        strategy: "whole",
        output: {
          ...output,
          documents: [
            { pageFrom: 1, pageTo: 1 },
            { pageFrom: 2, pageTo: 2 }
          ]
        }
      })
    ).toHaveLength(2);
    expect(
      chunkKnowledgeText({
        ...common,
        strategy: "sections",
        output: { ...output, sections: [{ pageFrom: 1, pageTo: 2, title: "Terms" }] }
      }).every((chunk) => chunk.heading === "Terms")
    ).toBe(true);
    const table =
      "| Key | Value |\n| --- | --- |\n" +
      Array.from({ length: 300 }, (_, i) => `| ${i} | content |`).join("\n");
    const chunks = chunkKnowledgeText({
      ...common,
      strategy: "sheet_rows",
      pages: [{ page: 1, text: table }]
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every((chunk) => chunk.tokenCount <= 512 && chunk.text.startsWith("| Key | Value |"))
    ).toBe(true);
  });
  it("carries a counted conversion timeout through the stored extraction contract", async () => {
    const result = await runKnowledgeExtraction({
      format: "pdf",
      maxPages: 8_000,
      signal: new AbortController().signal,
      readFile: async () => new Uint8Array([1]),
      extractor: {
        revision: 1,
        extract: async () => {
          throw new KnowledgeExtractionError(
            "knowledge_conversion_timeout",
            "Document took too long to convert",
            6_001
          );
        }
      }
    });
    expect(knowledgeExtractionResultSchema.parse(result)).toEqual({
      status: "failed",
      code: "knowledge_conversion_timeout",
      pageCount: 6_001
    });
    expect(() => knowledgeExtractionResultSchema.parse({ ...result, pageCount: -1 })).toThrow();
  });
  it("fails hostile built-in output with the shared code and enforces the runtime page limit", async () => {
    const input = {
      format: "pdf",
      processor: "tables",
      processorRevision: "tables@1",
      maxPages: 2,
      signal: new AbortController().signal,
      readFile: async () => new Uint8Array([1]),
      extractor: {
        revision: 1,
        extract: async () => ({ pages: output.pages }),
        process: async () => ({ ...output, documents: [{ pageFrom: 2, pageTo: 1 }] })
      }
    } as const;
    expect(await runKnowledgeExtraction(input)).toEqual({
      status: "failed",
      code: "knowledge_processor_output_invalid"
    });
    expect(
      await runKnowledgeExtraction({
        ...input,
        maxPages: 1,
        extractor: { ...input.extractor, process: async () => output }
      })
    ).toEqual({ status: "failed", code: "knowledge_file_too_many_pages" });
  });
});
