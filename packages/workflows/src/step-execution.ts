import { valuePosition } from "./json";
import { checkpointFrame } from "./continuation-checkpoint";
import type { WorkflowLimitContext } from "./run-limits";
import { checkDatasetValues, loopFailureRowSchema } from "./dataset-values";
import { datasetReference } from "./datasets";
import { workflowValueSchema, datasetReferences } from "./dataset-schema";
import type { WorkflowDatasets } from "./datasets";
import { jsonObjectSchema } from "./json";
import { pagedOperation, resolvedPaging } from "./paged-operation";
import { operationDatasetCapture } from "./operation-dataset";
import { codeOutputDatasetSchema } from "./code-datasets";
import { childStepOutcome } from "./child-runs";
import { compileJsonSchema } from "@work-shape/catalyst-connections";
import {
  WORKFLOW_DATASET_KEY,
  WORKFLOW_START_KEY_INPUT,
  isAppError,
  operationDenialError,
  workflowDatasetReferenceSchema,
  workflowStepIdempotencyKey,
  workflowStartOperationName,
  type AuthenticatedIdentity,
  type ClientInstanceId,
  type JsonObject,
  type JsonValue,
  type NoticeSendInput,
  type OperationDraftContext,
  type OperationRun,
  type OperationRunId,
  type PlatformStores,
  type WorkflowCodeOutcome,
  type WorkflowManifest,
  type WorkflowRun,
  type WorkflowRunError,
  type WorkflowStagedCode,
  type WorkflowStep,
  type WorkflowStepRun,
  type WorkflowStepRunCall,
  type WorkflowStepRunEnd,
  type WorkflowTriggerOutput
} from "@work-shape/catalyst-core";
import {
  WORKFLOW_CODE_ERRORS,
  WORKFLOW_CODE_STEP_EFFECT,
  codeFileIssue,
  codeLanguageOf,
  readCodeFile,
  type WorkflowStepFiles
} from "./code-step";
import type { WorkflowStepIndex } from "./definition";
import type { WorkflowDefinitionSource } from "./definition-source";
import {
  holdsBrokenDatasetReference,
  holdsDatasetReference,
  jsonBytes,
  namesDatasetType
} from "./json";
import {
  WORKFLOW_STEP_JOB_BACKOFF_BASE_MS,
  WORKFLOW_STEP_JOB_BACKOFF_MAX_MS,
  WORKFLOW_RUN_LIMITS
} from "./limits";
import {
  OperationStepFailure,
  callStepOperation,
  notSupportedFailure,
  type WorkflowOperationCalls
} from "./operation-step";
import { operationWaitMs, operationWaitOutcome, stillRunningError } from "./operation-wait";
import { resolveInput, resolveReference, resolveRunKey } from "./references";
import { workflowRunActor } from "./run-identity";
import { WorkflowStepFailure } from "./step-failure";
import { testRunCall } from "./test-run";

// The work of one step, without anything of it written: the engine writes how it went and
// what follows it in one transaction of its own.

/** How the attempt of a step went, before anything of it is written. */
export type StepEnd =
  | { kind: "notice"; notice: NoticeSendInput }
  | { kind: "done"; output: JsonValue; operationRunId?: OperationRunId; call?: WorkflowStepRunCall }
  | {
      kind: "failed";
      error: WorkflowRunError;
      operationRunId?: OperationRunId;
      call?: WorkflowStepRunCall;
      /** The run's principal itself was refused: no loop continues past this failure. */
      systemic: boolean;
    }
  /** A loop read its list. Its items are run by step runs of their own. */
  | {
      kind: "loop";
      items: JsonValue[] | import("@work-shape/catalyst-core").WorkflowDatasetReference;
      total?: number;
    }
  | { kind: "child"; operationRunId?: OperationRunId; call?: WorkflowStepRunCall }
  /**
   * An operation step started work that ends later (`completion: async`). The step waits for
   * the Operation Run, holding no slot, at most `timeoutMs` from its start.
   */
  | {
      kind: "operation_wait";
      operationRunId: OperationRunId;
      call?: WorkflowStepRunCall;
      timeoutMs: number;
    }
  /** A code step has its script and its input. The command worker runs it in the sandbox. */
  | { kind: "code"; staged: WorkflowStagedCode };

/** What the instance has to run the scripts of code steps with. */
export interface WorkflowCodeRunner {
  /** After this long a script is stopped and its step fails. */
  timeoutSeconds: number;
}

