import type { Brand, ServicePrincipalId } from "./ids";
import type { JsonObject, JsonValue } from "./json";

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
  "notify"
] as const;

export type WorkflowStepType = (typeof WORKFLOW_STEP_TYPES)[number];

/**
 * What may start a run. Spec: Workflow definition, triggers. The spec also names `form`,
 * `webhook`, `platform_event` and `connector_event`; each joins with the slice that fires it.
 */
export const WORKFLOW_TRIGGER_KINDS = ["manual", "schedule"] as const;

export type WorkflowTriggerKind = (typeof WORKFLOW_TRIGGER_KINDS)[number];

export type WorkflowTrigger =
  | { kind: "manual" }
  /** A cron expression, read in the time zone of the instance. */
  | { kind: "schedule"; cron: string };

/**
 * A field of the output of an earlier step, by the id of that step and the dotted path of the
 * field. An empty path is the whole output. Inside a loop the id of the loop step names the
 * current item. Spec: Step inputs, outputs and references.
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
  /** Unique in the definition. References, wiring and step runs name the step by it. */
  id: string;
}

/** The schemas a step declares itself, as JSON Schema. An operation step takes its operation's. */
interface WorkflowDeclaredSchemas {
  inputSchema: JsonObject;
  outputSchema: JsonObject;
}

export type WorkflowStep =
  /** Starts the run. Its output is the run's input, checked against the definition's `inputs`. */
  | (WorkflowStepBase & { type: "trigger"; triggers: readonly WorkflowTrigger[] })
  /** Calls one operation by its name as one Operation Run. */
  | (WorkflowStepBase & { type: "operation"; operation: string; input: WorkflowInputMapping })
  /** Runs its steps in order for each item of a list and returns the list of their results. */
  | (WorkflowStepBase & {
      type: "loop";
      items: WorkflowReference;
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

/** One edge of the wiring: `to` runs after `from`. Both are ids of steps of one sequence. */
export interface WorkflowWire {
  from: string;
  to: string;
}

/** `workflow.yaml` as it is read. Spec: Workflow definition. */
export interface WorkflowManifest {
  /** Stable and lowercase. It is part of `workflow.<id>.start`, so it holds no dot. */
  id: string;
  name: string;
  description?: string;
  /** The id of the service principal a run of this Workflow acts as. */
  runAs: string;
  /** The schema of the run's input, as JSON Schema: the output schema of the trigger step. */
  inputs: JsonObject;
  /** The schema of the run's result, as JSON Schema: the input schema of the output step. */
  outputs: JsonObject;
  /** The names of the operations an agent step of this Workflow may call as tools. */
  tools?: readonly string[];
  steps: readonly WorkflowStep[];
  wiring: readonly WorkflowWire[];
}

export type WorkflowRunId = Brand<string, "WorkflowRunId">;
export type WorkflowStepRunId = Brand<string, "WorkflowStepRunId">;

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
 * Who a Workflow Run acts as: the service principal its definition names under `runAs`. Every
 * operation a step calls carries this principal as the `actor` of its call, and the rights of
 * the call are the principal's. The origin of the call says which run and step made it.
 */
export interface WorkflowRunPrincipal {
  kind: "service";
  id: ServicePrincipalId;
  displayLabel: string;
}

/**
 * The job kinds of the engine. `execute_step` runs one step run and queues what follows it.
 * `fire_schedule` starts the run of a due `schedule` trigger and queues the next due time.
 * Spec: Engine on the shared job executor.
 */
export const WORKFLOW_RUN_JOB_KINDS = {
  executeStep: "workflow_run.execute_step",
  fireSchedule: "workflow_run.fire_schedule"
} as const;

export type WorkflowRunJobKind =
  (typeof WORKFLOW_RUN_JOB_KINDS)[keyof typeof WORKFLOW_RUN_JOB_KINDS];

/**
 * The prefix of every operation of a Workflow. `workflow.<id>.start` has three parts and the id
 * holds no dot, so it never reads as one of the two-part names of the operations that manage
 * Workflows, such as `workflow.test`. Spec: platform-access.md, section 9.
 */
export const WORKFLOW_OPERATION_PREFIX = "workflow.";

/** The operation that starts the published revision of one Workflow. Spec: P32. */
export function workflowStartOperationName(workflow: string): string {
  return `${WORKFLOW_OPERATION_PREFIX}${workflow}.start`;
}

/**
 * The idempotency key of the changing operation a step calls: one per run and step, so a
 * retried attempt answers with the first result. Spec: Engine on the shared job executor.
 */
export function workflowStepIdempotencyKey(runId: WorkflowRunId, stepId: string): string {
  return `${runId}:${stepId}`;
}
