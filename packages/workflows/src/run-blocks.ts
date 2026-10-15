import {
  subjectDedupeKey,
  type ClientInstanceId,
  type PlatformStores,
  type WorkflowRun,
  type WorkflowStepRun
} from "@work-shape/catalyst-core";
import { workflowCodeJobKind, workflowStepJobKind } from "./step-job";

/** What the engine does to the step runs of a run, or of one block of it, that ends. */
export function createBlockEnds(options: { clientInstanceId: ClientInstanceId; now(): Date }) {
  const { clientInstanceId, now } = options;

  /**
   * Cancels the step runs that wait for their turn, with their jobs: all of a run, or those
   * inside one block, which a path that starts with the block's names. A step run that is
   * running is left to its attempt, which records how its call went.
   */
  async function cancelWaiting(
    tx: PlatformStores,
    run: WorkflowRun,
    block?: WorkflowStepRun
  ): Promise<void> {
    const finishedAt = now().toISOString();
    for (const open of await tx.workflowRuns.listOpenStepRuns({ clientInstanceId, id: run.id })) {
      if (open.status === "running") continue;
      if (block && !open.key.startsWith(`${block.key}[`)) continue;
      await tx.workflowRuns.endStepRun({
        clientInstanceId,
        id: open.id,
        status: "cancelled",
        finishedAt
      });
      await tx.jobs.withdraw(workflowStepJobKind, {
        clientInstanceId,
        dedupeKey: subjectDedupeKey(workflowStepJobKind.kind, open.id)
      });
      if (open.stepType !== "code") continue;
      // A code step that waits has a job with the command worker. One that is queued goes;
      // one that runs finds its step run ended within a second and stops its container.
      await tx.jobs.withdraw(workflowCodeJobKind, {
        clientInstanceId,
        dedupeKey: subjectDedupeKey(workflowCodeJobKind.kind, open.id)
      });
    }
  }

  /**
   * Whether a block around a step run has ended: a loop that stopped at a failed item, or one
   * that was cancelled with what is around it. What ends inside such a block is recorded and
   * carries nothing on: no next step of its item, no next item, nothing after the block.
   */
  async function insideEndedBlock(tx: PlatformStores, stepRun: WorkflowStepRun): Promise<boolean> {
    let around = stepRun.containerStepRunId;
    while (around !== undefined) {
      const block = await tx.workflowRuns.getStepRun({ clientInstanceId, id: around });
      if (!block) return false;
      if (block.status !== "waiting" && block.status !== "running") return true;
      around = block.containerStepRunId;
    }
    return false;
  }

  return { cancelWaiting, insideEndedBlock };
}
