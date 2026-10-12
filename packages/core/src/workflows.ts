import { z } from "zod";
import type { AssetKindActions } from "./asset-kinds";
import type { WorkflowRunId, WorkflowStepRunId } from "./ids";
import type { JsonObject, JsonValue } from "./json";
import type { PlatformAction } from "./permissions";

// The names and shapes of a Workflow that more than one package reads: the asset kind, the
// parsed `workflow.yaml`, a run and its step runs, who a run acts as, and what its jobs and
// its operations are called. The engine is in `@vivd-catalyst/workflows`.

/** The asset kind of a Workflow. Spec: events-workflows-and-guardrails.md, build order EW-5. */
export const WORKFLOW_ASSET_KIND = "workflow";

/** The file of a Workflow's folder that holds its definition. Spec: Workflow definition. */
export const WORKFLOW_MANIFEST_FILE = "workflow.yaml";

/** The folder of a Workflow that holds the files its steps name. Spec: Workflow definition. */
export const WORKFLOW_STEP_FILES_FOLDER = "steps";

/**
 * The step types a definition may name. Spec: Workflow definition, step types in v1. The spec
 * also names `condition`, `approval` and `delay`; each joins this list with the slice that
 * executes it, so that no definition is accepted that no engine runs.
 */
export const WORKFLOW_STEP_TYPES = [
  "trigger",
  "operation",
  "loop",
  "code",
  "output",
  "agent",
  "notify",
  "workflow"
] as const;

export type WorkflowStepType = (typeof WORKFLOW_STEP_TYPES)[number];

/**
 * What may start a run. Spec: Workflow definition, triggers. The spec also names `form`,
 * `webhook`, `platform_event` and `connector_event`; each joins with the slice that fires it.
 */
export const WORKFLOW_TRIGGER_KINDS = ["manual", "schedule", "parent"] as const;

export type WorkflowTriggerKind = (typeof WORKFLOW_TRIGGER_KINDS)[number];

export type WorkflowTrigger =
  | { kind: "manual" }
  /** A cron expression, read in the time zone of the instance. */
  | {
      kind: "schedule";
      cron: string;
      /** The ticks that were due while the instance was down. `last` when left out. */
      missed?: WorkflowScheduleMissedMode;
      /** A tick that comes due while the run of an earlier tick is open. `skip` when left out. */
      overlap?: WorkflowScheduleOverlapMode;
    }
  /**
   * A `workflow` step of another Workflow may start this one as its child run. A Workflow
   * whose only trigger this is, is started by a parent and by nothing else.
   */
  | { kind: "parent" };

/**
 * The output of a trigger step, fixed by the engine: the run's input, when the run started as
 * an ISO time, and the kind of trigger that started it. A later step references `input.<field>`
 * and `startedAt`, so a run a schedule started can name its period.
 */
export interface WorkflowTriggerOutput {
  input: JsonObject;
  startedAt: string;
  trigger: WorkflowTriggerKind;
  /**
   * The scheduled time of the tick that started the run, as an ISO time, and null for every
   * other trigger. It is the identity of a scheduled run and its run key, so a tick fires once.
   */
  scheduledFor: string | null;
}

/**
 * `missed` of a `schedule` trigger: none of the ticks that were due while the instance was
 * down fires, the latest does, or each does in order, at most `WORKFLOW_SCHEDULE_MISSED_MAX`.
 */
export const WORKFLOW_SCHEDULE_MISSED_MODES = ["skip", "last", "all"] as const;

export type WorkflowScheduleMissedMode = (typeof WORKFLOW_SCHEDULE_MISSED_MODES)[number];

export const WORKFLOW_SCHEDULE_MISSED_MAX = 100;

/**
 * `overlap` of a `schedule` trigger: the tick is recorded as skipped, or its run starts when
 * the earlier one ended.
 */
export const WORKFLOW_SCHEDULE_OVERLAP_MODES = ["skip", "queue"] as const;

export type WorkflowScheduleOverlapMode = (typeof WORKFLOW_SCHEDULE_OVERLAP_MODES)[number];

