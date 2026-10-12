import { describe, expect, expectTypeOf, it } from "vitest";
import {
  DATA_STORE_LOAD_CHANGE_RIGHT,
  DATA_STORE_LOAD_CONFLICT_MODES,
  DATA_STORE_RESERVED_SCHEMA,
  WORKFLOW_DATASET_KEY,
  WORKFLOW_DATASET_TYPE,
  WORKFLOW_ERROR_CODES,
  WORKFLOW_LIST_OPERATION,
  WORKFLOW_LIST_STEP_RUNS_OPERATION,
  WORKFLOW_ON_FAILURE_NOTIFY,
  WORKFLOW_RUN_KEY_MAX_LENGTH,
  WORKFLOW_RUN_KEY_SEPARATOR,
  WORKFLOW_RUN_LABEL_LIMITS,
  WORKFLOW_RUN_DATASET_AUDIT_EVENTS,
  WORKFLOW_RUN_MAX_DEPTH,
  WORKFLOW_RUN_OBJECT_PREFIX,
  WORKFLOW_SCHEDULE_MISSED_MAX,
  WORKFLOW_SCHEDULE_MISSED_MODES,
  WORKFLOW_SCHEDULE_OVERLAP_MODES,
  WORKFLOW_START_KEY_INPUT,
  WORKFLOW_STEP_SLOTS_SETTING,
  WORKFLOW_TRIGGER_KINDS,
  asUserId,
  createPlatformId,
  workflowInputValueSchema,
  workflowLastRunSchema,
  workflowStepRunFilterSchema,
  type WorkflowInputValue,
  type WorkflowLastRun,
  type WorkflowRunRecordView,
  type WorkflowStepRunCall,
  type WorkflowStepRunFilter,
  type WorkflowStepRunPlacement,
  dataStoreLoadInputSchema,
  dataStoreLoadResultSchema,
  dataStoreOperationName,
  operationLimitsSchema,
  operationPagingSchema,
  workflowDatasetReferenceSchema,
  workflowDatasetTypeSchema,
  workflowOnFailureSchema,
  workflowPaginateSchema,
  workflowRetentionSchema,
  workflowRunKeySchema,
  workflowRunLabelsSchema,
  workflowScheduleOptionsSchema,
  workflowStepDatasetSchema,
  type WorkflowManifest,
  type WorkflowRunIdentity,
  type WorkflowRunLineage,
  type WorkflowStep,
  type WorkflowStepRunLink,
  type WorkflowTrigger,
  type WorkflowTriggerOutput
} from "@vivd-catalyst/core";

// What a definition, a run and a store may say that the contract reads before an engine runs
// it: datasets, paging, child runs, run keys, labels, schedules, limits and the load of a
// dataset. Spec: events-workflows-and-guardrails.md, Large data and fan-out.

const runId = createPlatformId<"WorkflowRunId">("wfr");
const stepRunId = createPlatformId<"WorkflowStepRunId">("wfs");

const manifest: WorkflowManifest = {
  id: "monthly-check",
  name: "Monthly check",
  runAs: "monthly-check",
  inputs: { type: "object", properties: { month: { type: "string" } } },
  outputs: { type: "object" },
  steps: [{ id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] }]
};

