import type {
  NewWorkflowRun,
  PlatformStores,
  WorkflowRun,
  WorkflowStepRun
} from "@work-shape/catalyst-core";
import { indexWorkflowSteps } from "./definition";

type Checkpoint = NonNullable<NewWorkflowRun["checkpoint"]>;
type Frame = Omit<Checkpoint, "ancestors">;

/** Only the first resumed item follows a saved frontier. Later items execute every step. */
export async function checkpointFrame(
  tx: PlatformStores,
  run: WorkflowRun,
  loop: WorkflowStepRun
): Promise<Frame | undefined> {
  let parent: WorkflowStepRun | undefined = loop;
  while (parent) {
    if (parent.iteration && parent.iteration.index !== 0) return undefined;
    parent =
      parent.containerStepRunId === undefined
        ? undefined
        : await tx.workflowRuns.getStepRun({
            clientInstanceId: run.clientInstanceId,
            id: parent.containerStepRunId
          });
  }
  const checkpoint = await tx.workflowRuns.readCheckpoint({
    clientInstanceId: run.clientInstanceId,
    id: run.id
  });
  return checkpoint?.stepId === loop.stepId
    ? checkpoint
    : checkpoint?.ancestors?.find((frame) => frame.stepId === loop.stepId);
}

/** One frame per nesting level, never one per completed row or previous history. */
export async function continuationCheckpoint(
  tx: PlatformStores,
  run: WorkflowRun,
  loopRun: WorkflowStepRun,
  completed: number,
  before?: string
): Promise<Checkpoint> {
  const { clientInstanceId } = run;
  const definition = await tx.workflowRuns.readRunDefinition({ clientInstanceId, id: run.id });
  const index = indexWorkflowSteps(definition ?? { steps: [] });
  async function frame(
    loopRun: WorkflowStepRun,
    completed: number,
    before?: string
  ): Promise<Frame> {
    const loop = index.get(loopRun.stepId)?.step;
    const previous = await checkpointFrame(tx, run, loopRun);
    const dataset = await tx.workflowRuns.readLoopDataset({ clientInstanceId, id: loopRun.id });
    const rows = completed * (loop?.type === "loop" ? (loop.batch ?? 1) : 1);
    let items: Frame["items"];
    if (dataset)
      items = {
        ...dataset,
        offset: (dataset.offset ?? 0) + rows,
        rowCount: Math.max(0, dataset.rowCount - rows)
      };
    else {
      items = [];
      const total =
        (await tx.workflowRuns.countLoopItems({ clientInstanceId, id: loopRun.id })) ?? 0;
      for (let position = completed; position < total; position++) {
        const row = await tx.workflowRuns.readLoopItem({
          clientInstanceId,
          id: loopRun.id,
          index: position
        });
        if (row) items.push(row.value);
      }
    }
    const outputs: NonNullable<Frame["completed"]> = {};
    if (before && loop?.type === "loop") {
      for (const step of loop.steps) {
        if (step.id === before) break;
        const output = await tx.workflowRuns.findStepOutput({
          clientInstanceId,
          runId: run.id,
          stepId: step.id,
          containerStepRunId: loopRun.id,
          iteration: completed
        });
        if (output) outputs[step.id] = output.value;
      }
    }
    return {
      stepId: loopRun.stepId,
      offset: (previous?.offset ?? 0) + rows,
      items,
      ...(Object.keys(outputs).length ? { completed: outputs } : {})
    };
  }
  const saved = await frame(loopRun, completed, before);
  const ancestors: Frame[] = [];
  let child = loopRun;
  while (child.containerStepRunId !== undefined) {
    const parent = await tx.workflowRuns.getStepRun({
      clientInstanceId,
      id: child.containerStepRunId
    });
    if (!parent) break;
    ancestors.push(await frame(parent, child.iteration?.index ?? 0, child.stepId));
    child = parent;
  }
  return { ...saved, ...(ancestors.length ? { ancestors } : {}) };
}

/** Detect a budget too small to move past its saved frontier instead of making endless runs. */
export function sameContinuationPosition(a: Checkpoint | undefined, b: Checkpoint): boolean {
  const position = (frame: Frame) => [
    frame.stepId,
    frame.offset,
    Object.keys(frame.completed ?? {})
  ];
  return (
    a !== undefined &&
    JSON.stringify([position(a), a.ancestors?.map(position)]) ===
      JSON.stringify([position(b), b.ancestors?.map(position)])
  );
}
