import { z } from "zod";
import { listQuerySchema, timestampSchema } from "../shared";
import { defineRegisteredOperation, json, page } from "./define-operation";

// The Workflows of an instance and their runs: the list, the start by hand, the reads and the
// cancel. A read answers states,
// times and errors, and of what a run or a step returned only a cut preview. It never answers
// an input.

/** How many characters of a result a read shows at most. The store cuts to the same number. */
export const WORKFLOW_RUN_OUTPUT_PREVIEW_MAX_CHARS = 2_000;

// The values of the Workflow contract in `@vivd-catalyst/core`, which this package does not
// import. A value the engine writes and this list lacks fails the answer of the read.
const runStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "done",
  "failed",
  "cancelled",
  "limit_reached"
]);
const stepRunStatusSchema = z.enum(["queued", "running", "waiting", "done", "failed", "cancelled"]);
// The reserved blocks are among them: a step run of one says that the engine refused it.
const stepTypeSchema = z.enum([
  "trigger",
  "operation",
  "loop",
  "code",
  "output",
  "agent",
  "notify",
  "workflow",
  "condition",
  "parallel"
]);
const countsSchema = z.object({
  total: z.number().int().min(0),
  done: z.number().int().min(0),
  failed: z.number().int().min(0),
  running: z.number().int().min(0)
});

const workflowRunErrorSchema = z.object({
  /** A code of the engine, or the code of the refusal or failure of the step's operation. */
  code: z.string(),
  /** A sentence of the product. Never a value of the run and never text of an outside system. */
  message: z.string(),
  /** Where the run's principal was refused for a right it does not hold: that right. */
  action: z.string().optional(),
  /** On a run: the step run it ended at. */
  stepRunId: z.string().optional()
});

const workflowOutputPreviewSchema = z.object({
  /** The start of the value as JSON. */
  text: z.string().max(WORKFLOW_RUN_OUTPUT_PREVIEW_MAX_CHARS),
  truncated: z.boolean()
});

export const workflowRunSchema = z.object({
  id: z.string(),
  workflow: z.string(),
  /** The revision of the definition the run started on and keeps to its end. */
  definitionRevisionId: z.string(),
  mode: z.enum(["live", "test"]),
  trigger: z.enum(["manual", "schedule", "parent"]),
  status: runStatusSchema,
  /** The service principal the run acts as. Its rights are the rights of every step. */
  principal: z.object({ id: z.string(), name: z.string(), displayLabel: z.string() }),
  startedBy: z.object({
    kind: z.enum(["user", "service_principal"]),
    id: z.string(),
    label: z.string()
  }),
  /** The due time of the schedule that started the run. Missing on every other run. */
  scheduledFor: timestampSchema.optional(),
  /** The Operation Run of the call that started the run. */
  operationRunId: z.string().optional(),
  stepRunCount: z.number().int().min(0),
  /** After this moment no further step starts and the run ends as `limit_reached`. */
  deadlineAt: timestampSchema,
  error: workflowRunErrorSchema.optional(),
  outputPreview: workflowOutputPreviewSchema.optional(),
  createdAt: timestampSchema,
  startedAt: timestampSchema.optional(),
  finishedAt: timestampSchema.optional(),
  /** The person who cancelled the run. Missing where a service principal did, and on a run nobody cancelled. */
  cancelledBy: z.string().optional(),
  cancelledAt: timestampSchema.optional()
});

export const workflowStepRunSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stepId: z.string(),
  stepType: stepTypeSchema,
  /** The step's path in the run, such as `each_client[3].bookings`. */
  key: z.string(),
  /** The step run of the block that holds the step: today a loop. */
  containerStepRunId: z.string().optional(),
  /** The branch of that block the step stands in. No block with branches runs yet. */
  branch: z.string().optional(),
  /** Which item of that loop, from 0, and what the loop's `itemLabel` field holds for it. */
  iteration: z.object({ index: z.number().int().min(0), label: z.string().optional() }).optional(),
  /** On the step run of a loop: how many items it has and how far they are. */
  loop: countsSchema.optional(),
  /** On the step run of a loop: how the step runs of each step directly inside it stand, by step id. */
  bodyCounts: z.record(z.string(), countsSchema).optional(),
  /**
   * On the step run of a loop: how many of its items run at once. `asked` is the loop's
   * `concurrency`, an upper bound; `ranWith` is what one process runs of it, which the step
   * slots of a process bound.
   */
  concurrency: z
    .object({ asked: z.number().int().min(1), ranWith: z.number().int().min(1) })
    .optional(),
  /** On the step run of an operation step: what its operation does and what it belongs to. */
  effect: z.enum(["reading", "changing"]).optional(),
  source: z.string().optional(),
  /**
   * On the step run of a code step that ran: what its script wrote to its output and error
   * streams beside its result, each cut to 16 KiB.
   */
  log: z.object({ stdout: z.string(), stderr: z.string(), truncated: z.boolean() }).optional(),
  status: stepRunStatusSchema,
  attempt: z.number().int().min(0),
  /** The Operation Run of the call an operation step made. */
  operationRunId: z.string().optional(),
  error: workflowRunErrorSchema.optional(),
  outputPreview: workflowOutputPreviewSchema.optional(),
  createdAt: timestampSchema,
  startedAt: timestampSchema.optional(),
  finishedAt: timestampSchema.optional()
});

export const startWorkflowRunRequestSchema = z.object({
  /** The input of the run, checked against the `inputs` of the Workflow's definition. */
  input: z.record(z.string(), z.unknown()).optional()
});

/**
 * The filters of the step runs of a run: those of one block, one status, one item of a loop.
 * `iteration` counts the items of one loop, so it is given with the `containerStepRunId` of
 * that loop's step run and refused without it. `topLevel=true` answers the step runs that
 * stand in no block, a loop's own step run among them and none of its items; it is refused
 * together with `containerStepRunId`.
 */