describe("what the contract reserves for datasets, child runs and run keys", () => {
  // Fails without the reservations: a file written for datasets and child runs would be
  // refused as unknown by a release whose engine does not run them yet, and read differently
  // by the one that does.
  it("reads a dataset on an operation step, its paging and a step that runs a child", () => {
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

    const read: WorkflowStep = {
      id: "postings",
      name: "Buchungen lesen",
      type: "operation",
      operation: "connection.accounting.list_postings",
      input: {},
      dataset: { at: "rows" },
      paginate: true
    };
    const child: WorkflowStep = {
      id: "check",
      name: "Mandant prüfen",
      type: "workflow",
      workflow: "client-month-check",
      input: { client_id: { ref: { step: "each_client", path: "id" } } }
    };
    expect([read.type, child.type]).toEqual(["operation", "workflow"]);
    // An operation step has no `wait`: a step that waits for a child is of type `workflow`.
    expectTypeOf<Extract<WorkflowStep, { type: "operation" }>>().not.toHaveProperty("wait");
    const parent: WorkflowTrigger = { kind: "parent" };
    expect(WORKFLOW_TRIGGER_KINDS).toContain(parent.kind);
  });

  it("holds a dataset in step data as a reference under a reserved key, typed by its row", () => {
    expect(WORKFLOW_DATASET_KEY).toBe("$dataset");
    expect(WORKFLOW_DATASET_TYPE).toBe("dataset");
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

  it("keeps the retention and the row types on the manifest and the start time on the trigger", () => {
    expect(workflowRetentionSchema.parse({ datasets: 30 })).toEqual({ datasets: 30 });
    expect(workflowRetentionSchema.parse({})).toEqual({});
    expect(workflowRetentionSchema.safeParse({ datasets: 0 }).success).toBe(false);
    expect(workflowRetentionSchema.safeParse({ runs: 30 }).success).toBe(false);

    const withData: WorkflowManifest = {
      ...manifest,
      retention: { datasets: 30 },
      types: { posting: { type: "object", properties: { amount: { type: "number" } } } }
    };
    expect(Object.keys(withData.types ?? {})).toEqual(["posting"]);
    const started: WorkflowTriggerOutput = {
      input: { month: "2026-09" },
      startedAt: "2026-10-01T04:00:00.000Z",
      trigger: "schedule",
      scheduledFor: "2026-10-01T04:00:00.000Z"
    };
    expectTypeOf<keyof WorkflowTriggerOutput>().toEqualTypeOf<
      "input" | "startedAt" | "trigger" | "scheduledFor"
    >();
    expectTypeOf<WorkflowTriggerOutput["scheduledFor"]>().toEqualTypeOf<string | null>();
    expect(started.trigger).toBe("schedule");
    // The order of the steps is the order of the list: a definition has no `wiring`.
    expectTypeOf<WorkflowManifest>().not.toHaveProperty("wiring");
  });

  // Fails without the key: a second start of the same month had nothing to be told apart by,
  // so it ran every client again.
  it("tells a run apart by its key, describes it by labels and says who hears of a failure", () => {
    expect(WORKFLOW_START_KEY_INPUT).toBe("key");
    expect(WORKFLOW_RUN_KEY_SEPARATOR).toBe("/");
    expect(workflowRunKeySchema.parse("2026-09/1402")).toBe("2026-09/1402");
    expect(workflowRunKeySchema.safeParse("").success).toBe(false);
    expect(
      workflowRunKeySchema.safeParse("k".repeat(WORKFLOW_RUN_KEY_MAX_LENGTH + 1)).success
    ).toBe(false);

    expect(WORKFLOW_RUN_LABEL_LIMITS).toEqual({ pairs: 8, name: 32, value: 120 });
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

    const keyed: WorkflowStep = {
      id: "check",
      name: "Mandant prüfen",
      type: "workflow",
      workflow: "client-month-check",
      input: {},
      key: [
        { ref: { step: "start", path: "input.month" } },
        { ref: { step: "each_client", path: "id" } }
      ]
    };
    const labelled: WorkflowManifest = {
      ...manifest,
      labels: { month: { ref: { step: "start", path: "input.month" } } },
      onFailure: "workflow.on-failure",
      steps: [keyed]
    };
    const run: WorkflowRunIdentity = { runKey: "2026-09/1402", labels: { month: "2026-09" } };
    // A step answered an existing run links to it and does not own it.
    const link: WorkflowStepRunLink = { linkedRunId: runId };
    expect([labelled.onFailure, run.runKey, link.linkedRunId]).toEqual([
      "workflow.on-failure",
      "2026-09/1402",
      runId
    ]);
    expect(WORKFLOW_STEP_SLOTS_SETTING).toBe("workflows.stepSlots");
  });

  it("reads what a schedule does with a missed tick and an overlapping one, and a source's limits", () => {
    expect(WORKFLOW_SCHEDULE_MISSED_MODES).toEqual(["skip", "last", "all"]);
    expect(WORKFLOW_SCHEDULE_OVERLAP_MODES).toEqual(["skip", "queue"]);
    expect(WORKFLOW_SCHEDULE_MISSED_MAX).toBe(100);
    expect(workflowScheduleOptionsSchema.parse({})).toEqual({ missed: "last", overlap: "skip" });
    expect(workflowScheduleOptionsSchema.parse({ missed: "all", overlap: "queue" })).toEqual({
      missed: "all",
      overlap: "queue"
    });
    expect(workflowScheduleOptionsSchema.safeParse({ missed: "first" }).success).toBe(false);
    expect(workflowScheduleOptionsSchema.safeParse({ overlap: "cancel" }).success).toBe(false);
    const trigger: WorkflowTrigger = {
      kind: "schedule",
      cron: "0 4 1 * *",
      missed: "all",
      overlap: "queue"
    };
    expect(trigger.kind).toBe("schedule");

    const limits = { concurrency: 2, perPeriod: { calls: 60, seconds: 60 } };
    expect(operationLimitsSchema.parse(limits)).toEqual(limits);
    expect(operationLimitsSchema.parse({})).toEqual({});
    for (const refused of [
      { concurrency: 0 },
      { perPeriod: { calls: 60 } },
      { perPeriod: { calls: 0, seconds: 60 } },
      { perMinute: 60 }
    ]) {
      expect(operationLimitsSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(false);
    }
  });

  it("places a child run under the run and the step that started it, three levels deep at most", () => {
    const root: WorkflowRunLineage = { rootRunId: runId, depth: 0 };
    const child: WorkflowRunLineage = {
      parentRunId: runId,
      parentStepRunId: stepRunId,
      rootRunId: runId,
      depth: root.depth + 1,
      itemIndex: 411,
      itemLabel: "10843"
    };
    expect(child.depth).toBeLessThanOrEqual(WORKFLOW_RUN_MAX_DEPTH);
    expect(WORKFLOW_RUN_MAX_DEPTH).toBe(2);
    expect(WORKFLOW_RUN_OBJECT_PREFIX).toBe("workflow-runs/");
    expect(WORKFLOW_RUN_DATASET_AUDIT_EVENTS).toEqual({
      created: "workflow_run.dataset_created",
      loaded: "workflow_run.dataset_loaded",
      downloaded: "workflow_run.dataset_downloaded",
      deleted: "workflow_run.dataset_deleted"
    });
    expect(WORKFLOW_ERROR_CODES).toEqual({
      datasetLimit: "dataset_limit",
      datasetExpired: "dataset_expired",
      depthLimit: "depth_limit",
      rateLimited: "rate_limited",
      notSupported: "not_supported_yet"
    });
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

describe("what the run view reads of a run and its step runs", () => {
  // Fails without these: the screens had no shared name for where a step run stands in the
  // tree of its run, so the list of a loop's items could not be asked for.
  it("places a step run in its block, names what an operation step called and filters the list", () => {
    const placed: WorkflowStepRunPlacement = {
      containerStepRunId: stepRunId,
      branch: "then",
      iteration: { index: 411, label: "10843" }
    };
    const called: WorkflowStepRunCall = { effect: "reading", source: "accounting" };
    const run: WorkflowRunRecordView = {
      definitionRevisionId: "cfgr_1",
      cancelledBy: asUserId("user-1"),
      cancelledAt: "2026-10-12T10:00:00.000Z"
    };
    expect([placed.branch, called.source, run.definitionRevisionId]).toEqual([
      "then",
      "accounting",
      "cfgr_1"
    ]);

    expect(WORKFLOW_LIST_OPERATION).toBe("workflows.list");
    expect(WORKFLOW_LIST_STEP_RUNS_OPERATION).toBe("workflows.list_step_runs");
    const filter: WorkflowStepRunFilter = workflowStepRunFilterSchema.parse({
      containerStepRunId: stepRunId,
      status: "failed",
      iteration: 3
    });
    expect(filter).toEqual({ containerStepRunId: stepRunId, status: "failed", iteration: 3 });
    expect(workflowStepRunFilterSchema.parse({})).toEqual({});
    for (const refused of [{ status: "broken" }, { iteration: -1 }, { stepId: "check" }]) {
      expect(workflowStepRunFilterSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(
        false
      );
    }

    const lastRun: WorkflowLastRun = workflowLastRunSchema.parse({
      id: runId,
      status: "done",
      startedAt: "2026-10-01T04:00:00.000Z",
      endedAt: "2026-10-01T04:12:00.000Z"
    });
    expect(lastRun.status).toBe("done");
    expect(workflowLastRunSchema.safeParse({ id: runId, status: "finished" }).success).toBe(false);
  });
});

describe("the load of a dataset into a Data Store", () => {
  // Fails without `load`: 20,000 rows of a run had no way into a table but one insert per row.
  it("reads a load of a dataset into a table, its key and what it answers", () => {
    expect(DATA_STORE_LOAD_CONFLICT_MODES).toEqual(["fail", "skip", "update"]);
    expect(DATA_STORE_LOAD_CHANGE_RIGHT).toBe("data_store.execute");
    expect(DATA_STORE_RESERVED_SCHEMA).toBe("catalyst");
    expect(dataStoreOperationName("findings", "load")).toBe("data_store.findings.load");

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