export interface StepExecutorOptions {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  operationCalls: WorkflowOperationCalls;
  /** Where a step of a published run reads whether its Workflow is still published. */
  definitions: Pick<WorkflowDefinitionSource, "read">;
  limits: WorkflowLimitContext;
  datasets?: WorkflowDatasets;
  now(): Date;
  /** Where the script of a code step is read. */
  stepFiles: WorkflowStepFiles;
  /** Missing where the instance runs no sandbox: a code step then fails without waiting. */
  codeRunner?: WorkflowCodeRunner;
}

/** What one attempt of a step is given: its run, the run's definition and the attempt's end. */
export interface StepAttempt {
  run: WorkflowRun;
  stepRun: WorkflowStepRun;
  definition: WorkflowManifest;
  index: WorkflowStepIndex;
  signal: AbortSignal;
}

export function createStepExecutor(options: StepExecutorOptions) {
  const { clientInstanceId, stores, operationCalls, definitions, now } = options;
  const limits = options.limits.defaults ?? WORKFLOW_RUN_LIMITS;

  /** Fails a step whose value does not fit a schema its definition declares. */
  function fitsSchema(schema: JsonObject, value: JsonValue, code: string, what: string): void {
    const compiled = compileJsonSchema(schema);
    const [issue] = compiled.ok ? compiled.validate(value) : [];
    if (compiled.ok && !issue) return;
    throw new WorkflowStepFailure(
      code,
      issue
        ? `${what}${valuePosition(value, issue.path)}: ${issue.message}`
        : `${what}: the schema cannot be checked`
    );
  }

  /**
   * What a code step does before its script runs: its input from the steps before it, checked
   * against the schema it declares, and its script from the files of the run's revision. The
   * script is not run here: this process does not reach the sandbox.
   */
  async function stageCode(
    attempt: StepAttempt,
    step: Extract<WorkflowStep, { type: "code" }>
  ): Promise<StepEnd> {
    const { run, stepRun, index, definition } = attempt;
    const input = await resolveInput(
      { store: stores.workflowRuns, datasets: options.datasets, index, run, stepRun },
      step.input
    );
    withinStepData(input, "The input of the step");
    fitsSchema(
      workflowValueSchema(step.inputSchema, definition.types),
      input,
      WORKFLOW_CODE_ERRORS.inputInvalid,
      "The input does not fit the step's inputSchema"
    );
    // A dataset reaches the script as a file the command worker writes. Here the run's right
    // to each one is asked, and whether its rows fit the step's: the worker asks again.
    const writesDatasets = namesDatasetType(step.outputSchema);
    if (holdsDatasetReference(input) || writesDatasets) {
      if (!options.datasets)
        throw new WorkflowStepFailure(
          "dataset_storage_unavailable",
          "This instance has no files object store"
        );
      for (const ref of datasetReferences(input))
        await options.datasets.reader({ id: ref.$dataset, runId: run.id, reference: ref });
      await checkDatasetValues(input, step.inputSchema, definition, run.id, options.datasets);
    }
    if (!options.codeRunner) {
      throw new WorkflowStepFailure(
        WORKFLOW_CODE_ERRORS.runnerUnavailable,
        "This instance runs no sandbox, so it runs no code step: Execution Workspaces are off or have no sandbox"
      );
    }
    const file = codeFileIssue(step.file);
    if (file) throw new WorkflowStepFailure(WORKFLOW_CODE_ERRORS.fileInvalid, file);
    const read = await readCodeFile(
      options.stepFiles,
      { workflow: run.workflow, revisionId: run.definitionRevisionId },
      step.file
    );
    if ("code" in read) throw new WorkflowStepFailure(read.code, read.message);
    return {
      kind: "code",
      staged: {
        language: codeLanguageOf(step.file)?.language ?? "",
        file: step.file,
        source: read.source,
        input,
        timeoutSeconds: options.codeRunner.timeoutSeconds,
        ...(writesDatasets
          ? {
              datasets: {
                outputSchema: codeOutputDatasetSchema(step.outputSchema, definition.types),
                ...(definition.limits?.datasetBytes === undefined
                  ? {}
                  : { maxBytes: definition.limits.datasetBytes })
              }
            }
          : {})
      }
    };
  }

  /**
   * How a code step ends once its script has: with the result where it fits the schema the
   * step declares and the size every step output may have, and failed otherwise.
   */
  async function finishCode(attempt: StepAttempt, outcome: WorkflowCodeOutcome): Promise<StepEnd> {
    const step = attempt.index.get(attempt.stepRun.stepId)?.step;
    const call: WorkflowStepRunCall = { effect: WORKFLOW_CODE_STEP_EFFECT };
    if (outcome.kind === "failed") {
      return { kind: "failed", error: outcome.error, systemic: false, call };
    }
    try {
      withinStepData(outcome.value, "The result of the script");
      if (step?.type === "code") {
        fitsSchema(
          workflowValueSchema(step.outputSchema, attempt.definition.types),
          outcome.value,
          WORKFLOW_CODE_ERRORS.outputInvalid,
          "The result does not fit the step's outputSchema"
        );
      }
      // The worker put in each dataset it stored for this step run, and no other.
      for (const ref of datasetReferences(outcome.value)) {
        const row = await stores.workflowRunDatasets.get({ clientInstanceId, id: ref.$dataset });
        if (row?.stepRunId !== attempt.stepRun.id || row.runId !== attempt.run.id)
          throw new WorkflowStepFailure(
            WORKFLOW_CODE_ERRORS.outputInvalid,
            "The result names a dataset this step did not write"
          );
      }
    } catch (error) {
      if (isAppError(error) && error.code === "FORBIDDEN")
        return {
          kind: "failed",
          error: { code: "FORBIDDEN", message: "This run cannot read the dataset" },
          systemic: false
        };
      if (!(error instanceof WorkflowStepFailure)) throw error;
      return { kind: "failed", error: error.toRunError(), systemic: false, call };
    }
    return { kind: "done", output: outcome.value, call };
  }

  function withinStepData(value: JsonValue, what: string): void {
    if (jsonBytes(value) > limits.stepDataMaxBytes) {
      throw new WorkflowStepFailure(
        "step_data_too_large",
        `${what} is larger than ${limits.stepDataMaxBytes} bytes`
      );
    }
    if (holdsBrokenDatasetReference(value)) {
      throw new WorkflowStepFailure(
        "dataset_reference_invalid",
        `${what} holds '${WORKFLOW_DATASET_KEY}' on a value that is no reference to a dataset`
      );
    }
  }

  /**
   * Who an operation step calls as. A run of the published revision acts as its principal; a
   * test run of a draft acts as the person testing, bounded by the principal. A run goes on
   * after its Workflow is deleted, and its calls then say so: the publish confirms none.
   */
  async function callerOf(
    run: WorkflowRun,
    stepRun: WorkflowStepRun
  ): Promise<{
    actor: AuthenticatedIdentity;
    draft?: OperationDraftContext;
    workflowDeleted?: true;
  }> {
    if (run.mode === "test") return testRunCall(stores, run, stepRun);
    const actor = await workflowRunActor(stores.apiAccess, run);
    if (!actor) {
      throw new WorkflowStepFailure(
        "principal_inactive",
        "The service principal the run acts as no longer exists or is disabled",
        { systemic: true }
      );
    }
    return { actor, ...((await workflowDeleted(run)) ? { workflowDeleted: true as const } : {}) };
  }

  /** Whether the Workflow of a run of what is published is published no more. */
  async function workflowDeleted(run: WorkflowRun): Promise<boolean> {
    try {
      return (await definitions.read(run.workflow)) === undefined;
    } catch (error) {
      // A published revision this engine refuses to run is published all the same.
      if (isAppError(error)) return false;
      throw error;
    }
  }

  /** Does the work of one step and writes nothing of it but the id of its Operation Run. */
  async function execute(attempt: StepAttempt): Promise<StepEnd> {
    const { run, stepRun, index, signal } = attempt;
    const step = index.get(stepRun.stepId)?.step;
    const scope = { store: stores.workflowRuns, index, run, stepRun, datasets: options.datasets };
    try {
      switch (step?.type) {
        case "trigger": {
          // A definition another release stored may name a trigger no engine fires yet.
          const input = await stores.workflowRuns.readRunInput({ clientInstanceId, id: run.id });
          const output: WorkflowTriggerOutput = {
            input: input ?? {},
            startedAt: run.startedAt ?? run.createdAt,
            trigger: run.trigger,
            // The due time of the schedule that started the run, and of no other run.
            scheduledFor: run.scheduledFor ?? null
          };
          return { kind: "done", output: { ...output } };
        }
        case "workflow": {
          const ended = await childStepOutcome(stores, run, stepRun);
          if (stepRun.status === "waiting" && ended) return ended;
          const input = await resolveInput(scope, step.input);
          withinStepData(input, "The child input");
          const child = await definitions.read(step.workflow);
          if (child && options.datasets)
            await checkDatasetValues(
              input,
              child.manifest.inputs,
              child.manifest,
              run.id,
              options.datasets
            );
          if (options.datasets)
            for (const ref of datasetReferences(input))
              await options.datasets.reader({ id: ref.$dataset, runId: run.id, reference: ref });
          // The key goes beside the child's inputs, as the start operation takes it.
          if (step.key !== undefined) {
            input[WORKFLOW_START_KEY_INPUT] = await resolveRunKey(scope, step.key);
          }
          const caller = await callerOf(run, stepRun);
          const { operationRunId, call } = await callStepOperation({
            calls: operationCalls,
            run,
            stepRun,
            operation: workflowStartOperationName(step.workflow),
            input,
            ...caller,
            signal,
            wait: {
              waitMs: limits.operationOutcomeWaitMs,
              pollMs: WORKFLOW_STEP_JOB_BACKOFF_BASE_MS,
              maxPollMs: WORKFLOW_STEP_JOB_BACKOFF_MAX_MS,
              now
            },
            noteOperationRun: (operationRunId) =>
              stores.workflowRuns.noteStepRunOperation({
                clientInstanceId,
                id: stepRun.id,
                operationRunId
              })
          });
          return {
            kind: "child",
            ...(operationRunId ? { operationRunId } : {}),
            ...(call ? { call } : {})
          };
        }
        case "operation": {
          const input = await resolveInput(scope, step.input);
          withinStepData(input, "The input of the step");
          if (options.datasets)
            for (const ref of datasetReferences(input))
              await options.datasets.reader({ id: ref.$dataset, runId: run.id, reference: ref });
          const caller = await callerOf(run, stepRun);
          const captureOutput =
            !step.paginate && step.dataset && options.datasets
              ? await operationDatasetCapture({
                  datasets: options.datasets,
                  registry: operationCalls.registry,
                  operation: step.operation,
                  at: step.dataset.at,
                  run,
                  stepRun,
                  manifest: attempt.definition,
                  signal
                })
              : undefined;
          if (step.dataset && !options.datasets)
            throw new WorkflowStepFailure(
              "dataset_storage_unavailable",
              "This instance has no files object store"
            );
          const descriptor = step.paginate
            ? await operationCalls.registry.resolve(step.operation)
            : undefined;
          if (
            step.paginate &&
            (!descriptor?.paging ||
              descriptor.effect !== "reading" ||
              descriptor.streams ||
              !step.dataset)
          )
            throw new WorkflowStepFailure(
              "paging_invalid",
              "paginate needs a reading operation with paging and dataset.at"
            );
          const paging =
            step.paginate && descriptor && options.datasets
              ? await pagedOperation({
                  datasets: options.datasets,
                  operationRuns: operationCalls.deps.runs,
                  pagedStepMinutes: options.limits.ceilings.pagedStepMinutes,
                  paging: resolvedPaging(descriptor.paging, step.paginate),
                  progressTimeoutMs: descriptor.timeoutMs ?? WORKFLOW_STEP_JOB_BACKOFF_MAX_MS,
                  step,
                  outputSchema: jsonObjectSchema.parse(descriptor.outputJsonSchema ?? {}),
                  run,
                  stepRun,
                  manifest: attempt.definition,
                  args: input,
                  signal,
                  now,
                  noteOperationRun: (operationRunId) =>
                    stores.workflowRuns.noteStepRunOperation({
                      clientInstanceId,
                      id: stepRun.id,
                      operationRunId
                    })
                })
              : undefined;
          const result = await callStepOperation({
            ...(paging ? { paging } : {}),
            ...(captureOutput ? { captureOutput } : {}),
            calls: operationCalls,
            run,
            stepRun,
            operation: step.operation,
            input,
            ...caller,
            signal,
            wait: {
              waitMs: limits.operationOutcomeWaitMs,
              // The backoff of the step's job, and at least four looks within the wait.
              pollMs: Math.min(
                WORKFLOW_STEP_JOB_BACKOFF_BASE_MS,
                Math.ceil(limits.operationOutcomeWaitMs / 4)
              ),
              maxPollMs: WORKFLOW_STEP_JOB_BACKOFF_MAX_MS,
              now
            },
            noteOperationRun: (operationRunId) =>
              stores.workflowRuns.noteStepRunOperation({
                clientInstanceId,
                id: stepRun.id,
                operationRunId
              })
          });
          if ("waitFor" in result) {
            return {
              kind: "operation_wait",
              operationRunId: result.waitFor,
              ...(result.call ? { call: result.call } : {}),
              timeoutMs: operationWaitMs(step.timeout)
            };
          }
          const { output, ...trace } = result;
          try {
            withinStepData(output, "The output of the step");
          } catch (error) {
            if (!(error instanceof WorkflowStepFailure)) throw error;
            throw new OperationStepFailure(error.code, error.message, trace);
          }
          return { kind: "done", ...result };
        }
        case "notify": {
          const mapped = await resolveInput(scope, { title: step.title, text: step.text });
          withinStepData(mapped, "The notice");
          if (typeof mapped.title !== "string" || typeof mapped.text !== "string") {
            throw new WorkflowStepFailure(
              "notice_invalid",
              "A notice title and text must be strings"
            );
          }
          const { actor } = await callerOf(run, stepRun);
          if (run.mode === "test") {
            return {
              kind: "done",
              call: { effect: "changing", target: "dry_run" },
              output: {
                wouldHaveDone: {
                  operation: "notify",
                  input: {
                    to: {
                      ...(step.to.users ? { users: [...step.to.users] } : {}),
                      ...(step.to.workspaces ? { workspaces: [...step.to.workspaces] } : {})
                    },
                    title: mapped.title,
                    text: mapped.text,
                    channels: [...step.channels]
                  }
                }
              }
            };
          }
          return {
            kind: "notice",
            notice: {
              from: actor,
              to: step.to,
              title: mapped.title,
              text: mapped.text,
              channels: step.channels,
              link:
                step.link?.kind === "app"
                  ? step.link
                  : { kind: "workflow_run", workflowId: run.workflow, runId: run.id }
            }
          };
        }
        case "loop": {
          if (step.collect !== undefined) throw notSupportedFailure("'collect' on a loop");
          const checkpoint = await checkpointFrame(stores, run, stepRun);
          const items = checkpoint?.items ?? (await resolveReference(scope, step.items));
          // Allocate the checkpoint before the settling transaction. If writing its parts
          // is interrupted later, cleanup still owns the prefix even if that end rolls back.
          if (step.onItemFailure === "continue" && options.datasets) {
            async function* empty(): AsyncIterable<unknown> {}
            await options.datasets.write({
              run,
              stepRun,
              field: "failures",
              rowSchema: loopFailureRowSchema,
              rows: empty(),
              signal
            });
          }
          if (workflowDatasetReferenceSchema.safeParse(items).success) {
            const dataset = workflowDatasetReferenceSchema.parse(items);
            if (!options.datasets)
              throw new WorkflowStepFailure(
                "dataset_storage_unavailable",
                "This instance has no files object store"
              );
            await options.datasets.reader({
              id: dataset.$dataset,
              runId: run.id,
              reference: dataset
            });
            const record = await options.datasets.metadata(dataset.$dataset);
            const canonical = dataset.offset === undefined ? datasetReference(record) : dataset;
            const total = Math.ceil(canonical.rowCount / (step.batch ?? 1));
            // The run's own bound, as for a list: its Workflow's `limits.loopItems`.
            if (!step.continueAsNew && total > attempt.run.limits.loopItems)
              throw new WorkflowStepFailure(
                "loop_too_long",
                `A loop runs over at most ${attempt.run.limits.loopItems} items`
              );
            return { kind: "loop", items: canonical, total };
          }
          if (step.batch !== undefined)
            throw new WorkflowStepFailure(
              "batch_requires_dataset",
              "batch on a loop needs a dataset"
            );
          if (!Array.isArray(items)) {
            throw new WorkflowStepFailure("loop_items_not_a_list", "A loop runs over a list");
          }
          // The run's own bound: its Workflow's `limits.loopItems`, or the default.
          const loopItems = attempt.run.limits.loopItems;
          if (!step.continueAsNew && items.length > loopItems) {
            throw new WorkflowStepFailure(
              "loop_too_long",
              `A loop runs over at most ${loopItems} items`
            );
          }
          withinStepData(items, "The list of the loop");
          return { kind: "loop", items };
        }
        case "code":
          return await stageCode(attempt, step);
        case "output": {
          const output = await resolveInput(scope, step.input);
          withinStepData(output, "The result of the run");
          const schema = compileJsonSchema(
            workflowValueSchema(attempt.definition.outputs, attempt.definition.types)
          );
          const [issue] = schema.ok ? schema.validate(output) : [];
          if (!schema.ok || issue) {
            throw new WorkflowStepFailure(
              "output_invalid",
              issue
                ? `The result does not fit the Workflow's outputs${valuePosition(output, issue.path)}: ${issue.message}`
                : "The Workflow's outputs are a schema that cannot be checked"
            );
          }
          if (options.datasets) {
            for (const ref of datasetReferences(output))
              await options.datasets.reader({ id: ref.$dataset, runId: run.id, reference: ref });
            await checkDatasetValues(
              output,
              attempt.definition.outputs,
              attempt.definition,
              run.id,
              options.datasets
            );
          }
          return { kind: "done", output };
        }
        default:
          // A reserved block, a step type of a later release, or a step the run's definition
          // does not hold: the step fails with the contract's refusal, and so does its run.
          throw notSupportedFailure(
            `the step '${stepRun.stepId}' of the type '${stepRun.stepType}'`
          );
      }
    } catch (error) {
      if (!(error instanceof WorkflowStepFailure)) throw error;
      return {
        kind: "failed",
        error: error.toRunError(),
        systemic: error.systemic,
        ...(error instanceof OperationStepFailure ? error.trace : {})
      };
    }
  }

  /**
   * What is known of the call of an operation step whose attempt nobody ended, read from the
   * Operation Run under the step run's key. A cancel or a limit ended the run while the
   * step's worker was gone; the step run then says what its call did and not that nothing
   * happened. Answers nothing where no call was recorded.
   */
  async function knownCallEnd(
    tx: PlatformStores,
    run: WorkflowRun,
    stepRun: WorkflowStepRun,
    finishedAt: string
  ): Promise<WorkflowStepRunEnd | undefined> {
    if (stepRun.stepType !== "operation") return undefined;
    const first = await tx.operationRuns.findByIdempotencyKey({
      clientInstanceId,
      // A step of a test run called as the person who started it.
      actor:
        run.mode === "test"
          ? { kind: run.startedBy.kind, id: run.startedBy.id }
          : { kind: "service_principal", id: run.principal.id },
      idempotencyKey: workflowStepIdempotencyKey(stepRun.id)
    });
    if (!first) return undefined;
    const kept = {
      finishedAt,
      operationRunId: first.id,
      call: { effect: first.effect, target: first.target }
    };
    switch (first.status) {
      case "done":
        return { ...kept, status: "done", ...(first.output ? { output: first.output.value } : {}) };
      case "denied": {
        const refusal = first.denial ? operationDenialError(first.denial) : undefined;
        return {
          ...kept,
          status: "failed",
          error: {
            code: refusal?.code ?? "FORBIDDEN",
            message: refusal?.message ?? `The call of '${first.operation}' was refused`
          }
        };
      }
      case "failed":
        return {
          ...kept,
          status: "failed",
          error: {
            code: first.error?.code ?? "operation_failed",
            message: `The operation '${first.operation}' failed`
          }
        };
      default:
        // Still without an outcome: the step run names the call, and its end is not known.
        return { ...kept, status: "cancelled" };
    }
  }

  /**
   * How an operation step that waited ends: from the Operation Run it waited for once that run
   * has ended, or at its `timeout` while the operation goes on.
   */
  async function finishOperation(waited: OperationRun, timedOut: boolean): Promise<StepEnd> {
    const definition = await operationCalls.registry.resolve(waited.operation);
    const kept = { operationRunId: waited.id };
    const outcome = timedOut ? undefined : await operationWaitOutcome(waited, definition);
    if (!outcome) {
      return {
        kind: "failed",
        error: stillRunningError(waited.operation, definition),
        systemic: false,
        ...kept
      };
    }
    if (outcome.kind === "failed") {
      return { kind: "failed", error: outcome.error, systemic: false, ...kept };
    }
    try {
      withinStepData(outcome.output, "The output of the step");
    } catch (error) {
      if (!(error instanceof WorkflowStepFailure)) throw error;
      return { kind: "failed", error: error.toRunError(), systemic: false, ...kept };
    }
    return { kind: "done", output: outcome.output, ...kept };
  }

  return { execute, finishCode, finishOperation, knownCallEnd };
}
