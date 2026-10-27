import {
  isAppError,
  type AppError,
  type AuditActor,
  type ClientInstanceId,
  type PlatformStores,
  type WorkflowRun,
  type WorkflowRunBounds
} from "@work-shape/catalyst-core";
import { z } from "zod";
import type { WorkflowDefinitionRevision } from "./definition-source";
import { principalActor } from "./run-identity";
import type { PreparedStart } from "./run-start";

// The start of the run of one due time: what a schedule checks before it writes a run, and
// what it writes. The job of the due time is in `schedule-trigger.ts`.

/** How a run is written: by whom it was started, and from what. */
export type RunOrigin = Pick<WorkflowRun, "trigger" | "startedBy" | "correlationId"> &
  Pick<
    Partial<WorkflowRun>,
    | "operationRunId"
    | "starterRunId"
    | "startedFrom"
    | "scheduledFor"
    | "deadlineAt"
    | "parentRunId"
    | "parentStepRunId"
    | "rootRunId"
    | "depth"
    | "itemIndex"
    | "itemLabel"
    | "runKey"
    | "labels"
    | "continuation"
  > & {
    actor: AuditActor;
    /** The bounds of the parent of a child run: the child counts against its root's slots. */
    parentLimits?: WorkflowRunBounds;
  };

interface ScheduledStartOptions {
  clientInstanceId: ClientInstanceId;
  prepareStart(published: WorkflowDefinitionRevision, given: unknown): Promise<PreparedStart>;
  openRun(
    tx: PlatformStores,
    prepared: PreparedStart,
    started: RunOrigin
  ): Promise<WorkflowRun | undefined>;
}

const reasonSchema = z.object({ reason: z.string().min(1) });

/** The reason a refused start names, for the record of a due time that started nothing. */
function refusalReason(error: AppError): string {
  const details = reasonSchema.safeParse(error.details);
  return details.success ? details.data.reason : error.code;
}

/**
 * Checks what a start checks before a transaction is open. Answers the reason where the
 * Workflow cannot be started now, and otherwise how the run of one due time is started inside
 * a transaction: once per due time, and not while the run of an earlier one is open.
 */
export function createScheduledStart(options: ScheduledStartOptions) {
  const { clientInstanceId, prepareStart, openRun } = options;
  return async function prepare(published: WorkflowDefinitionRevision) {
    let prepared: PreparedStart;
    try {
      // A schedule gives a run no input: a Workflow that needs one is not started by it.
      prepared = await prepareStart(published, {});
    } catch (error) {
      if (!isAppError(error)) throw error;
      return { refused: refusalReason(error) };
    }
    const { principal, published: revision } = prepared;
    return {
      async start(tx: PlatformStores, scheduledFor: Date, correlationId: string) {
        const due = scheduledFor.toISOString();
        const state = await tx.workflowRuns.readScheduleState({
          clientInstanceId,
          workflow: revision.manifest.id,
          scheduledFor: due
        });
        if (state.fired) return { outcome: "fired" as const };
        // The run of an earlier due time is still open: this one is skipped, not queued.
        if (state.open) return { outcome: "skipped" as const, reason: "overlap" };
        const run = await openRun(tx, prepared, {
          trigger: "schedule",
          scheduledFor: due,
          // Nobody is present at a due time: the run is started as its own principal.
          startedBy: { kind: "service_principal", id: principal.id, label: principal.displayLabel },
          actor: principalActor({ principal }),
          correlationId
        });
        return run ? { outcome: "started" as const } : { outcome: "fired" as const };
      }
    };
  };
}
