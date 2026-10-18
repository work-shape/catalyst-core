import {
  defineJobHandler,
  type ClientInstanceId,
  type JobSchedule,
  type ObjectStorage,
  type PlatformStores,
  type RegisteredJobHandler,
  type WorkflowCodeOutcome,
  type WorkflowDatasetLimits,
  type WorkflowStepRunLog,
  type WorkflowStepRunRef
} from "@work-shape/catalyst-core";
import type { WorkspaceCommandProcessExecutor } from "@work-shape/catalyst-tool-execution";
import type { CodeStepDatasets } from "./code-datasets";
import { createCodeSandbox, type CodeSandboxOptions } from "./code-sandbox";
import { WORKFLOW_CODE_ERRORS } from "./code-step";
import { createWorkflowDatasets } from "./datasets";
import { WORKFLOW_STEP_DATA_MAX_BYTES } from "./limits";
import {
  codeStepContinuationKey,
  stepJobConcurrency,
  workflowCodeJobKind,
  workflowCodeSweepJobKind,
  workflowCodeSweepSchedule,
  workflowStepJobKind
} from "./step-job";

// The command worker's half of a code step. The engine staged the step: the step run waits
// and holds the script and the input. This job runs the script in the sandbox, keeps how it
// ended on the step run and queues the step job that lets the engine take the step up again.

/** How often a running script's job looks whether its step run still waits for it. */
const CANCEL_CHECK_MS = 1_000;

export interface CodeStepJobsOptions {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  sandbox: WorkspaceCommandProcessExecutor;
  tempRoot: string;
  /** How many scripts this worker runs at once. */
  slots: number;
  limits: CodeSandboxOptions["limits"];
  /** The longest a script may run. What a killed worker left is older than twice that. */
  timeoutSeconds: number;
  /**
   * The `files` object store and the dataset limits of release config. Without them a step
   * whose input or output holds a dataset fails with `dataset_storage_unavailable`.
   */
  datasets?: { objects: ObjectStorage; limits: WorkflowDatasetLimits };
  /** How much one script may write to its output directory on this worker's disk. */
  diskBytes?: number;
  /** For a test: in place of a second. */
  cancelCheckMs?: number;
  /** For a test: in place of twice the time limit and a minute. */
  leftoverAgeMs?: number;
}

/** What the command worker serves for the code steps of Workflows, and what it runs by itself. */
export interface CodeStepJobs {
  handlers: RegisteredJobHandler[];
  /** The sweep of what a killed worker left: when the worker starts, and every ten minutes. */
  schedules: JobSchedule[];
}

