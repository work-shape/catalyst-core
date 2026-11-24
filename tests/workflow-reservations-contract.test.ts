import { describe, expect, expectTypeOf, it } from "vitest";
import {
  WORKFLOW_ON_FAILURE_NOTIFY,
  WORKFLOW_RUN_KEY_MAX_LENGTH,
  dataStoreLoadInputSchema,
  dataStoreLoadResultSchema,
  operationPagingSchema,
  workflowDatasetReferenceSchema,
  workflowDatasetTypeSchema,
  workflowInputValueSchema,
  workflowOnFailureSchema,
  workflowPaginateSchema,
  workflowRunKeySchema,
  workflowRunLabelsSchema,
  workflowStepDatasetSchema,
  type WorkflowInputValue
} from "@work-shape/catalyst-core";

// What a definition, a run and a store may say that the contract reads before an engine runs
// it: datasets, paging, child runs, run keys, labels, schedules, limits and the load of a
// dataset. Spec: events-workflows-and-guardrails.md, Large data and fan-out.

describe("what the contract reserves for datasets and run keys", () => {
  // Fails without the reservations: a file written for datasets and child runs would be
  // refused as unknown by a release whose engine does not run them yet, and read differently
  // by the one that does.
  it("reads a dataset on an operation step and its paging", () => {
    expect(workflowStepDatasetSchema.parse({ at: "rows" })).toEqual({ at: "rows" });
    for (const refused of [{}, { at: "" }, { rows: "items" }, { at: "rows", pages: 3 }]) {
      expect(workflowStepDatasetSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false
      );
    }
    for (const paging of [
      { by: "page", param: "page", sizeParam: "page_size", size: 1000, start: 1 },
      { by: "offset", param: "offset", sizeParam: "limit", size: 200 },
      { by: "cursor", param: "after", cursor: "meta.next" },
      { by: "next_link", param: "url", cursor: "links.next" }
    ]) {
      expect(operationPagingSchema.parse(paging)).toEqual(paging);
    }
    for (const refused of [
      { by: "token", param: "t", cursor: "next" },
      { by: "page", param: "page" },
      { by: "cursor", param: "after" },
      { by: "page", param: "p", sizeParam: "s", size: 0 },
      { by: "cursor", param: "after", cursor: "next", size: 10 }
    ]) {
      expect(operationPagingSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(false);
    }
    // A step takes the paging of the operation's entry, or overrides fields of it.
    expect(workflowPaginateSchema.parse(true)).toBe(true);
    expect(workflowPaginateSchema.parse({ size: 500 })).toEqual({ size: 500 });
    for (const refused of [false, { size: 0 }, { pages: 3 }, { by: "token" }]) {
      expect(workflowPaginateSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false
      );
    }
  });

  it("holds a dataset in step data as a reference under a reserved key, typed by its row", () => {
    const byName = { type: "dataset", row: { $ref: "#/types/posting" } };
    expect(workflowDatasetTypeSchema.parse(byName)).toEqual(byName);
    expect(workflowDatasetTypeSchema.safeParse({ type: "dataset" }).success).toBe(false);
    expect(workflowDatasetTypeSchema.safeParse({ type: "dataset", row: "posting" }).success).toBe(
      false
    );
    expect(
      workflowDatasetTypeSchema.safeParse({ type: "array", row: { type: "object" } }).success
    ).toBe(false);

    const reference = { $dataset: "ds_1", rowCount: 20000, bytes: 4_000_000 };
    expect(workflowDatasetReferenceSchema.parse(reference)).toEqual(reference);
    for (const refused of [
      { rowCount: 1, bytes: 1 },
      { $dataset: "", rowCount: 1, bytes: 1 },
      { $dataset: "ds_1", rowCount: -1, bytes: 1 },
      { $dataset: "ds_1", rows: 1, bytes: 1 },
      { $dataset: "ds_1", rowCount: 1, bytes: 1, items: [] }
    ]) {
      expect(
        workflowDatasetReferenceSchema.safeParse(refused).success,
        JSON.stringify(refused)
      ).toBe(false);
    }
  });

  // Fails without the key: a second start of the same month had nothing to be told apart by,
  // so it ran every client again.
  it("tells a run apart by its key, describes it by labels and says who hears of a failure", () => {
    expect(workflowRunKeySchema.parse("2026-09/1402")).toBe("2026-09/1402");
    expect(workflowRunKeySchema.safeParse("").success).toBe(false);
    expect(
      workflowRunKeySchema.safeParse("k".repeat(WORKFLOW_RUN_KEY_MAX_LENGTH + 1)).success
    ).toBe(false);

    expect(workflowRunLabelsSchema.parse({ client: "1402", month: "2026-09" })).toEqual({
      client: "1402",
      month: "2026-09"
    });
    const nine = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`l${index}`, "x"]));
    for (const refused of [
      nine,
      { ["n".repeat(33)]: "x" },
      { client: "v".repeat(121) },
      { n: 1 }
    ]) {
      expect(workflowRunLabelsSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false
      );
    }

    expect(workflowOnFailureSchema.parse(WORKFLOW_ON_FAILURE_NOTIFY)).toBe("notify");
    expect(workflowOnFailureSchema.parse("workflow.on-failure")).toBe("workflow.on-failure");
    for (const refused of ["mail", "workflow.", "workflows.x", ""]) {
      expect(workflowOnFailureSchema.safeParse(refused).success, refused).toBe(false);
    }
  });
});