export const listWorkflowStepRunsQuerySchema = listQuerySchema.extend({
  topLevel: z.enum(["true", "false"]).optional(),
  containerStepRunId: z.string().min(1).optional(),
  status: stepRunStatusSchema.optional(),
  iteration: z.coerce.number().int().min(0).optional()
});

/**
 * One thing a start by hand of a Workflow is refused for, under the code the refusal of the
 * start carries as its `reason`: a code of the definition (`not_supported_yet`,
 * `block_depth`, `reference_out_of_scope`, `duplicate_step_id`, `definition_invalid`) or of
 * the start (`no_manual_trigger`, `inputs_unreadable`, `operation_secret`,
 * `principal_inactive`). A later engine may name further codes.
 */
export const workflowStartIssueSchema = z.object({
  code: z.string(),
  /** A sentence of the product. Never a value of a run. */
  message: z.string(),
  /** Where in the definition it is, such as `steps.check.type`. */
  path: z.string().optional()
});

export const workflowSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  /** The published revision: what a run started now has as its `definitionRevisionId`. */
  definitionRevisionId: z.string(),
  /** Whether a start by hand is accepted now, as far as that is known before its input. */
  runnable: z.boolean(),
  /** Why not. Empty exactly where `runnable` is true. */
  reasons: z.array(workflowStartIssueSchema),
  /**
   * What the caller may do with this Workflow, of `workflow.read` (its runs) and `workflow.use`
   * (a start). Never empty: a Workflow the caller holds neither on is not listed.
   */
  actions: z.array(z.string()),
  /** The latest run of the Workflow. Missing on one that never ran. */
  lastRun: z
    .object({
      id: z.string(),
      status: runStatusSchema,
      startedAt: timestampSchema.optional(),
      endedAt: timestampSchema.optional()
    })
    .optional()
});

export type WorkflowSummaryResource = z.infer<typeof workflowSummarySchema>;
export type WorkflowRunResource = z.infer<typeof workflowRunSchema>;
export type WorkflowStepRunResource = z.infer<typeof workflowStepRunSchema>;
export type StartWorkflowRunRequest = z.infer<typeof startWorkflowRunRequestSchema>;

// Each is an operation of the registry. None names its right in `requires`: the right is the
// Workflow's own (`workflow.use`, `workflow.read`, `workflow.write`) and is decided on the
// Workflow the call or its run names.
export const workflowOperations = {
  "workflows.list": defineRegisteredOperation({
    id: "workflows.list",
    method: "GET",
    path: "/api/v1/workflows",
    summary:
      "List the published Workflows the caller may read or use, each with its latest run and whether it can be started",
    tag: "Workflows",
    auth: "principal",
    scope: "config_assets:read",
    requires: [],
    effect: "reading",
    response: json(z.object({ items: z.array(workflowSummarySchema) })),
    errors: [],
    rateClass: "read"
  }),
  "workflows.start": defineRegisteredOperation({
    id: "workflows.start",
    method: "POST",
    path: "/api/v1/workflows/:workflow/runs",
    summary: "Start a run of one published Workflow by hand; it acts as the Workflow's principal",
    tag: "Workflows",
    auth: "principal",
    scope: "config_assets:write",
    requires: [],
    effect: "changing",
    body: startWorkflowRunRequestSchema,
    response: json(workflowRunSchema),
    errors: ["NOT_FOUND", "CONFLICT"],
    rateClass: "write"
  }),
  "workflows.list_runs": defineRegisteredOperation({
    id: "workflows.list_runs",
    method: "GET",
    path: "/api/v1/workflows/:workflow/runs",
    summary: "List the runs of one Workflow with their status, newest first",
    tag: "Workflows",
    auth: "principal",
    scope: "config_assets:read",
    requires: [],
    effect: "reading",
    query: listQuerySchema,
    response: page(workflowRunSchema, ["createdAt", "id"], true),
    errors: [],
    rateClass: "read"
  }),
  "workflows.get_run": defineRegisteredOperation({
    id: "workflows.get_run",
    method: "GET",
    path: "/api/v1/workflow-runs/:runId",
    summary: "Read one Workflow Run: its status, its times, its error and a preview of its result",
    tag: "Workflows",
    auth: "principal",
    scope: "config_assets:read",
    requires: [],
    effect: "reading",
    response: json(workflowRunSchema),
    errors: ["NOT_FOUND"],
    rateClass: "read"
  }),
  "workflows.list_step_runs": defineRegisteredOperation({
    id: "workflows.list_step_runs",
    method: "GET",
    path: "/api/v1/workflow-runs/:runId/steps",
    summary:
      "List the step runs of one Workflow Run in the order they were created: all, or those of one block, status or loop item",
    tag: "Workflows",
    auth: "principal",
    scope: "config_assets:read",
    requires: [],
    effect: "reading",
    query: listWorkflowStepRunsQuerySchema,
    response: page(workflowStepRunSchema, ["createdAt", "id"], false),
    errors: ["NOT_FOUND", "VALIDATION_FAILED"],
    rateClass: "read"
  }),
  "workflows.cancel_run": defineRegisteredOperation({
    id: "workflows.cancel_run",
    method: "POST",
    path: "/api/v1/workflow-runs/:runId/cancel",
    summary: "Cancel one Workflow Run; no further step starts and a running call finishes",
    tag: "Workflows",
    auth: "principal",
    scope: "config_assets:write",
    requires: [],
    effect: "changing",
    response: json(workflowRunSchema),
    errors: ["NOT_FOUND"],
    rateClass: "write"
  })
} as const;
