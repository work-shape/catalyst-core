import { z } from "zod";
import { listQuerySchema, timestampSchema } from "../shared";
import { defineRegisteredOperation, json, page } from "./define-operation";

// The runs of a Workflow: the start by hand, the reads and the cancel. A read answers states,
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
const stepTypeSchema = z.enum([
  "trigger",
  "operation",
  "loop",
  "code",
  "output",
  "agent",
  "notify"
]);

const workflowRunErrorSchema = z.object({
  /** A code of the engine, or the code of the refusal or failure of the step's operation. */
  code: z.string(),
  /** A sentence of the product. Never a value of the run and never text of an outside system. */
  message: z.string(),
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
  /** The fingerprint of the definition the run executes. */
  revision: z.string(),
  mode: z.enum(["live", "test"]),
  trigger: z.enum(["manual", "schedule"]),
  status: runStatusSchema,
  /** The service principal the run acts as. Its rights are the rights of every step. */
  principal: z.object({ id: z.string(), displayLabel: z.string() }),
  startedBy: z.object({
    kind: z.enum(["user", "service_principal"]),
    id: z.string(),
    label: z.string()
  }),
  /** The Operation Run of the call that started the run. */
  operationRunId: z.string().optional(),
  stepRunCount: z.number().int().min(0),
  /** After this moment no further step starts and the run ends as `limit_reached`. */
  deadlineAt: timestampSchema,
  error: workflowRunErrorSchema.optional(),
  outputPreview: workflowOutputPreviewSchema.optional(),
  createdAt: timestampSchema,
  startedAt: timestampSchema.optional(),
  finishedAt: timestampSchema.optional()
});

export const workflowStepRunSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stepId: z.string(),
  stepType: stepTypeSchema,
  /** The step's place in the run, such as `each_client[3].bookings`. */
  key: z.string(),
  /** The step run of the loop this one belongs to. */
  parentStepRunId: z.string().optional(),
  /** Which item of that loop, from 0, and what the loop's `itemLabel` field holds for it. */
  iteration: z.object({ index: z.number().int().min(0), label: z.string().optional() }).optional(),
  /** On the step run of a loop: how many items it has and how far they are. */
  loop: z
    .object({
      total: z.number().int().min(0),
      done: z.number().int().min(0),
      failed: z.number().int().min(0),
      running: z.number().int().min(0)
    })
    .optional(),
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

export type WorkflowRunResource = z.infer<typeof workflowRunSchema>;
export type WorkflowStepRunResource = z.infer<typeof workflowStepRunSchema>;
export type StartWorkflowRunRequest = z.infer<typeof startWorkflowRunRequestSchema>;

// Each is an operation of the registry. None names its right in `requires`: the right is the
// Workflow's own (`workflow.use`, `workflow.read`, `workflow.write`) and is decided on the
// Workflow the call or its run names.
export const workflowOperations = {
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
    summary: "List the step runs of one Workflow Run in the order they were created",
    tag: "Workflows",
    auth: "principal",
    scope: "config_assets:read",
    requires: [],
    effect: "reading",
    query: listQuerySchema,
    response: page(workflowStepRunSchema, ["createdAt", "id"], false),
    errors: ["NOT_FOUND"],
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