/** The options of a `schedule` trigger as the definition's schema reads them, with defaults. */
export const workflowScheduleOptionsSchema = z.object({
  missed: z.enum(WORKFLOW_SCHEDULE_MISSED_MODES).default("last"),
  overlap: z.enum(WORKFLOW_SCHEDULE_OVERLAP_MODES).default("skip")
});

/**
 * The key of a run: free text. Among the runs of one Workflow that are open or `done` a key
 * exists once, and a start with such a key starts nothing and answers that run. A run that
 * ended `failed`, `cancelled` or `limit_reached` does not hold its key.
 */
export const WORKFLOW_RUN_KEY_MAX_LENGTH = 200;

export const workflowRunKeySchema = z.string().min(1).max(WORKFLOW_RUN_KEY_MAX_LENGTH);

/**
 * The field of the start operation's input that holds the run key, beside the Workflow's own
 * inputs. No Workflow declares an input of this name.
 */
export const WORKFLOW_START_KEY_INPUT = "key";

/** What joins the parts of the `key` of a `workflow` step into the run key. */
export const WORKFLOW_RUN_KEY_SEPARATOR = "/";

/**
 * The labels of a run: names with text values that describe it, such as a client or a month.
 * A label is not unique and no identity; the runs list filters on it. It is shown wherever
 * the run is listed, so it holds a name or a number and no content.
 */
export const WORKFLOW_RUN_LABEL_LIMITS = { pairs: 8, name: 32, value: 120 } as const;

export const workflowRunLabelsSchema = z
  .record(
    z.string().min(1).max(WORKFLOW_RUN_LABEL_LIMITS.name),
    z.string().max(WORKFLOW_RUN_LABEL_LIMITS.value)
  )
  .refine((labels) => Object.keys(labels).length <= WORKFLOW_RUN_LABEL_LIMITS.pairs, {
    message: `A run carries at most ${WORKFLOW_RUN_LABEL_LIMITS.pairs} labels`
  });

export type WorkflowRunLabels = z.infer<typeof workflowRunLabelsSchema>;

/**
 * `onFailure` of a manifest, for a run that ends `failed` or `limit_reached`. `notify`, the
 * default, puts a notice in the Inbox of the person who published the revision.
 * `workflow.<id>` starts that Workflow instead, as the failed Workflow's principal.
 */
export const WORKFLOW_ON_FAILURE_NOTIFY = "notify";

export type WorkflowOnFailure = typeof WORKFLOW_ON_FAILURE_NOTIFY | `workflow.${string}`;

export const workflowOnFailureSchema = z.union([
  z.literal(WORKFLOW_ON_FAILURE_NOTIFY),
  z.templateLiteral(["workflow.", z.string().min(1)])
]);

/** The release setting that says how many step jobs one process runs at once. */
export const WORKFLOW_STEP_SLOTS_SETTING = "workflows.stepSlots";

/**
 * A field of the output of an earlier step, by the id of that step and the dotted path of the
 * field. An empty path is the whole output. Inside a loop the id of the loop step names the
 * current item. After a loop its id names the loop's output, which is its counts
 * (`WorkflowLoopOutput`) and never the results of its items. Spec: Step inputs, outputs and
 * references.
 */
export interface WorkflowReference {
  step: string;
  path: string;
}

/** One field of a step's input: a literal, or a reference. A mapping holds no expression. */
export type WorkflowInputValue = { value: JsonValue } | { ref: WorkflowReference };

/** The input of a step, by the field names of its input schema. */
export type WorkflowInputMapping = Readonly<Record<string, WorkflowInputValue>>;

interface WorkflowStepBase {
  /** Unique in the definition. References and step runs name the step by it. */
  id: string;
  /** What a person calls the step, in the language of whoever builds the Workflow. */
  name: string;
  /** One plain sentence on what the step does, in the same language. The run page shows it. */
  description?: string;
}

/** The schemas a step declares itself, as JSON Schema. An operation step takes its operation's. */
interface WorkflowDeclaredSchemas {
  inputSchema: JsonObject;
  outputSchema: JsonObject;
}

