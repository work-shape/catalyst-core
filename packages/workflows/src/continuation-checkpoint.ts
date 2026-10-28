import type {
  NewWorkflowRun,
  PlatformStores,
  WorkflowRun,
  WorkflowStepRun,
  WorkflowCheckpointFrame
} from "@work-shape/catalyst-core";
import { indexWorkflowSteps } from "./definition";

type Checkpoint = NonNullable<NewWorkflowRun["checkpoint"]>;
type Frame = WorkflowCheckpointFrame;

/** Only the first resumed item follows a saved frontier. Later items execute every step. */
export async function checkpointFrame(
  tx: PlatformStores,
  run: WorkflowRun,
  loop: WorkflowStepRun
): Promise<Frame | undefined> {
  const checkpoint = await tx.workflowRuns.readCheckpoint({
    clientInstanceId: run.clientInstanceId,
    id: run.id
  });
  if (checkpoint?.blocks) return checkpoint.blocks[loop.key];
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
  return checkpoint?.stepId === loop.stepId
    ? checkpoint
    : checkpoint?.ancestors?.find((frame) => frame.stepId === loop.stepId);
}

/** One frame per open block; finished loop items never accumulate across histories. */
export async function continuationCheckpoint(
  tx: PlatformStores,
  run: WorkflowRun,
  loopRun: WorkflowStepRun,
  completed: number
): Promise<Checkpoint> {
  const { clientInstanceId } = run;
  const definition = await tx.workflowRuns.readRunDefinition({ clientInstanceId, id: run.id });
  const index = indexWorkflowSteps(definition ?? { steps: [] });
  async function frame(loopRun: WorkflowStepRun, completed: number): Promise<Frame> {
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
    const failures: NonNullable<Frame["failed"]> = {};
    const progress =
      loop?.type === "loop"
        ? await tx.workflowRuns.readLoopProgress({ clientInstanceId, id: loopRun.id })
        : undefined;
    const children =
      progress && completed >= progress.started
        ? []
        : await tx.workflowRuns.readBlockSteps({
            clientInstanceId,
            id: loopRun.id,
            ...(loop?.type === "loop" ? { iteration: completed } : {})
          });
    for (const child of children) {
      if (loop?.type === "loop" && child.iteration?.index !== completed) continue;
      if (child.status === "failed" && child.error) failures[child.stepId] = { ...child.error };
      if (child.status !== "done") continue;
      const output = await tx.workflowRuns.findStepOutput({
        clientInstanceId,
        runId: run.id,
        stepId: child.stepId,
        containerStepRunId: loopRun.id,
        ...(child.iteration ? { iteration: child.iteration.index } : {})
      });
      if (output) outputs[child.stepId] = output.value;
    }
    const counts = await tx.workflowRuns.readLoopCounts({ clientInstanceId, id: loopRun.id });
    const done = (previous?.counts?.done ?? 0) + (counts?.done ?? 0);
    const failed = (previous?.counts?.failed ?? 0) + (counts?.failed ?? 0);
    const taken =
      loop?.type === "condition"
        ? await tx.workflowRuns.readBlockTaken({ clientInstanceId, id: loopRun.id })
        : undefined;
    return {
      counts: { total: done + failed, done, failed },
      stepId: loopRun.stepId,
      ...(loop?.type === "loop" || loop?.type === "parallel" || loop?.type === "condition"
        ? { stepType: loop.type }
        : {}),
      ...(loopRun.error ? { failure: { ...loopRun.error } } : {}),
      offset: (previous?.offset ?? 0) + rows,
      items,
      ...(Object.keys(outputs).length ? { completed: outputs } : {}),
      ...(Object.keys(failures).length ? { failed: failures } : {}),
      ...(taken ? { taken } : {})
    };
  }
  const saved = await frame(loopRun, completed);
  const open = await tx.workflowRuns.listOpenStepRuns({ clientInstanceId, id: run.id });
  if (open.some((step) => step.stepType === "parallel" || step.stepType === "condition")) {
    const blocks: NonNullable<Checkpoint["blocks"]> = {};
    const positions = new Map<string, number>();
    const keys = new Map<string, string>();
    for (const block of [...open].sort(
      (a, b) => a.key.length - b.key.length || a.key.localeCompare(b.key)
    )) {
      if (block.status !== "waiting" || !["loop", "condition", "parallel"].includes(block.stepType))
        continue;
      let position = 0;
      if (block.stepType === "loop") {
        const progress = await tx.workflowRuns.readLoopProgress({ clientInstanceId, id: block.id });
        position = block.id === loopRun.id ? completed : progress.started - progress.running;
      }
      const parent = block.containerStepRunId
        ? await tx.workflowRuns.getStepRun({ clientInstanceId, id: block.containerStepRunId })
        : undefined;
      const prefix = parent ? (keys.get(parent.id) ?? parent.key) : "";
      const key = !parent
        ? block.key
        : block.iteration
          ? `${prefix}[${block.iteration.index - (positions.get(parent.id) ?? 0)}].${block.stepId}`
          : `${prefix}[${block.branch}].${block.stepId}`;
      keys.set(block.id, key);
      positions.set(block.id, position);
      blocks[key] = await frame(block, position);
    }
    return { ...saved, blocks };
  }
  const ancestors: Frame[] = [];
  let child = loopRun;
  while (child.containerStepRunId !== undefined) {
    const parent = await tx.workflowRuns.getStepRun({
      clientInstanceId,
      id: child.containerStepRunId
    });
    if (!parent) break;
    ancestors.push(await frame(parent, child.iteration?.index ?? 0));
    child = parent;
  }
  return { ...saved, ...(ancestors.length ? { ancestors } : {}) };
}

/** Detect a budget too small to move past its saved frontier instead of making endless runs. */
export function sameContinuationPosition(a: Checkpoint | undefined, b: Checkpoint): boolean {
  const position = (frame: Frame) => [
    frame.stepId,
    frame.offset,
    Object.keys(frame.completed ?? {}).sort(),
    Object.keys(frame.failed ?? {}).sort(),
    frame.taken
  ];
  return (
    a !== undefined &&
    JSON.stringify([
      position(a),
      a.ancestors?.map(position),
      a.blocks && Object.entries(a.blocks).map(([key, frame]) => [key, position(frame)])
    ]) ===
      JSON.stringify([
        position(b),
        b.ancestors?.map(position),
        b.blocks && Object.entries(b.blocks).map(([key, frame]) => [key, position(frame)])
      ])
  );
}
