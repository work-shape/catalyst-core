import { describe, expect, it } from "vitest";
import {
  RECORDS_PROPOSE_MAX_ITEMS_PER_CALL,
  RECORDS_PROPOSE_MAX_FIELDS_PER_ITEM,
  RECORDS_FLAGGED_MAX_ITEMS_PER_PAGE,
  DATA_STORE_ACTIONS,
  DATA_STORE_RECORD_OPERATIONS,
  GRANTABLE_ACTION_SCOPES,
  KNOWLEDGE_WRITE_OPERATIONS,
  dataStoreRecordFieldSchema,
  dataStoreRecordsRuleSchema,
  dataStoreRecordWithdrawalJob,
  recordEvidenceResultSchema
} from "@work-shape/catalyst-core";

const proposal = {
  knowledgeBaseId: "kb-1",
  documentId: "doc-1",
  kind: "contract",
  documentDate: "2026-10-17",
  path: "/Objects/A-1/contract.pdf",
  fields: [{ name: "amount", value: 12.5, page: 1, quote: "12.5" }]
};
const columns = [
  { name: "amount", type: "number", nullable: true },
  { name: "year", type: "integer", nullable: false },
  { name: "date", type: "date", nullable: false },
  { name: "tags", type: "text[]", nullable: false },
  { name: "computed", type: "number", nullable: true, generated: true }
] as const;