export type WorkflowStep =
  /**
   * Starts the run. Its output is `WorkflowTriggerOutput`, whose `input` is the run's input,
   * checked against the definition's `inputs`.
   */
  | (WorkflowStepBase & { type: "trigger"; triggers: readonly WorkflowTrigger[] })
  /** Calls one operation by its name as one Operation Run. */
  | (WorkflowStepBase & {
      type: "operation";
      operation: string;
      input: WorkflowInputMapping;
      /** Writes a list of the answer into a dataset of the run instead of the step record. */
      dataset?: WorkflowStepDataset;
      /**
       * Calls the operation page after page into that dataset. `true` takes the paging the
       * operation's Connection entry declares; an object overrides fields of it.
       */
      paginate?: WorkflowPaginate;
    })
  /**
   * Starts a run of another published Workflow as a child run, waits for it and returns its
   * result. `workflow` is the id of the child, which lists the trigger `parent`; `input` maps
   * onto the child's `inputs`. An `operation` step that calls `workflow.<id>.start` starts an
   * independent run instead and returns its id.
   */
  | (WorkflowStepBase & {
      type: "workflow";
      workflow: string;
      input: WorkflowInputMapping;
      /**
       * The run key of the child: literals and references, joined with
       * `WORKFLOW_RUN_KEY_SEPARATOR`. A step answered an existing run links to it
       * (`WorkflowStepRunLink`).
       */
      key?: readonly WorkflowInputValue[];
    })
  /**
   * Runs its steps in order for each item of a list or of a dataset. Its output is
   * `WorkflowLoopOutput`: how many items ended how, and never the list of its items' results.
   * What an item produces is kept by a step of the loop, such as an insert into a Data Store.
   */
  | (WorkflowStepBase & {
      type: "loop";
      items: WorkflowReference;
      /** What one item is called in a sentence, such as "Mandant". The page counts in it. */
      itemName?: string;
      /**
       * The dotted path of the field of an item that labels its iteration for a person, such
       * as a number and a name. The engine keeps its value on the step run as `label`.
       */
      itemLabel?: string;
      /** What a failed item does to the loop (`WORKFLOW_LOOP_ITEM_FAILURE_MODES`). */
      onItemFailure?: WorkflowLoopItemFailureMode;
      /** How many items run at once, from 1 to `WORKFLOW_LOOP_MAX_CONCURRENCY`. 1 when left out. */
      concurrency?: number;
      /**
       * A reference into the output of the loop's last step. The loop then also returns
       * `results`: one dataset with a row per item, or with every row of the datasets the
       * items returned.
       */
      collect?: WorkflowReference;
      steps: readonly WorkflowStep[];
    })
  /** Runs one script file of the step files folder on its input as JSON and returns JSON. */
  | (WorkflowStepBase &
      WorkflowDeclaredSchemas & { type: "code"; file: string; input: WorkflowInputMapping })
  /** The run's result, checked against the definition's `outputs`. */
  | (WorkflowStepBase & { type: "output"; input: WorkflowInputMapping })
  /** Runs an agent task with the instructions of one step file and returns JSON. */
  | (WorkflowStepBase &
      WorkflowDeclaredSchemas & {
        type: "agent";
        instructions: string;
        input: WorkflowInputMapping;
      })
  /** Puts a notice into an Inbox or sends a mail through the platform mailer. */
  | (WorkflowStepBase & {
      type: "notify";
      channel: "inbox" | "mail";
      input: WorkflowInputMapping;
    });

/**
 * What a definition may say that this release reads and its engine may not run yet: `dataset`
 * and `paginate` on an operation step, the step type `workflow` and the trigger kind `parent`,
 * `concurrency`, `onItemFailure` and `collect` on a loop, `retention` and `types` on the
 * manifest, and the type `dataset` in a step schema. They are in
 * the contract so that a file written for them is read by every later release. An engine that
 * does not run one refuses the definition on save with `WORKFLOW_ERROR_CODES.notSupported` and
 * the name of the field. It never ignores one. Spec: Large data and fan-out.
 */

