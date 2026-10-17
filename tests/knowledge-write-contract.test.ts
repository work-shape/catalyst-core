import { knowledgeRecordsRefusalSchema } from "@work-shape/catalyst-asset-schemas";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  KNOWLEDGE_WRITE_OPERATIONS,
  knowledgeSourcesOutputSchema,
  KNOWLEDGE_SOURCE_FAILURE_CODES,
  KNOWLEDGE_DOCUMENT_FAILURE_CODES,
  KNOWLEDGE_FILE_MAX_BYTES,
  WORKFLOW_ERROR_CODES,
  knowledgeWorkflowSourceSchema,
  knowledgeProcessorOutputSchema,
  parseKnowledgeProcessorOutput,
  operationBatchFailureSchema,
  operationBatchResultSchema,
  type OperationBatchResult,
  type KnowledgeIngestItem,
  type OperationDefinition
} from "@work-shape/catalyst-core";
import { knowledgeWriteContracts, workflowSummarySchema } from "@work-shape/catalyst-api-contract";
import {
  createWorkflowFolderSource,
  parseWorkflowManifest,
  workflowManifestFingerprint
} from "@work-shape/catalyst-workflows";

const dataset = { $dataset: "dataset-1", rowCount: 1, bytes: 120 };
const item = { itemId: "contract-1", version: "v2", name: "Contract", text: "Text" };
const processed = {
  documents: [{ pageFrom: 1, pageTo: 2 }],
  pages: [
    { page: 1, text: "| Price | EUR |\n| --- | --- |\n| 50 | EUR |" },
    { page: 2, text: "Terms" }
  ],
  sections: [{ title: "Price", pageFrom: 1, pageTo: 1 }],
  fields: { price: 50 }
};