describe("REC-0 frozen records contracts", () => {
  it("keeps extraction's value, page and quote and freezes a per-item batch with a dedicated right", () => {
    const extracted = KNOWLEDGE_WRITE_OPERATIONS.extract_fields.outputSchema.parse({
      path: proposal.path,
      date: proposal.documentDate,
      type: proposal.kind,
      fields: { amount: { value: 12.5, page: 1, quote: "12.5" } }
    });
    const item = {
      ...proposal,
      fields: Object.entries(extracted.fields).map(([name, field]) => ({ name, ...field }))
    };
    const contract = DATA_STORE_RECORD_OPERATIONS.propose;
    expect(contract.inputSchema.parse({ table: "objects", items: [item] }).items).toEqual([
      proposal
    ]);
    expect(contract).toMatchObject({
      effect: "changing",
      batch: true,
      right: "data_store.records",
      keyLevel: "write"
    });
    const batch = { done: 1, failed: 0, failures: { $dataset: "failures", rowCount: 0, bytes: 0 } };
    expect(contract.outputSchema.parse(batch)).toEqual(batch);
    expect(DATA_STORE_ACTIONS.records).toBe("data_store.records");
    expect(GRANTABLE_ACTION_SCOPES["data_store.records"]).toEqual([
      "workspace",
      "asset",
      "instance"
    ]);
    expect(DATA_STORE_RECORD_OPERATIONS.decide).toMatchObject({
      effect: "changing",
      right: "data_store.records",
      keyLevel: "write"
    });
    expect(DATA_STORE_RECORD_OPERATIONS.flagged).toMatchObject({
      effect: "reading",
      right: "data_store.records",
      keyLevel: "read"
    });
  });

  it("bounds each proposal batch and flagged page while accepting a cursor for further pages", () => {
    const { propose, flagged } = DATA_STORE_RECORD_OPERATIONS;
    const batch = (count: number) => ({
      table: "objects",
      items: Array.from({ length: count }, () => proposal)
    });
    expect(propose.inputSchema.safeParse(batch(RECORDS_PROPOSE_MAX_ITEMS_PER_CALL)).success).toBe(
      true
    );
    expect(
      propose.inputSchema.safeParse(batch(RECORDS_PROPOSE_MAX_ITEMS_PER_CALL + 1)).success
    ).toBe(false);
    const item = (count: number) => ({
      ...proposal,
      fields: Array.from({ length: count }, (_, i) => ({
        ...proposal.fields[0],
        name: `field_${i}`
      }))
    });
    expect(
      propose.inputSchema.safeParse({
        table: "objects",
        items: [item(RECORDS_PROPOSE_MAX_FIELDS_PER_ITEM)]
      }).success
    ).toBe(true);
    expect(
      propose.inputSchema.safeParse({
        table: "objects",
        items: [item(RECORDS_PROPOSE_MAX_FIELDS_PER_ITEM + 1)]
      }).success
    ).toBe(false);
    expect(
      flagged.inputSchema.parse({ limit: RECORDS_FLAGGED_MAX_ITEMS_PER_PAGE, cursor: "next-page" })
    ).toEqual({ limit: RECORDS_FLAGGED_MAX_ITEMS_PER_PAGE, cursor: "next-page" });
    expect(
      flagged.inputSchema.safeParse({ limit: RECORDS_FLAGGED_MAX_ITEMS_PER_PAGE + 1 }).success
    ).toBe(false);
  });

  it("refuses an entire item for an unknown, duplicate, generated or incompatible field before the writer", () => {
    const schema = DATA_STORE_RECORD_OPERATIONS.propose.itemSchemaFor(columns);
    expect(schema.safeParse(proposal).success).toBe(true);
    for (const field of [
      { name: "missing", value: 1 },
      { name: "amount", value: "12.5" },
      { name: "year", value: 1.5 },
      { name: "year", value: null },
      { name: "date", value: "2026-02-30" },
      { name: "tags", value: [1] },
      { name: "computed", value: 2 }
    ]) {
      const parsed = schema.safeParse({
        ...proposal,
        fields: [...proposal.fields, { ...proposal.fields[0], ...field }]
      });
      expect(parsed.success, JSON.stringify(field)).toBe(false);
      if (!parsed.success)
        expect(parsed.error.issues[0]?.message).toContain("record_field_unknown");
    }
    expect(
      schema.safeParse({ ...proposal, fields: [...proposal.fields, ...proposal.fields] }).success
    ).toBe(false);
    for (const field of [
      { name: "amount", value: null },
      { name: "tags", value: ["a"] }
    ]) {
      expect(
        schema.safeParse({ ...proposal, fields: [{ ...proposal.fields[0], ...field }] }).success
      ).toBe(true);
    }
  });

  it("parses records rules with exactly one key source and a named path capture", () => {
    expect(
      dataStoreRecordsRuleSchema.parse({
        table: "objects",
        key: { column: "id", fromPath: "/Objects/{id}/" }
      })
    ).toEqual({
      table: "objects",
      key: { column: "id", fromPath: "/Objects/{id}/" },
      precedence: [],
      review: { always: [] },
      retainWithoutSource: false
    });
    expect(
      dataStoreRecordsRuleSchema.safeParse({
        table: "objects",
        key: { column: "id", fromField: "number" }
      }).success
    ).toBe(true);
    for (const key of [
      { column: "id" },
      { column: "id", fromPath: "/{id}/", fromField: "id" },
      { column: "id", fromPath: "/{other}/" },
      { column: "id", fromPath: "/{id}/{id}/" }
    ])
      expect(dataStoreRecordsRuleSchema.safeParse({ table: "objects", key }).success).toBe(false);
  });

  it("refuses malformed outside input and requires composite citation identity", () => {
    const { propose, decide, flagged } = DATA_STORE_RECORD_OPERATIONS;
    for (const input of [
      null,
      "not json",
      { table: "objects", items: [{ ...proposal, knowledgeBaseId: undefined }] },
      {
        table: "objects",
        items: [{ ...proposal, fields: [{ name: "amount", value: 1, page: 0, quote: "" }] }]
      }
    ]) {
      expect(propose.inputSchema.safeParse(input).success).toBe(false);
    }
    expect(
      decide.inputSchema.safeParse({
        table: "objects",
        key: "A-1",
        field: "amount",
        action: "correct",
        value: 15
      }).success
    ).toBe(true);
    expect(
      decide.inputSchema.safeParse({
        table: "objects",
        key: "A-1",
        field: "amount",
        action: "correct"
      }).success
    ).toBe(false);
    expect(
      decide.inputSchema.safeParse({
        table: "objects",
        key: "A-1",
        field: "amount",
        action: "assign",
        documentId: "doc-1"
      }).success
    ).toBe(false);
    expect(
      decide.inputSchema.safeParse({
        table: "objects",
        key: "A-1",
        field: "amount",
        action: "assign",
        documentId: "doc-1",
        knowledgeBaseId: "kb-1"
      }).success
    ).toBe(true);
    expect(flagged.inputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(flagged.inputSchema.parse({ table: "objects", limit: 10000 })).toEqual({
      table: "objects",
      limit: 10000
    });
    expect(
      recordEvidenceResultSchema.safeParse({ status: "passed", confidence: 0.99 }).success
    ).toBe(false);
    expect(
      recordEvidenceResultSchema.parse({ status: "failed", reason: "quote_not_found" })
    ).toEqual({ status: "failed", reason: "quote_not_found" });
    expect(
      dataStoreRecordFieldSchema.parse({
        ...proposal.fields[0],
        table: "objects",
        key: null,
        knowledgeBaseId: "kb-1",
        documentId: "doc-1",
        kind: "contract",
        documentDate: null,
        extractedAt: "2026-10-18T00:00:00Z",
        evidence: { status: "passed" },
        state: "extracted",
        decidedBy: null,
        decidedAt: null
      }).key
    ).toBeNull();
    expect(
      dataStoreRecordWithdrawalJob.payloadSchema.parse({
        knowledgeBaseId: "kb-1",
        documentId: "doc-1"
      })
    ).toEqual({ knowledgeBaseId: "kb-1", documentId: "doc-1" });
    expect(() =>
      dataStoreRecordWithdrawalJob.payloadSchema.parse({
        knowledgeBaseId: "kb-1",
        documentId: "doc-1",
        quote: "private"
      })
    ).toThrow();
  });
});
