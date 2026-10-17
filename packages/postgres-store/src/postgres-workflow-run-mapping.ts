import { and, eq, getTableColumns, notInArray, sql } from "drizzle-orm";
import {
  WORKFLOW_ENDED_STATUSES,
  WORKFLOW_OUTPUT_PREVIEW_MAX_CHARS,
  type WorkflowRunsStore,
  type WorkflowRun,
  type WorkflowStepRun,
  type WorkflowOutputPreview
} from "@work-shape/catalyst-core";
import { workflowRuns, workflowStepRuns } from "./schema/workflowRuns";

type Input<Method extends keyof WorkflowRunsStore> = Parameters<WorkflowRunsStore[Method]>[0];
type RunRow = typeof workflowRuns.$inferSelect;
type StepRunRow = typeof workflowStepRuns.$inferSelect;

// A run and a step run without the values they carry: the engine reads those one at a time.
// The definition a run keeps is among them: it is as large as a file may be, and a step
// reads it once.
const {
  input: _runInput,
  output: _runOutput,
  definition: _runDefinition,
  ...runColumns
} = getTableColumns(workflowRuns);
const {
  input: _stepInput,
  output: _stepOutput,
  // The script and the input of a code step, its raw outcome and its log are read where
  // they are needed and not with every step run.
  staged: _stepStaged,
  codeOutcome: _stepCodeOutcome,
  log: _stepLog,
  ...stepRunColumns
} = getTableColumns(workflowStepRuns);

// One character more than a preview shows, so a cut value is told from one that just fits.
const previewOf = (column: typeof workflowRuns.output | typeof workflowStepRuns.output) =>
  sql<
    string | null
  >`left((${column}->'value')::text, ${sql.raw(String(WORKFLOW_OUTPUT_PREVIEW_MAX_CHARS + 1))})`;

// The output of a trigger step is the run's input, and a read never answers an input.
const stepPreview = sql<
  string | null
>`case when ${workflowStepRuns.stepType} = 'trigger' then null else ${previewOf(workflowStepRuns.output)} end`;

function mapPreview(text: string | null): { outputPreview?: WorkflowOutputPreview } {
  if (text === null) return {};
  const truncated = text.length > WORKFLOW_OUTPUT_PREVIEW_MAX_CHARS;
  return {
    outputPreview: {
      text: truncated ? text.slice(0, WORKFLOW_OUTPUT_PREVIEW_MAX_CHARS) : text,
      truncated
    }
  };
}

function mapRun(row: Omit<RunRow, "input" | "output" | "definition">): WorkflowRun {
  return {
    id: row.id,
    clientInstanceId: row.clientInstanceId,
    workflow: row.workflow,
    definitionRevisionId: row.definitionRevisionId,
    mode: row.mode,
    trigger: row.trigger,
    status: row.status,
    principal: { id: row.principalId, name: row.principalName, displayLabel: row.principalLabel },
    startedBy: row.startedBy,
    rootRunId: row.rootRunId ?? row.id,
    depth: row.depth,
    ...(row.parentRunId === null ? {} : { parentRunId: row.parentRunId }),
    ...(row.parentStepRunId === null ? {} : { parentStepRunId: row.parentStepRunId }),
    ...(row.itemIndex === null ? {} : { itemIndex: row.itemIndex }),
    ...(row.itemLabel === null ? {} : { itemLabel: row.itemLabel }),
    ...(row.operationRunId === null ? {} : { operationRunId: row.operationRunId }),
    stepRunCount: row.stepRunCount,
    deadlineAt: row.deadlineAt.toISOString(),
    limits: row.limits,
    ...(row.waitingSince === null ? {} : { waitingSince: row.waitingSince.toISOString() }),
    waitedMs: row.waitedMs,
    ...(row.error === null ? {} : { error: row.error }),
    correlationId: row.correlationId,
    createdAt: row.createdAt.toISOString(),
    ...(row.startedAt === null ? {} : { startedAt: row.startedAt.toISOString() }),
    ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt.toISOString() }),
    ...(row.cancelledBy === null ? {} : { cancelledBy: row.cancelledBy }),
    ...(row.cancelledAt === null ? {} : { cancelledAt: row.cancelledAt.toISOString() }),
    ...(row.scheduledFor === null ? {} : { scheduledFor: row.scheduledFor.toISOString() }),
    ...(row.runKey === null ? {} : { runKey: row.runKey }),
    ...(row.dataPrunedAt === null ? {} : { dataPrunedAt: row.dataPrunedAt.toISOString() })
  };
}

function mapStepRun(
  row: Omit<StepRunRow, "input" | "output" | "staged" | "codeOutcome" | "log">
): WorkflowStepRun {
  return {
    id: row.id,
    clientInstanceId: row.clientInstanceId,
    runId: row.runId,
    stepId: row.stepId,
    stepType: row.stepType,
    key: row.key,
    ...(row.containerStepRunId === null ? {} : { containerStepRunId: row.containerStepRunId }),
    ...(row.branch === null ? {} : { branch: row.branch }),
    ...(row.iteration === null
      ? {}
      : {
          iteration: {
            index: row.iteration,
            ...(row.iterationLabel === null ? {} : { label: row.iterationLabel })
          }
        }),
    status: row.status,
    attempt: row.attempt,
    ...(row.operationRunId === null ? {} : { operationRunId: row.operationRunId }),
    ...(row.linkedRunId === null ? {} : { linkedRunId: row.linkedRunId }),
    ...(row.effect === null ? {} : { effect: row.effect }),
    ...(row.source === null ? {} : { source: row.source }),
    ...(row.target === null ? {} : { target: row.target }),
    ...(row.publishedWouldAsk === null ? {} : { publishedWouldAsk: row.publishedWouldAsk }),
    ...(row.error === null ? {} : { error: row.error }),
    createdAt: row.createdAt.toISOString(),
    ...(row.startedAt === null ? {} : { startedAt: row.startedAt.toISOString() }),
    ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt.toISOString() })
  };
}

const runIs = (ref: { clientInstanceId: RunRow["clientInstanceId"]; id: string }) =>
  and(eq(workflowRuns.clientInstanceId, ref.clientInstanceId), sql`${workflowRuns.id} = ${ref.id}`);

const stepRunIs = (ref: Input<"getStepRun">) =>
  and(
    eq(workflowStepRuns.clientInstanceId, ref.clientInstanceId),
    sql`${workflowStepRuns.id} = ${ref.id}`
  );

const notEnded = (column: typeof workflowRuns.status | typeof workflowStepRuns.status) =>
  notInArray(column, [...WORKFLOW_ENDED_STATUSES]);

export {
  stepPreview,
  runColumns,
  stepRunColumns,
  previewOf,
  mapPreview,
  mapRun,
  mapStepRun,
  runIs,
  stepRunIs,
  notEnded
};