export function createCodeStepJobs(options: CodeStepJobsOptions): CodeStepJobs {
  const { clientInstanceId, stores } = options;
  // A script that still runs is younger than its time limit, also on another worker of the
  // same engine. What is older than twice that and a minute has no worker left to end it.
  const leftoverAgeMs = options.leftoverAgeMs ?? 2 * options.timeoutSeconds * 1_000 + 60_000;
  const { run, sweep } = createCodeSandbox({
    sandbox: options.sandbox,
    tempRoot: options.tempRoot,
    limits: options.limits,
    outputMaxBytes: WORKFLOW_STEP_DATA_MAX_BYTES,
    ...(options.diskBytes === undefined ? {} : { diskBytes: options.diskBytes })
  });
  const datasets = options.datasets
    ? createWorkflowDatasets({
        clientInstanceId,
        stores,
        objects: options.datasets.objects,
        limits: options.datasets.limits
      })
    : undefined;

  /**
   * What the script of one step run reads and writes datasets with: as its run, so it reads
   * only the datasets its run may read, and writes them as datasets of its step run.
   */
  async function datasetsOf(ref: WorkflowStepRunRef): Promise<CodeStepDatasets | undefined> {
    if (!datasets || !options.datasets) return undefined;
    const stepRun = await stores.workflowRuns.getStepRun(ref);
    const run = stepRun
      ? await stores.workflowRuns.readRun({ clientInstanceId, id: stepRun.runId })
      : undefined;
    if (!stepRun || !run) return undefined;
    return {
      rowBytes: options.datasets.limits.rowBytes,
      async rows(id, reference) {
        return (await datasets.reader({ id, runId: run.id, ...(reference ? { reference } : {}) }))
          .rows;
      },
      store: (input) => datasets.write({ run, stepRun, ...input })
    };
  }

  /** Keeps how the script ended and hands the step back to the engine, in one transaction. */
  async function hand(
    tx: PlatformStores,
    ref: WorkflowStepRunRef,
    correlationId: string,
    ended: { outcome: WorkflowCodeOutcome; log: WorkflowStepRunLog }
  ): Promise<void> {
    const stepRun = await tx.workflowRuns.getStepRun(ref);
    // A step run a cancel ended keeps nothing, and nothing takes it up.
    if (!stepRun || !(await tx.workflowRuns.recordCodeOutcome({ ...ref, ...ended }))) return;
    const run = await tx.workflowRuns.readRun({ clientInstanceId, id: stepRun.runId });
    await tx.jobs.enqueue(
      workflowStepJobKind,
      { stepRunId: stepRun.id },
      {
        clientInstanceId,
        subject: stepRun.id,
        dedupeKey: codeStepContinuationKey(stepRun.id),
        // The step's job counts against its Workflow's slots like every other step job.
        ...(run ? stepJobConcurrency(run) : { concurrencyKey: stepRun.runId }),
        correlationId
      }
    );
  }

  const sweepHandler = defineJobHandler({
    kind: workflowCodeSweepJobKind,
    slots: 1,
    async run() {
      await sweep(leftoverAgeMs);
    }
  });

  const handlers = [
    defineJobHandler({
      kind: workflowCodeJobKind,
      slots: options.slots,
      async run(job, control) {
        const ref: WorkflowStepRunRef = { clientInstanceId, id: job.payload.stepRunId };
        const staged = await stores.workflowRuns.readStagedCode(ref);
        // The step run ended, or an earlier attempt of this job recorded how the script ended.
        if (!staged) return;
        // The container ends with the attempt, and with a cancel of the run: a step run that
        // no longer waits for its script has no use for it.
        const stop = new AbortController();
        const stopped = () => stop.abort(control.signal.reason);
        control.signal.addEventListener("abort", stopped, { once: true });
        let over = false;
        const watch = async (): Promise<void> => {
          while (!over && !stop.signal.aborted) {
            await new Promise((resolve) =>
              setTimeout(resolve, options.cancelCheckMs ?? CANCEL_CHECK_MS)
            );
            if (over) return;
            const still = await stores.workflowRuns.readStagedCode(ref).catch(() => staged);
            if (!still) stop.abort(new Error("The step run was cancelled"));
          }
        };
        // It ends by itself at its next look after the script has ended.
        watch().catch(() => undefined);
        const io = await datasetsOf(ref);
        let result;
        try {
          result = await run({
            id: ref.id,
            staged,
            signal: stop.signal,
            ...(io ? { datasets: io } : {})
          });
        } finally {
          over = true;
          control.signal.removeEventListener("abort", stopped);
        }
        // A worker that stops ends no step: the script changed nothing, and the next attempt
        // runs it again.
        if (control.signal.aborted) {
          throw control.signal.reason instanceof Error
            ? control.signal.reason
            : new Error("The attempt was stopped");
        }
        if (result.kind === "stopped") return;
        if (result.kind === "notStarted") {
          // Not an outcome of the script: the job is attempted again.
          throw new Error(`The sandbox could not start the container: ${result.reason}`);
        }
        const ended = result;
        await control.transaction((tx) => hand(tx, ref, job.correlationId, ended));
      },
      // No attempt could start the container. The step does not wait for one for ever.
      async onExhausted(job, tx) {
        await hand(tx, { clientInstanceId, id: job.payload.stepRunId }, job.correlationId, {
          outcome: {
            kind: "failed",
            error: {
              code: WORKFLOW_CODE_ERRORS.runnerUnavailable,
              message: `The sandbox could not run the script in ${job.maxAttempts} attempts`
            }
          },
          log: { stdout: "", stderr: "", truncated: false }
        });
      }
    }),
    sweepHandler
  ];
  return { handlers, schedules: [workflowCodeSweepSchedule] };
}