/**
 * What a failed item does to its loop. An item has failed when one of its steps has, after
 * that step's attempts.
 *
 * `stop`, the default: the loop step fails with the item, no further item starts, and the run
 * fails at the loop.
 *
 * `continue`: the other items run. The loop step ends `done`, and so does a run that fails
 * nowhere else, with the failed items counted in `failed` and listed in the dataset
 * `failures`. A failed item may be run again within the same run: its steps get new step
 * runs, so new idempotency keys. An item that is a child run is resumed as that run.
 */
export const WORKFLOW_LOOP_ITEM_FAILURE_MODES = ["stop", "continue"] as const;

export type WorkflowLoopItemFailureMode = (typeof WORKFLOW_LOOP_ITEM_FAILURE_MODES)[number];

/** The most items of one loop that run at once. A release setting may lower it. */
export const WORKFLOW_LOOP_MAX_CONCURRENCY = 8;

/**
 * The options of a loop step as the definition's schema reads them, with their defaults. The
 * schema of the definition spreads `shape` into its loop step.
 */
export const workflowLoopOptionsSchema = z.object({
  onItemFailure: z.enum(WORKFLOW_LOOP_ITEM_FAILURE_MODES).default("stop"),
  concurrency: z.number().int().min(1).max(WORKFLOW_LOOP_MAX_CONCURRENCY).default(1),
  collect: z.strictObject({ step: z.string().min(1), path: z.string() }).optional()
});

/**
 * How an operation is called page after page. It is defined once, for every operation: the
 * entry of an accepted operation of a Connection carries it as `paging`, because how an
 * outside system pages is a fact about that system. `page` counts pages in the input field
 * `param`, from `start` (1 unless set), with the page size `size` in `sizeParam`, and ends at
 * a page that is empty or shorter than `size`. `offset` is the same with the number of rows
 * read so far in `param`. `cursor` puts the value at the path `cursor` of one answer into
 * `param` of the next call and ends when it is absent, null or empty. `next_link` is `cursor`
 * with an address. Only a reading operation is paged. Spec: Large data and fan-out, Dataset.
 */
export const operationPagingSchema = z.discriminatedUnion("by", [
  z.strictObject({
    by: z.enum(["page", "offset"]),
    param: z.string().min(1),
    sizeParam: z.string().min(1),
    size: z.number().int().min(1),
    start: z.number().int().min(0).optional()
  }),
  z.strictObject({
    by: z.enum(["cursor", "next_link"]),
    param: z.string().min(1),
    cursor: z.string().min(1)
  })
]);

export type OperationPaging = z.infer<typeof operationPagingSchema>;

/**
 * The limits of an operation toward its outside system, on the entry of an accepted operation
 * of a Connection beside `paging`: how many calls run at once, and how many start within a
 * number of seconds. The call path holds them for the whole instance, across runs and for
 * every page of a paged step.
 */
export const operationLimitsSchema = z.strictObject({
  concurrency: z.number().int().min(1).optional(),
  perPeriod: z
    .strictObject({ calls: z.number().int().min(1), seconds: z.number().int().min(1) })
    .optional()
});

export type OperationLimits = z.infer<typeof operationLimitsSchema>;

/**
 * `paginate` of an operation step: `true` takes the `paging` of the operation's entry, and an
 * object names the fields of it that the step overrides. Whether the result is one whole form
 * is checked on save, against the entry.
 */
export const workflowPaginateSchema = z.union([
  z.literal(true),
  z.strictObject({
    by: z.enum(["page", "offset", "cursor", "next_link"]).optional(),
    param: z.string().min(1).optional(),
    sizeParam: z.string().min(1).optional(),
    size: z.number().int().min(1).optional(),
    start: z.number().int().min(0).optional(),
    cursor: z.string().min(1).optional()
  })
]);

export type WorkflowPaginate = z.infer<typeof workflowPaginateSchema>;

/**
 * `dataset` of an operation step. `at` is the dotted path of the list in the operation's
 * answer. A later step references the dataset at the same path.
 */
export const workflowStepDatasetSchema = z.strictObject({ at: z.string().min(1) });

