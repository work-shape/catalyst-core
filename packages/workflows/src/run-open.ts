import {
  AppError,
  WORKFLOW_RUN_KEY_MAX_LENGTH,
  auditActorFromIdentity,
  createPlatformId,
  isAuthenticatedServicePrincipal,
  workflowRunKeySchema,
  type AuthenticatedIdentity,
  type AuthenticatedUser,
  type ClientInstanceId,
  type OperationRunId,
  type PlatformStores,
  type WorkflowRun,
  type WorkflowRunMode,
  type WorkflowRunView,
  type WorkflowStep
} from "@work-shape/catalyst-core";
import { workflowDeadlineJobKind } from "./run-deadline";
import { codeStepIssues, workflowStepFilesRefusal, type WorkflowStepFiles } from "./code-step";
import type { WorkflowDefinitionRevision } from "./definition-source";
import type { WorkflowRunLimits } from "./limits";
import type { PreparedStart } from "./run-start";
import type { RunOrigin } from "./scheduled-start";

// How a run comes to exist: its row, the step run of its trigger and the audit of its start,
// in one transaction. A start by hand, a test run of a draft and a due time of a schedule all
// open their run here.

/**
 * How often a start with a key writes its run again where the run that held the key ended
 * `failed`, `cancelled` or `limit_reached` between the insert and the read of it.
 */
const KEYED_START_ATTEMPTS = 3;

export interface StartWorkflowRunInput {
  workflow: string;
  input: unknown;
  /**
   * The run key (`workflowRunKeySchema`). Where a run of the Workflow that is open or `done`
   * holds it, the start starts nothing and answers that run.
   */
  key?: string;
  /** Who starts the run. Its right opened the start; the run acts as its own principal. */
  startedBy: AuthenticatedIdentity;
  /** The Operation Run of the call that starts the run. */
  operationRunId?: OperationRunId;
  correlationId: string;
}

/**
 * A test run of a draft (ADR-0031): the draft revision the caller read, and the person who
 * starts it. Only a person starts one; no trigger does.
 */
export interface TestWorkflowRunInput extends Omit<StartWorkflowRunInput, "workflow"> {
  draft: WorkflowDefinitionRevision;
  startedBy: AuthenticatedUser;
}

/** The refusal of a start whose key is empty, too long, or no text. */
export function runKeyRefusal(): AppError {
  return new AppError(
    "VALIDATION_FAILED",
    `A run key is text of 1 to ${WORKFLOW_RUN_KEY_MAX_LENGTH} characters`,
    { reason: "run_key_invalid" }
  );
}