describe("one field of a step's input", () => {
  // Fails with a type of two open objects: `{ value, ref }` was a valid field, and which of
  // the two a step received was the engine's guess.
  it("is a literal or a reference, and never both", () => {
    expect(workflowInputValueSchema.parse({ value: ["a", 1, null] })).toEqual({
      value: ["a", 1, null]
    });
    const reference = { ref: { step: "start", path: "input.month" } };
    expect(workflowInputValueSchema.parse(reference)).toEqual(reference);
    for (const refused of [
      { value: 1, ...reference },
      {},
      { ref: { step: "", path: "" } },
      { ref: { step: "start" } },
      { value: 1, note: "x" }
    ]) {
      expect(workflowInputValueSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false
      );
    }
    expectTypeOf<{
      value: 1;
      ref: { step: string; path: string };
    }>().not.toExtend<WorkflowInputValue>();
  });
});

describe("the load of a dataset into a Data Store", () => {
  it("requires a complete explicit replacement group for an empty load", () => {
    const input = {
      table: "findings",
      dataset: { $dataset: "empty", rowCount: 0, bytes: 0 },
      key: ["client", "month", "rule"],
      replace: { by: ["client", "month"], values: { client: "1001", month: "2026-09" } }
    };
    expect(dataStoreLoadInputSchema.parse(input).replace).toEqual(input.replace);
    for (const replace of [
      { by: ["client", "month"], values: {} },
      { by: ["client", "month"], values: { client: "1001" } },
      { by: ["client"], values: { client: "1001", month: "2026-09" } },
      { by: ["client", "client"], values: { client: "1001" } },
      { by: ["client"], values: { client: { unexpected: true } } },
      { by: ["client"], values: { client: null } }
    ])
      expect(dataStoreLoadInputSchema.safeParse({ ...input, replace }).success).toBe(false);
  });

  // Fails without `load`: 20,000 rows of a run had no way into a table but one insert per row.
  it("reads a load of a dataset into a table, its key and what it answers", () => {
    const dataset = { $dataset: "ds_1", rowCount: 3, bytes: 300 };
    expect(dataStoreLoadInputSchema.parse({ table: "findings", dataset })).toEqual({
      table: "findings",
      dataset,
      onConflict: "fail"
    });
    const replacing = {
      table: "postings",
      dataset,
      columns: { amount: "amount_eur" },
      key: ["client", "month", "line"],
      onConflict: "update",
      replace: { by: ["client", "month"] }
    };
    expect(dataStoreLoadInputSchema.parse(replacing)).toEqual(replacing);
    for (const refused of [
      { table: "findings", dataset, onConflict: "skip" },
      { table: "findings", dataset, onConflict: "update" },
      { table: "findings", dataset, onConflict: "replace", key: ["id"] },
      { table: "findings", dataset, key: [] },
      { table: "findings", dataset, replace: { by: [] } },
      // Replace by key: without `key`, or by a column outside it, the load is refused.
      { table: "findings", dataset, replace: { by: ["client"] } },
      { table: "findings", dataset, key: ["client", "line"], replace: { by: ["month"] } },
      { table: "findings", dataset, truncate: true },
      // The dataset is the reference a step record holds, and nothing else.
      { table: "findings", dataset: "ds_1" },
      { table: "findings", dataset: { $dataset: "ds_1", rows: 3, bytes: 300 } }
    ]) {
      expect(dataStoreLoadInputSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false
      );
    }
    expect(
      dataStoreLoadResultSchema.parse({
        table: "postings",
        inserted: 2,
        updated: 1,
        skipped: 0,
        deleted: 4
      })
    ).toEqual({ table: "postings", inserted: 2, updated: 1, skipped: 0, deleted: 4 });
    expect(dataStoreLoadResultSchema.safeParse({ table: "postings", inserted: 2 }).success).toBe(
      false
    );
  });
});
