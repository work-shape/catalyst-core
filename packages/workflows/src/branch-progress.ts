import { checkpointFrame } from "./continuation-checkpoint";
import type {
  ClientInstanceId,
  JsonValue,
  PlatformStores,
  WorkflowRun,
  WorkflowRunError,
  WorkflowStep,
  WorkflowStepRun,
  WorkflowStepRunPlacement,
  WorkflowConditionOutput
} from "@work-shape/catalyst-core";
import type { WorkflowStepIndex } from "./definition";
import { jsonBytes } from "./json";

/** Branch admission and joins run under the run lock, in the transaction ending a child. */
export function createBranchProgress(options: {
  clientInstanceId: ClientInstanceId;
  now(): Date;
  beginStep(
    tx: PlatformStores,
    run: WorkflowRun,
    step: WorkflowStep,
    place: WorkflowStepRunPlacement & { key: string },
    index: WorkflowStepIndex
  ): Promise<boolean>;
  advance(
    tx: PlatformStores,
    run: WorkflowRun,
    index: WorkflowStepIndex,
    stepRun: WorkflowStepRun
  ): Promise<void>;
  failBlock(
    tx: PlatformStores,
    run: WorkflowRun,
    index: WorkflowStepIndex,
    block: WorkflowStepRun,
    error: WorkflowRunError,
    systemic?: boolean
  ): Promise<void>;
  resumePending(tx: PlatformStores, run: WorkflowRun, stepRun?: WorkflowStepRun): Promise<boolean>;
  stepDataMaxBytes: number;
}) {
  const { clientInstanceId, now, beginStep, advance, failBlock } = options;

  async function complete(
    tx: PlatformStores,
    run: WorkflowRun,
    index: WorkflowStepIndex,
    block: WorkflowStepRun,
    output: JsonValue
  ) {
    if (jsonBytes(output) > options.stepDataMaxBytes) {
      await failBlock(tx, run, index, block, {
        code: "step_data_too_large",
        message: `The block output is larger than ${options.stepDataMaxBytes} bytes`
      });
      return;
    }
    await tx.workflowRuns.endStepRun({
      clientInstanceId,
      id: block.id,
      status: "done",
      finishedAt: now().toISOString(),
      output
    });
    await advance(tx, run, index, block);
  }

  async function startCondition(
    tx: PlatformStores,
    run: WorkflowRun,
    index: WorkflowStepIndex,
    block: WorkflowStepRun,
    taken: WorkflowConditionOutput["taken"]
  ) {
    const step = index.get(block.stepId)?.step;
    if (step?.type !== "condition") return;
    const first = step[taken]?.[0];
    if (!first) {
      await complete(tx, run, index, block, { taken, result: null });
      return;
    }
    await tx.workflowRuns.markBlockWaiting({ clientInstanceId, id: block.id, taken });
    await beginStep(
      tx,
      run,
      first,
      { key: `${block.key}[${taken}].${first.id}`, containerStepRunId: block.id, branch: taken },
      index
    );
  }

  async function fillBranches(
    tx: PlatformStores,
    run: WorkflowRun,
    index: WorkflowStepIndex,
    block: WorkflowStepRun
  ) {
    if (await options.resumePending(tx, run, block)) return;
    const current = await tx.workflowRuns.getStepRun({ clientInstanceId, id: block.id });
    if (current?.status !== "waiting") return;
    const step = index.get(block.stepId)?.step;
    if (step?.type !== "parallel" && step?.type !== "condition") return;
    const frame = await checkpointFrame(tx, run, block);
    const children = await tx.workflowRuns.readBlockSteps({ clientInstanceId, id: block.id });
    const outputOf = async (last: WorkflowStep | undefined): Promise<JsonValue> => {
      if (!last) return null;
      const output = await tx.workflowRuns.findStepOutput({
        clientInstanceId,
        runId: run.id,
        stepId: last.id,
        containerStepRunId: block.id
      });
      return output?.value ?? null;
    };
    const open = (child: WorkflowStepRun) =>
      child.status === "queued" || child.status === "running" || child.status === "waiting";
    if (step.type === "condition") {
      if (children.some(open)) return;
      const taken = children[0]?.branch;
      if (taken !== "then" && taken !== "else") return;
      await complete(tx, run, index, block, { taken, result: await outputOf(step[taken]?.at(-1)) });
      return;
    }
    // A branch occupies a place until its last step or its failure. An empty branch is
    // already done and needs no synthetic step run or job.
    let going = new Set(children.filter(open).map((child) => child.branch)).size;
    const started = new Set(children.map((child) => child.branch));
    const width = step.concurrency ?? step.branches.length;
    for (const branch of step.branches) {
      const first = branch.steps[0];
      if (!first || started.has(branch.id)) continue;
      if (going >= width) return;
      if (
        !(await beginStep(
          tx,
          run,
          first,
          {
            key: `${block.key}[${branch.id}].${first.id}`,
            containerStepRunId: block.id,
            branch: branch.id
          },
          index
        ))
      )
        return;
      // Restoring a completed prefix may itself join this block or admit its siblings.
      if (
        Object.hasOwn(frame?.completed ?? {}, first.id) ||
        Object.hasOwn(frame?.failed ?? {}, first.id)
      )
        return fillBranches(tx, run, index, block);
      going++;
    }
    if (going > 0) return;
    const failed = children.find((child) => child.status === "failed");
    if (failed) {
      // A failed nested block points at the leaf that explains the failure. Keep the
      // original reason and required right on the run, as a failure outside branches does.
      const cause = failed.error?.stepRunId
        ? await tx.workflowRuns.getStepRun({ clientInstanceId, id: failed.error.stepRunId })
        : failed;
      await failBlock(
        tx,
        run,
        index,
        block,
        {
          ...(current.error ??
            cause?.error ??
            failed.error ?? {
              code: "parallel_branch_failed",
              message: "A branch of the parallel step failed"
            }),
          stepRunId: current.error?.stepRunId ?? failed.error?.stepRunId ?? failed.id
        },
        current.error !== undefined
      );
      return;
    }
    const output = Object.fromEntries(
      await Promise.all(
        step.branches.map(async (branch) => [branch.id, await outputOf(branch.steps.at(-1))])
      )
    );
    await complete(tx, run, index, block, output);
  }

  return { startCondition, fillBranches };
}