export type WorkflowStepDataset = z.infer<typeof workflowStepDatasetSchema>;

/**
 * The type of a field of a step schema that holds a dataset: `{ type: "dataset", row }`, where
 * `row` is the JSON Schema of one row, or `{ $ref: "#/types/<name>" }` for one the definition
 * declares under `types`. It is the one keyword the platform adds to JSON Schema.
 */
export const WORKFLOW_DATASET_TYPE = "dataset";

export const workflowDatasetTypeSchema = z.strictObject({
  type: z.literal(WORKFLOW_DATASET_TYPE),
  row: z.record(z.string(), z.unknown())
});

/**
 * The key that marks a dataset in step data. A step record never holds the rows of a dataset,
 * it holds this reference. No field of an input or an output a definition declares may be
 * named so.
 */
export const WORKFLOW_DATASET_KEY = "$dataset";

/** A dataset as a step record holds it: its id, how many rows and how many bytes. */
export const workflowDatasetReferenceSchema = z.strictObject({
  [WORKFLOW_DATASET_KEY]: z.string().min(1),
  rowCount: z.number().int().min(0),
  bytes: z.number().int().min(0)
});

export type WorkflowDatasetReference = z.infer<typeof workflowDatasetReferenceSchema>;

/** `retention` of a manifest: for how many days the datasets of a run's result are kept. */
export const workflowRetentionSchema = z.strictObject({
  datasets: z.number().int().min(1).optional()
});

export type WorkflowRetention = z.infer<typeof workflowRetentionSchema>;

/**
 * `workflow.yaml` as it is read. Its steps run in the order of the list, and the steps of a
 * loop are nested in it: the file has no `wiring`, and its schema is strict, so a file that
 * carries one is refused. A branch comes later as a nested block of steps (`then`, `else`),
 * not as edges. Spec: Workflow definition.
 */
export interface WorkflowManifest {
  /** Stable and lowercase. It is part of `workflow.<id>.start`, so it holds no dot. */
  id: string;
  name: string;
  description?: string;
  /**
   * The `name` of the service principal a run of this Workflow acts as (`WorkflowRunPrincipal`,
   * `ServicePrincipalRecord.name`): a slug, unique on the instance and never changed, so the
   * definition moves between instances unchanged. Making a revision live that names a
   * principal, and a test run of a draft that names one, need what administering service
   * principals needs (`WORKFLOW_RUN_AS_ACTION` and the rule beside it in the server). A
   * definition without it is refused on save. Spec: Who a run acts as.
   */
  runAs: string;
  /** The schema of the run's input, as JSON Schema: the output schema of the trigger step. */
  inputs: JsonObject;
  /** The schema of the run's result, as JSON Schema: the input schema of the output step. */
  outputs: JsonObject;
  /**
   * The labels every run of the Workflow carries: each a literal or a reference into the
   * output of the trigger step. Within `WORKFLOW_RUN_LABEL_LIMITS`.
   */
  labels?: WorkflowInputMapping;
  /** Who hears of a run that ends `failed` or `limit_reached`. `notify` when left out. */
  onFailure?: WorkflowOnFailure;
  /** How long the datasets of a run's result are kept. The release default when left out. */
  retention?: WorkflowRetention;
  /**
   * The row types of the definition's datasets, by name, each as JSON Schema of one row. A
   * step schema names one as `{ type: "dataset", row: { $ref: "#/types/<name>" } }`.
   */
  types?: Readonly<Record<string, JsonObject>>;
  /** The names of the operations an agent step of this Workflow may call as tools. */
  tools?: readonly string[];
  steps: readonly WorkflowStep[];
}

/** `test` runs the draft with changing operations blocked. Spec: Draft, test run and go-live. */
export const WORKFLOW_RUN_MODES = ["live", "test"] as const;

export type WorkflowRunMode = (typeof WORKFLOW_RUN_MODES)[number];

/** Spec: Engine on the shared job executor, statuses. */
export const WORKFLOW_RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "done",
  "failed",
  "cancelled",
  "limit_reached"
] as const;

export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