export function createRunOpening(options: {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  limits: WorkflowRunLimits;
  now(): Date;
  stepFiles: WorkflowStepFiles;
  prepareStart(revision: WorkflowDefinitionRevision, given: unknown): Promise<PreparedStart>;
  /** Creates the step run of the trigger and the job that executes it. */
  beginTrigger(tx: PlatformStores, run: WorkflowRun, trigger: WorkflowStep): Promise<unknown>;
}) {
  const { clientInstanceId, stores, limits, now } = options;

  /**
   * Writes a run with the step run of its trigger and the audit of its start. Answers
   * nothing where the run names a due time of a schedule that has its run. Where it names a
   * run key that a run of the Workflow and mode holds, it starts nothing and answers that
   * run, held until the transaction ends: the insert meets the key's unique index, and the
   * holder is read behind it in the same transaction, never checked before.
   */
  async function openRun(
    tx: PlatformStores,
    prepared: PreparedStart,
    started: RunOrigin,
    mode: WorkflowRunMode = "live"
  ): Promise<WorkflowRun | undefined> {
    const { runKey } = started;
    for (let attempt = 1; attempt <= KEYED_START_ATTEMPTS; attempt += 1) {
      const run = await writeRun(tx, prepared, started, mode);
      if (run || runKey === undefined) return run;
      const holder = await tx.workflowRuns.lockRunByKey({
        clientInstanceId,
        workflow: prepared.published.manifest.id,
        mode,
        runKey
      });
      if (holder) return holder;
    }
    return undefined;
  }

  async function writeRun(
    tx: PlatformStores,
    prepared: PreparedStart,
    started: RunOrigin,
    mode: WorkflowRunMode
  ): Promise<WorkflowRun | undefined> {
    const { published, trigger, input, principal } = prepared;
    const { actor, ...origin } = started;
    const createdAt = now();
    const run = await tx.workflowRuns.createRun({
      id: createPlatformId<"WorkflowRunId">("wfr"),
      clientInstanceId,
      workflow: published.manifest.id,
      // The run keeps this revision to its end, whatever is published after it started.
      definitionRevisionId: published.revisionId,
      mode,
      definition: published.manifest,
      input,
      principal,
      createdAt: createdAt.toISOString(),
      ...origin,
      deadlineAt: new Date(
        Math.min(
          createdAt.getTime() + limits.maxDurationMs,
          started.deadlineAt === undefined ? Infinity : Date.parse(started.deadlineAt)
        )
      ).toISOString()
    });
    if (!run) return undefined;
    await options.beginTrigger(tx, run, trigger);
    await tx.jobs.enqueue(
      workflowDeadlineJobKind,
      { runId: run.id },
      {
        clientInstanceId,
        subject: run.id,
        dedupeKey: `${workflowDeadlineJobKind.kind}:${run.id}`,
        runAfter: new Date(run.deadlineAt),
        correlationId: run.correlationId
      }
    );
    await tx.audit.appendAuditEvent({
      clientInstanceId,
      type: "workflow_run.started",
      status: "success",
      actor,
      subject: run.id,
      correlationId: run.correlationId,
      metadata: {
        workflow: run.workflow,
        definitionRevisionId: run.definitionRevisionId,
        trigger: run.trigger,
        mode: run.mode,
        principalId: run.principal.id,
        ...(run.scheduledFor === undefined ? {} : { scheduledFor: run.scheduledFor })
      }
    });
    return run;
  }

  /** Opens a run that a person or a credential starts by hand, and answers it as it is read. */
  async function startByHand(
    revision: WorkflowDefinitionRevision,
    input: Omit<StartWorkflowRunInput, "workflow">,
    mode: WorkflowRunMode
  ): Promise<WorkflowRunView> {
    if (input.operationRunId) {
      const existing = await stores.workflowRuns.findRunByOperation({
        clientInstanceId,
        operationRunId: input.operationRunId
      });
      if (existing) return existing;
    }
    if (input.key !== undefined && !workflowRunKeySchema.safeParse(input.key).success) {
      throw runKeyRefusal();
    }
    const prepared = await options.prepareStart(revision, input.input);
    const scripts = await codeStepIssues(revision, options.stepFiles);
    if (scripts.length > 0) throw workflowStepFilesRefusal(revision.manifest.id, scripts);
    const { startedBy } = input;
    const run = await stores.transaction(
      async (tx) =>
        (await openRun(
          tx,
          prepared,
          {
            trigger: "manual",
            startedBy: {
              kind: isAuthenticatedServicePrincipal(startedBy) ? "service_principal" : "user",
              id: startedBy.id,
              label: startedBy.displayLabel
            },
            ...(input.operationRunId ? { operationRunId: input.operationRunId } : {}),
            ...(input.key === undefined ? {} : { runKey: input.key }),
            actor: auditActorFromIdentity(startedBy),
            correlationId: input.correlationId
          },
          mode
        )) ??
        (input.operationRunId
          ? await tx.workflowRuns.findRunByOperation({
              clientInstanceId,
              operationRunId: input.operationRunId
            })
          : undefined)
    );
    const view = run
      ? await stores.workflowRuns.readRun({ clientInstanceId, id: run.id })
      : undefined;
    if (!view) throw new AppError("INTERNAL", "The started Workflow Run cannot be read");
    return view;
  }

  return { openRun, startByHand };
}