describe("KBW-0 write contracts", () => {
  it("freezes the generic batch descriptor and a dataset of per-item failures", () => {
    expectTypeOf<OperationDefinition["batch"]>().toEqualTypeOf<true | undefined>();
    expectTypeOf<OperationBatchResult>().toEqualTypeOf<{
      done: number;
      failed: number;
      failures: typeof dataset;
    }>();
    expect(operationBatchResultSchema.parse({ done: 997, failed: 3, failures: dataset })).toEqual({
      done: 997,
      failed: 3,
      failures: dataset
    });
    expect(
      operationBatchResultSchema.safeParse({ done: -1, failed: 0, failures: dataset }).success
    ).toBe(false);
    expect(operationBatchResultSchema.safeParse({ done: 1, failed: 0, failures: [] }).success).toBe(
      false
    );
    expect(
      operationBatchFailureSchema.parse({
        item,
        code: "knowledge_item_invalid",
        message: "Invalid item"
      })
    ).toEqual({ item, code: "knowledge_item_invalid", message: "Invalid item" });
    expect(operationBatchFailureSchema.safeParse({ item, code: 1 }).success).toBe(false);
  });

  it("lists all five descriptors with their rights, key levels and flags", () => {
    expect(Object.keys(KNOWLEDGE_WRITE_OPERATIONS)).toEqual([
      "ingest",
      "withdraw",
      "pending",
      "put_processed",
      "extract_fields"
    ]);
    for (const part of [
      "ingest",
      "withdraw",
      "pending",
      "put_processed",
      "extract_fields"
    ] as const) {
      const contract = KNOWLEDGE_WRITE_OPERATIONS[part];
      expect(knowledgeWriteContracts[part]).toBe(contract);
      expect(contract.right).toBe(
        contract.effect === "changing" ? "knowledge_base.write" : "knowledge_base.read"
      );
      expect(contract.keyLevel).toBe(contract.effect === "changing" ? "write" : "read");
    }
    expect(KNOWLEDGE_WRITE_OPERATIONS.ingest).toMatchObject({
      effect: "changing",
      completion: "async",
      batch: true
    });
    expect(KNOWLEDGE_WRITE_OPERATIONS.put_processed).toMatchObject({
      effect: "changing",
      batch: true
    });
    expect(KNOWLEDGE_WRITE_OPERATIONS.pending).toMatchObject({ effect: "reading", dataset: true });
    expect(KNOWLEDGE_WRITE_OPERATIONS.withdraw).not.toHaveProperty("batch");
    expect(KNOWLEDGE_WRITE_OPERATIONS.extract_fields).not.toHaveProperty("batch");
  });

  it("parses inline and dataset ingestion and refuses absent or competing contents", () => {
    expectTypeOf<{
      itemId: string;
      version: string;
      name: string;
      text: string;
      fileId: string;
    }>().not.toExtend<KnowledgeIngestItem>();
    const schema = KNOWLEDGE_WRITE_OPERATIONS.ingest.inputSchema;
    expect(schema.parse({ items: [item], complete: true })).toEqual({
      items: [item],
      complete: true
    });
    expect(schema.parse({ dataset })).toEqual({ dataset });
    expect(
      schema.parse({
        items: [
          {
            ...item,
            text: undefined,
            fileId: "file-1",
            path: "/contracts/a.pdf",
            originLink: "https://example.test/a",
            metadata: { year: 2026 }
          }
        ]
      })
    ).toMatchObject({ items: [{ fileId: "file-1" }] });
    for (const content of [
      {},
      { text: "a", fileId: "f" },
      { text: "a", fetch: { connection: "crm", operation: "download", input: {} } },
      { fileId: "f", fetch: { connection: "crm", operation: "download", input: {} } }
    ]) {
      expect(
        schema.safeParse({ items: [{ itemId: "a", version: "1", name: "A", ...content }] }).success
      ).toBe(false);
    }
    for (const input of [
      null,
      "bad json",
      {},
      { items: [item], dataset },
      { items: [{ ...item, version: 2 }] }
    ])
      expect(schema.safeParse(input).success).toBe(false);
    const fetched = schema.safeParse({
      items: [
        { ...item, text: undefined, fetch: { connection: "crm", operation: "download", input: {} } }
      ]
    });
    expect(fetched.success).toBe(false);
    if (!fetched.success) expect(fetched.error.message).toContain("not_supported_yet");
    expect(
      KNOWLEDGE_WRITE_OPERATIONS.ingest.outputSchema.parse({
        accepted: 1000,
        done: 997,
        failed: 3,
        withdrawn: 10,
        failures: dataset
      })
    ).toMatchObject({ accepted: 1000, withdrawn: 10 });
  });

  it("uses the existing 25 MiB document limit for UTF-8 ingestion text", () => {
    expect(KNOWLEDGE_FILE_MAX_BYTES).toBe(25 * 1024 * 1024);
    const schema = KNOWLEDGE_WRITE_OPERATIONS.ingest.inputSchema;
    expect(
      schema.safeParse({ items: [{ ...item, text: "é".repeat(KNOWLEDGE_FILE_MAX_BYTES / 2) }] })
        .success
    ).toBe(true);
    expect(
      schema.safeParse({ items: [{ ...item, text: "é".repeat(KNOWLEDGE_FILE_MAX_BYTES / 2 + 1) }] })
        .success
    ).toBe(false);
    expect(
      schema.safeParse({ items: [{ ...item, text: "x".repeat(KNOWLEDGE_FILE_MAX_BYTES + 1) }] })
        .success
    ).toBe(false);
  });

  it("accepts connector provenance at its existing limits", () => {
    const schema = KNOWLEDGE_WRITE_OPERATIONS.ingest.inputSchema;
    for (const protocol of ["http:", "https:"]) {
      const prefix = `${protocol}//example.test/`;
      const provenance = {
        name: "n".repeat(1_000),
        path: `/${"p".repeat(3_999)}`,
        originLink: prefix + "a".repeat(4_000 - prefix.length)
      };
      expect(schema.parse({ items: [{ ...item, ...provenance }] })).toEqual({
        items: [{ ...item, ...provenance }]
      });
    }
  });

  it.each([
    ["empty name", { name: "" }],
    ["long name", { name: "n".repeat(1_001) }],
    ["relative path", { path: "contracts/a.pdf" }],
    ["long path", { path: `/${"p".repeat(4_000)}` }],
    ["JavaScript link", { originLink: "javascript:alert(1)" }],
    ["data link", { originLink: "data:text/html,<script>alert(1)</script>" }],
    ["FTP link", { originLink: "ftp://example.test/a" }],
    [
      "long link",
      { originLink: `https://example.test/${"a".repeat(4_001 - "https://example.test/".length)}` }
    ]
  ])("refuses connector provenance with %s", (_name, provenance) => {
    expect(
      KNOWLEDGE_WRITE_OPERATIONS.ingest.inputSchema.safeParse({
        items: [{ ...item, ...provenance }]
      }).success
    ).toBe(false);
  });

  it("parses withdrawal and pending references without inline page text", () => {
    expect(KNOWLEDGE_WRITE_OPERATIONS.withdraw.inputSchema.parse({ itemIds: ["a", "b"] })).toEqual({
      itemIds: ["a", "b"]
    });
    expect(KNOWLEDGE_WRITE_OPERATIONS.withdraw.outputSchema.parse({ withdrawn: 2 })).toEqual({
      withdrawn: 2
    });
    expect(
      KNOWLEDGE_WRITE_OPERATIONS.withdraw.inputSchema.safeParse({ itemIds: [1] }).success
    ).toBe(false);
    expect(
      KNOWLEDGE_WRITE_OPERATIONS.pending.inputSchema.parse({
        type: "kaufvertrag",
        since: "2026-10-17T10:00:00Z",
        limit: 200
      })
    ).toHaveProperty("limit", 200);
    expect(KNOWLEDGE_WRITE_OPERATIONS.pending.inputSchema.safeParse({ limit: 0 }).success).toBe(
      false
    );
    expect(KNOWLEDGE_WRITE_OPERATIONS.pending.outputSchema.parse({ documents: dataset })).toEqual({
      documents: dataset
    });
    expect(
      KNOWLEDGE_WRITE_OPERATIONS.pending.rowSchema.parse({
        id: "doc",
        type: "kaufvertrag",
        contentHash: "a".repeat(64),
        pages: dataset
      })
    ).toHaveProperty("pages", dataset);
    expect(
      KNOWLEDGE_WRITE_OPERATIONS.pending.rowSchema.safeParse({
        id: "doc",
        type: "default",
        contentHash: "bad",
        pages: []
      }).success
    ).toBe(false);
  });

  it("writes processor pages by dataset reference in inline items and item datasets", () => {
    expect(
      KNOWLEDGE_WRITE_OPERATIONS.put_processed.inputSchema.parse({
        items: [
          {
            documentId: "doc",
            contentHash: "a".repeat(64),
            workflowRevision: "revision-1",
            output: { ...processed, pages: dataset }
          }
        ]
      })
    ).toHaveProperty("items");
    expect(KNOWLEDGE_WRITE_OPERATIONS.put_processed.inputSchema.parse({ items: dataset })).toEqual({
      items: dataset
    });
    expect(
      KNOWLEDGE_WRITE_OPERATIONS.put_processed.outputSchema.parse({
        done: 1,
        failed: 0,
        failures: dataset
      })
    ).toHaveProperty("done", 1);
    const write = {
      documentId: "doc",
      contentHash: "a".repeat(64),
      workflowRevision: "revision-1",
      output: { ...processed, pages: { ...dataset, bytes: 5 * 1024 * 1024 } }
    };
    expect(KNOWLEDGE_WRITE_OPERATIONS.put_processed.inputSchema.parse({ items: [write] })).toEqual({
      items: [write]
    });
    for (const pages of [processed.pages, [], { ...dataset, rowCount: -1 }, "page text"]) {
      expect(
        KNOWLEDGE_WRITE_OPERATIONS.put_processed.inputSchema.safeParse({
          items: [{ ...write, output: { ...write.output, pages } }]
        }).success
      ).toBe(false);
    }
  });

  it("bounds materialized processor text by the existing document limit across pages", () => {
    const pages = [
      { page: 1, text: "é".repeat(KNOWLEDGE_FILE_MAX_BYTES / 4) },
      { page: 2, text: "é".repeat(KNOWLEDGE_FILE_MAX_BYTES / 4) }
    ];
    expect(parseKnowledgeProcessorOutput({ ...processed, pages })).toEqual({ ...processed, pages });
    const oversizedPages = pages.map((page) => ({ ...page, text: page.text + "é" }));
    expect(() => parseKnowledgeProcessorOutput({ ...processed, pages: oversizedPages })).toThrow(
      expect.objectContaining({ details: { reason: "knowledge_processor_output_invalid" } })
    );
  });

  it("validates processor output once, with ordered pages and valid document and section ranges", () => {
    expect(parseKnowledgeProcessorOutput(processed)).toEqual(processed);
    for (const invalid of [
      null,
      { ...processed, chunks: [] },
      {
        ...processed,
        pages: [
          { page: 2, text: "b" },
          { page: 1, text: "a" }
        ]
      },
      { ...processed, documents: [{ pageFrom: 2, pageTo: 1 }] },
      { ...processed, sections: [{ title: "Outside", pageFrom: 1, pageTo: 3 }] },
      { ...processed, pages: [{ page: 1, text: "x".repeat(KNOWLEDGE_FILE_MAX_BYTES + 1) }] }
    ]) {
      expect(knowledgeProcessorOutputSchema.safeParse(invalid).success).toBe(false);
      expect(() => parseKnowledgeProcessorOutput(invalid)).toThrow(
        expect.objectContaining({ details: { reason: "knowledge_processor_output_invalid" } })
      );
    }
  });

  it("freezes extracted field evidence beside document provenance", () => {
    const op = KNOWLEDGE_WRITE_OPERATIONS.extract_fields;
    expect(
      op.inputSchema.parse({
        documentId: "doc",
        schema: { type: "object", properties: { price: { type: "number" } } }
      })
    ).toHaveProperty("schema");
    const output = {
      path: "contracts/a.pdf",
      date: "2026-10-17",
      type: "kaufvertrag",
      fields: { price: { value: 50000, page: 2, quote: "Kaufpreis 50.000 EUR" } }
    };
    expect(op.outputSchema.parse(output)).toEqual(output);
    expect(
      op.outputSchema.safeParse({
        ...output,
        fields: { price: { value: 50000, page: 0, quote: "" } }
      }).success
    ).toBe(false);
    expect(op.inputSchema.safeParse({ documentId: "doc", schema: [] }).success).toBe(false);
  });

  it("reserves Workflow source ids and the failure and publish codes", () => {
    expect(
      knowledgeWorkflowSourceSchema.parse({
        id: "workflow:import",
        kind: "workflow",
        workflowId: "import"
      })
    ).toHaveProperty("workflowId", "import");
    expect(
      knowledgeWorkflowSourceSchema.safeParse({
        id: "workflow:other",
        kind: "workflow",
        workflowId: "import"
      }).success
    ).toBe(false);
    expect(KNOWLEDGE_SOURCE_FAILURE_CODES).toContain("knowledge_item_invalid");
    expect(KNOWLEDGE_SOURCE_FAILURE_CODES).toContain("knowledge_fetch_not_allowed");
    expect(KNOWLEDGE_DOCUMENT_FAILURE_CODES).toContain("knowledge_processor_output_invalid");
    expect(WORKFLOW_ERROR_CODES.processWriteOperation).toBe("process_workflow_write_operation");
  });

  it("refuses records with a pointer to the owning store.yaml", () => {
    expect(knowledgeRecordsRefusalSchema.safeParse(undefined).success).toBe(true);
    const result = knowledgeRecordsRefusalSchema.safeParse({ table: "properties" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("records");
      expect(result.error.message).toContain("store.yaml");
    }
  });

  it("keeps connector sources readable and freezes Workflow sources without a Connection", () => {
    const status = {
      items: { discovered: 0, fetched: 0, indexed: 0, failed: 0, withdrawn: 0 },
      failures: []
    };
    expect(
      knowledgeSourcesOutputSchema.parse({ sources: [{ id: "box", connection: "box", ...status }] })
    ).toHaveProperty("sources");
    expect(
      knowledgeSourcesOutputSchema.parse({
        sources: [{ id: "workflow:import", workflowId: "import", kind: "workflow", ...status }]
      })
    ).toHaveProperty("sources");
    expect(
      knowledgeSourcesOutputSchema.safeParse({
        sources: [{ id: "workflow:other", workflowId: "import", kind: "workflow", ...status }]
      }).success
    ).toBe(false);
  });

  it("returns the kind when reading and listing a Workflow", async () => {
    const folder = await mkdtemp(join(tmpdir(), "kbw0-kind-"));
    try {
      await mkdir(join(folder, "import"));
      for (const kind of [undefined, "data"]) {
        await writeFile(
          join(folder, "import", "workflow.yaml"),
          JSON.stringify({
            id: "import",
            name: "Import",
            kind,
            runAs: "runner",
            inputs: { type: "object" },
            outputs: { type: "object" },
            steps: [
              { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
              { id: "result", name: "Result", type: "output", input: {} }
            ]
          })
        );
        const source = createWorkflowFolderSource(folder);
        const revision = await source.read("import");
        if (kind === undefined) expect(revision?.manifest).not.toHaveProperty("kind");
        else expect(revision?.manifest).toHaveProperty("kind", kind);
        expect(await source.list()).toMatchObject([{ id: "import", kind: kind ?? "process" }]);
        expect(
          workflowSummarySchema.safeParse({
            id: "import",
            name: "Import",
            kind: kind ?? "process",
            definitionRevisionId: "r1",
            runnable: true,
            reasons: [],
            actions: ["workflow.read"]
          }).data
        ).toHaveProperty("kind", kind ?? "process");
      }
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("preserves an omitted kind and its revision fingerprint, refusing other kinds", () => {
    const manifest = {
      id: "import",
      name: "Import",
      runAs: "runner",
      inputs: { type: "object" },
      outputs: { type: "object" },
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
        { id: "result", name: "Result", type: "output", input: {} }
      ]
    };
    const parsed = parseWorkflowManifest(manifest);
    expect(parsed).toMatchObject({ ok: true, manifest });
    if (!parsed.ok) throw new Error("Manifest did not parse");
    expect(parsed.manifest).not.toHaveProperty("kind");
    expect(workflowManifestFingerprint(parsed.manifest)).toBe(
      "3473c31f8bed93fcbd35cd19e182dbdaf3ef18bb1bf3398c610eb1b844aa1909"
    );
    expect(parseWorkflowManifest({ ...manifest, kind: "process" })).toMatchObject({
      ok: true,
      manifest: { kind: "process" }
    });
    expect(parseWorkflowManifest({ ...manifest, kind: "data" })).toMatchObject({
      ok: true,
      manifest: { kind: "data" }
    });
    expect(parseWorkflowManifest({ ...manifest, kind: "other" })).toHaveProperty("ok", false);
  });
});