/** The statuses of a run without `limit_reached`: a usage limit stops a run, not one step. */
export const WORKFLOW_STEP_RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "done",
  "failed",
  "cancelled"
] as const;

export type WorkflowStepRunStatus = (typeof WORKFLOW_STEP_RUN_STATUSES)[number];

/**
 * Where a step run stands in its loop. `index` is the row's `iteration`, counted from zero, and
 * `label` is the value of the loop's `itemLabel` field for that item. A step outside a loop
 * has none.
 */
export interface WorkflowStepRunIteration {
  index: number;
  label?: string;
}

/**
 * How far the step run of a loop step is, counted by the engine so that no reader counts the
 * step runs of the items itself. An item is done when its last step is, and failed when one of
 * its steps is. With `onItemFailure: "continue"` a loop step that is `done` may count failed
 * items. These are the counts of the page, as they stand now: an item that is run again
 * leaves `failed` and is counted where it then stands.
 */
export interface WorkflowLoopCounts {
  total: number;
  done: number;
  failed: number;
  running: number;
}

/**
 * The output of a loop step, which a later step references: the counts as they stood when the
 * loop ended. It holds no result of an item. `results` is there where the loop names
 * `collect`, and `failures` where it continued past a failed item: a dataset with one row per
 * failed item (`WorkflowLoopFailure`).
 */
export interface WorkflowLoopOutput extends Omit<WorkflowLoopCounts, "running"> {
  results?: WorkflowDatasetReference;
  failures?: WorkflowDatasetReference;
}

/** One row of the dataset `failures` of a loop: which item failed and the code of its error. */
export interface WorkflowLoopFailure {
  index: number;
  label?: string;
  error: string;
}

/**
 * Where a run stands among the runs that started it. A child run is a run of another published
 * Workflow that a step of type `workflow` started. The
 * engine keeps these on the run; a run nobody's step started is its own root at depth 0.
 */
export interface WorkflowRunLineage {
  /** The run whose step started this one. Missing on a root run. */
  parentRunId?: WorkflowRunId;
  /** That step run. It is unique among runs: one step run starts one child, so a retried step finds its child. */
  parentStepRunId?: WorkflowStepRunId;
  /** The run at the top. Its own id on a root run. */
  rootRunId: WorkflowRunId;
  /** 0 on a root run, at most `WORKFLOW_RUN_MAX_DEPTH`. */
  depth: number;
  /** Where the parent's step stood in its loop when it started this run. */
  itemIndex?: number;
  itemLabel?: string;
}

/** What tells a run apart and what describes it. The engine keeps both on the run. */
export interface WorkflowRunIdentity {
  /** Unique per Workflow among its open and `done` runs. See `workflowRunKeySchema`. */
  runKey?: string;
  labels?: WorkflowRunLabels;
}

/**
 * On the step run of a `workflow` step whose start was answered an existing run, by its key:
 * the run it links to and does not own. It waits for it while it is open; cancelling the
 * parent does not cancel it, and a dataset in its result may read `dataset_expired`.
 */
export interface WorkflowStepRunLink {
  linkedRunId?: WorkflowRunId;
}

/** The deepest a child run stands below its root: a root, its children and their children. */
export const WORKFLOW_RUN_MAX_DEPTH = 2;

/**
 * The codes of the refusals and failures that more than one package reads. `dataset_limit`:
 * a step reached a limit on rows, bytes, pages or minutes, or the instance its limit on
 * datasets. `dataset_expired`: a read of a dataset that was deleted. `depth_limit`: a start of
 * a child run below the deepest level. `rate_limited`: a call found no room in the `limits` of
 * its operation; it is retryable. `not_supported_yet`: a definition names a field this
 * engine does not run.
 */
export const WORKFLOW_ERROR_CODES = {
  datasetLimit: "dataset_limit",
  datasetExpired: "dataset_expired",
  depthLimit: "depth_limit",
  rateLimited: "rate_limited",
  notSupported: "not_supported_yet"
} as const;

