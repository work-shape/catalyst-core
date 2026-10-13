import {
  defineJobHandler,
  type ClientInstanceId,
  type PlatformStores,
  type RegisteredJobHandler,
  type WorkflowCodeOutcome,
  type WorkflowStepRunLog,
  type WorkflowStepRunRef
} from "@vivd-catalyst/core";
import type { WorkspaceCommandProcessExecutor } from "@vivd-catalyst/tool-execution";
import { createCodeSandbox, type CodeSandboxOptions } from "./code-sandbox";
import { WORKFLOW_CODE_ERRORS } from "./code-step";
import { WORKFLOW_STEP_DATA_MAX_BYTES } from "./limits";
import { codeStepContinuationKey, workflowCodeJobKind, workflowStepJobKind } from "./step-job";

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
  /** For a test: in place of a second. */
  cancelCheckMs?: number;
}

/** What the command worker serves for the code steps of Workflows. */
export function createCodeStepJobs(options: CodeStepJobsOptions): RegisteredJobHandler[] {
  const { clientInstanceId, stores } = options;
  const run = createCodeSandbox({
    sandbox: options.sandbox,
    tempRoot: options.tempRoot,
    limits: options.limits,
    outputMaxBytes: WORKFLOW_STEP_DATA_MAX_BYTES
  });

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
    await tx.jobs.enqueue(
      workflowStepJobKind,
      { stepRunId: stepRun.id },
      {
        clientInstanceId,
        subject: stepRun.id,
        dedupeKey: codeStepContinuationKey(stepRun.id),
        concurrencyKey: stepRun.runId,
        correlationId
      }
    );
  }

  return [
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
        const watching = watch();
        let result;
        try {
          result = await run({ id: ref.id, staged, signal: stop.signal });
        } finally {
          over = true;
          control.signal.removeEventListener("abort", stopped);
        }
        await watching;
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
    })
  ];
}
