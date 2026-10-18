import { continuationCheckpoint, sameContinuationPosition } from "./continuation-checkpoint";
import {
  AppError,
  createPlatformId,
  isAppError,
  type ClientInstanceId,
  type JsonObject,
  type PlatformStores,
  type WorkflowRun,
  type WorkflowRunError,
  type WorkflowStep,
  type WorkflowStepRun
} from "@work-shape/catalyst-core";
import { z } from "zod";
import type { WorkflowDefinitionSource } from "./definition-source";
import type { PreparedStart } from "./run-start";
import type { createRunOpening } from "./run-open";
import { principalActor } from "./run-identity";

type Loop = Extract<WorkflowStep, { type: "loop" }>;
const inputIssues = z.object({
  issues: z.array(
    z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() })
  )
});

/** A continuation is committed with its predecessor's end. A worker crash creates neither or both. */
export function createContinuation(options: {
  clientInstanceId: ClientInstanceId;
  definitions: WorkflowDefinitionSource;
  now(): Date;
  prepare: (
    revision: import("./definition-source").WorkflowDefinitionRevision,
    input: unknown
  ) => Promise<PreparedStart>;
  open: ReturnType<typeof createRunOpening>["openRun"];
  retireData(tx: PlatformStores, run: WorkflowRun): Promise<void>;
  finish(
    tx: PlatformStores,
    run: WorkflowRun,
    end: { status: "continued" | "failed"; error?: WorkflowRunError }
  ): Promise<void>;
}) {
  const { clientInstanceId, now } = options;

  async function continueRun(
    tx: PlatformStores,
    run: WorkflowRun,
    loopRun: WorkflowStepRun,
    loop: Loop,
    completed: number,
    before?: string
  ) {
    if (!loop.continueAsNew) return false;
    const previous = await tx.workflowRuns.readCheckpoint({ clientInstanceId, id: run.id });
    const checkpoint = await continuationCheckpoint(tx, run, loopRun, completed, before);
    if (sameContinuationPosition(previous, checkpoint)) return false;
    const { offset } = checkpoint;
    const input: JsonObject = {
      ...(await tx.workflowRuns.readRunInput({ clientInstanceId, id: run.id })),
      [loop.continueAsNew.position]: offset
    };
    const published = await options.definitions.read(run.workflow);
    const priorDefinition = await tx.workflowRuns.readRunDefinition({
      clientInstanceId,
      id: run.id
    });
    let prepared: PreparedStart | undefined;
    let error: WorkflowRunError | undefined;
    try {
      if (!published) throw new AppError("NOT_FOUND", "The Workflow is no longer published");
      prepared = await options.prepare(
        {
          ...published,
          manifest: { ...published.manifest, onFailure: priorDefinition?.onFailure }
        },
        input
      );
    } catch (caught) {
      if (!isAppError(caught)) throw caught;
      const issues = inputIssues.safeParse(caught.details);
      const field = issues.success ? issues.data.issues[0]?.path.join("/") : undefined;
      error = {
        code: "continuation_invalid",
        message: field
          ? `The successor input does not fit at '/${field}'`
          : "The successor could not start on the published revision"
      };
    }
    if (!run.continuation) await tx.workflowRuns.markContinuation({ clientInstanceId, id: run.id });
    // A continued history releases its key but does not wake a parent or report a failure.
    await options.finish(tx, run, { status: "continued" });
    const continuation = {
      rootRunId: run.continuation?.rootRunId ?? run.id,
      previousRunId: run.id,
      number: (run.continuation?.number ?? 1) + 1
    };
    const origin = {
      trigger: run.trigger,
      startedBy: run.startedBy,
      correlationId: run.correlationId,
      ...(run.runKey === undefined ? {} : { runKey: run.runKey }),
      ...(run.labels ? { labels: run.labels } : {}),
      continuation,
      actor: principalActor(run),
      ...(run.parentRunId
        ? {
            parentRunId: run.parentRunId,
            parentStepRunId: run.parentStepRunId,
            rootRunId: run.rootRunId,
            depth: run.depth,
            itemIndex: run.itemIndex,
            itemLabel: run.itemLabel,
            parentLimits: run.limits
          }
        : {})
    };
    let successor: WorkflowRun | undefined;
    if (prepared) {
      successor = await options.open(tx, { ...prepared, checkpoint }, origin, run.mode, {
        sourceRunId: run.id
      });
    } else {
      const failed = await tx.workflowRuns.createRun({
        id: createPlatformId<"WorkflowRunId">("wfr"),
        clientInstanceId,
        workflow: run.workflow,
        definitionRevisionId: published?.revisionId ?? run.definitionRevisionId,
        definition: {
          ...(published?.manifest ??
            priorDefinition ?? {
              id: run.workflow,
              name: run.workflow,
              runAs: run.principal.name,
              inputs: {},
              outputs: {},
              steps: []
            }),
          onFailure: priorDefinition?.onFailure,
          labels: priorDefinition?.labels
        },
        input,
        mode: run.mode,
        principal: run.principal,
        limits: run.limits,
        deadlineAt: new Date(now().getTime() + run.limits.durationMs).toISOString(),
        createdAt: now().toISOString(),
        ...origin
      });
      successor = failed;
      if (failed)
        await options.finish(tx, failed, { status: "failed", ...(error ? { error } : {}) });
    }
    if (!successor) throw new AppError("INTERNAL", "The successor could not be recorded");
    await tx.workflowRuns.handoffContinuation({
      clientInstanceId,
      id: run.id,
      successorId: successor.id
    });
    if (!prepared)
      await options.finish(tx, successor, { status: "failed", ...(error ? { error } : {}) });
    await options.retireData(tx, run);
    return true;
  }
  return continueRun;
}