/**
 * What the engine keeps of the datasets of runs, as `PlatformStores.workflowRunDatasets`: one
 * record per dataset with its run, step run, row schema, counts, parts and state. It holds
 * nothing until the slice that brings datasets gives it its methods.
 */
export interface WorkflowRunDatasetsStore {}

/** Where the parts of a run's datasets lie in the instance's `files` object store. */
export const WORKFLOW_RUN_OBJECT_PREFIX = "workflow-runs/";

/**
 * The audit events of a dataset. Each carries run, step, dataset id, row count, bytes, pages,
 * the table and the actor, and never a row, a value or a sample.
 */
export const WORKFLOW_RUN_DATASET_AUDIT_EVENTS = {
  created: "workflow_run.dataset_created",
  loaded: "workflow_run.dataset_loaded",
  downloaded: "workflow_run.dataset_downloaded",
  deleted: "workflow_run.dataset_deleted"
} as const;

/**
 * What the engine keeps of runs and step runs, as `PlatformStores.workflowRuns`. It is bound to
 * a transaction like every store of the platform. The engine's first slice gives it its methods.
 */
export interface WorkflowRunsStore {}

/**
 * The job kinds of the engine. `execute_step` runs one step run and queues what follows it.
 * `fire_schedule` starts the run of a due `schedule` trigger and queues the next due time.
 * `delete_datasets` removes the objects of the datasets of a run that were marked deleted.
 * Spec: Engine on the shared job executor; Lifetime, rights, audit and limits.
 */
export const WORKFLOW_RUN_JOB_KINDS = {
  executeStep: "workflow_run.execute_step",
  fireSchedule: "workflow_run.fire_schedule",
  deleteDatasets: "workflow_run.delete_datasets"
} as const;

export type WorkflowRunJobKind =
  (typeof WORKFLOW_RUN_JOB_KINDS)[keyof typeof WORKFLOW_RUN_JOB_KINDS];

/**
 * The prefix of every operation of one Workflow: `workflow.<id>.start`. The id holds no dot.
 * It is singular. Operations that manage Workflows and their runs have a two-part name in the
 * plural, such as `workflows.test` and `workflows.get_run`.
 */
export const WORKFLOW_OPERATION_PREFIX = "workflow.";

/**
 * The operation that answers the rows of one dataset of a run's result, as JSON Lines or CSV.
 * It needs `workflow.read_run_data`, or to be the person who started the run.
 */
export const WORKFLOW_DOWNLOAD_DATASET_OPERATION = "workflows.download_dataset";

/** The operation that starts the published revision of one Workflow. Spec: P32. */
export function workflowStartOperationName(workflow: string): string {
  return `${WORKFLOW_OPERATION_PREFIX}${workflow}.start`;
}

/**
 * The idempotency key of the changing operation a step calls: the id of its step run, the `id`
 * of its row in `workflow_step_runs`. A step inside a loop has one step run per item, told
 * apart by `iteration`, so each item's call is its own, and a retried attempt of one step run
 * answers with its first result. Spec: Engine on the shared job executor.
 */
export function workflowStepIdempotencyKey(stepRunId: WorkflowStepRunId): string {
  return `workflow_step:${stepRunId}`;
}

/**
 * The rights of the kind. `use` starts the published revision. `read_run_data` reads the rows
 * of a run's datasets: `read` shows that a dataset exists, with its row type and counts, and
 * no row of it. Spec: access-and-permissions.md; Lifetime, rights, audit and limits.
 */
export const WORKFLOW_ACTIONS = {
  read: "workflow.read",
  write: "workflow.write",
  publish: "workflow.publish",
  delete: "workflow.delete",
  use: "workflow.use",
  readRunData: "workflow.read_run_data"
} as const satisfies AssetKindActions & { readRunData: string };

/**
 * The right that letting a Workflow act as a service principal asks for: the one that
 * administering service principals asks for. The whole rule is that of administering them and
 * is asked in one place, `requireWorkflowRunAs` of the server: this right, held by a person
 * who is a superadmin. It is the strict default. Spec: Who a run acts as.
 */
export const WORKFLOW_RUN_AS_ACTION = "api_access.manage" satisfies PlatformAction;
