import {
  AppError,
  INTERRUPTED_RUN_ERROR,
  assertOperationChecksRights,
  type AuthenticatedIdentity,
  type OperationCall,
  type OperationDefinition,
  type OperationDenial,
  type OperationRun,
  type OperationRunEnd,
  type OperationRunId
} from "@vivd-catalyst/core";
import {
  authorizeActor,
  authorizeOrigin,
  createRunContext,
  deniedEnd,
  executeAdmitted,
  hashInput,
  policyInputOf,
  policyRefuses,
  requireModuleOn,
  type OperationOutcome,
  type RunContext,
  type RunOperationDeps
} from "./operation-execution";
import { recordedResult } from "./run-operation";

/** The frozen call of a run that waits for an approval, as its approval request keeps it. */
export interface WaitingOperationCall {
  runId: OperationRunId;
  /**
   * The call as it was frozen, with its actor as that actor is now. Without an actor, the
   * actor no longer exists or may not act any more.
   */
  call: Omit<OperationCall, "actor"> & { actor: AuthenticatedIdentity | undefined };
}

/** Who decided on a waiting call. */
export interface OperationDecider {
  id: string;
  label: string;
  comment?: string;
}

/**
 * Asks again, before a call that waited for an approval is executed, whether it may still
 * run: the operation exists, the input is the one that was asked for, the actor still has the
 * right, the policy does not refuse it, and what it changes has not changed. A call that may
 * not is stale. Its run is ended here with the reason, because nothing else will end it, and
 * the answer is `true`. A run that was declined or expired is stale too and is left as it is.
 */
export async function endWaitingOperationIfStale(
  waiting: WaitingOperationCall,
  deps: RunOperationDeps
): Promise<boolean> {
  const run = await deps.runs.get({ clientInstanceId: deps.clientInstanceId, id: waiting.runId });
  if (!run) {
    return true;
  }
  if (run.status !== "pending_approval") {
    // A run that was taken for execution is not stale: approving it again answers what that
    // execution came to. Every other run that waits no more was declined or expired.
    return !wasTakenForExecution(run);
  }
  const now = (deps.now ?? (() => new Date()))();
  if (run.expiresAt !== undefined && new Date(run.expiresAt) <= now) {
    // The job that marks expired runs has not come by yet. The call is not executed.
    return true;
  }
  const stale = await findStaleness(run, waiting, deps);
  if (!stale) {
    return false;
  }
  const finishedAt = (deps.now ?? (() => new Date()))().toISOString();
  const end: Extract<OperationRunEnd, { status: "denied" | "failed" }> =
    "denial" in stale
      ? deniedEnd({ now: () => new Date(finishedAt) }, stale.denial)
      : { status: "failed", finishedAt, error: stale.error };
  await deps.runs.endWaiting({ clientInstanceId: deps.clientInstanceId, id: run.id, end });
  await stale.context?.emit(
    end.status === "denied" ? "operation.denied" : "operation.failed",
    "after",
    { status: end.status, reason: end.error.code }
  );
  return true;
}

type Staleness = { context?: RunContext } & (
  { denial: OperationDenial } | { error: { code: string; message: string } }
);

async function findStaleness(
  run: OperationRun,
  waiting: WaitingOperationCall,
  deps: RunOperationDeps
): Promise<Staleness | undefined> {
  const context = await waitingContext(run, waiting, deps).catch((error: unknown) => {
    if (error instanceof AppError && error.code === "NOT_FOUND") return undefined;
    throw error;
  });
  if (!context) {
    return { error: { code: "NOT_FOUND", message: "The operation of this call does not exist" } };
  }
  if ("actorGone" in context) {
    return {
      denial: {
        kind: "forbidden",
        action: context.definition.action ?? context.definition.name,
        reason: "holder_inactive"
      }
    };
  }
  const { definition, call, resource } = context;
  // The input was validated when the call was made and is not read through the schema again:
  // a schema that changes what it reads would refuse its own output. The hash says that what
  // is executed is what was asked for.
  if (hashInput(call.input) !== run.inputHash) {
    return {
      context,
      error: { code: "VALIDATION_FAILED", message: "The input of this call is no longer valid" }
    };
  }
  const access = await deps.authorizer.forActor(call.actor);
  const surface = await authorizeOrigin(call, definition, deps);
  const right = surface.allowed ? await authorizeActor(context, access) : surface;
  if (!right.allowed) {
    return {
      context,
      denial: { kind: "forbidden", action: right.action, reason: right.reason }
    };
  }
  if (policyRefuses(await policyInputOf(context))) {
    return { context, denial: { kind: "policy", operation: definition.name } };
  }
  const changed = await definition.isStale?.(call.input, {
    actor: call.actor,
    origin: call.origin,
    workspaceId: call.workspaceId,
    correlationId: call.correlationId,
    access,
    resource
  });
  return changed
    ? {
        context,
        error: {
          code: "CONFLICT",
          message: "What this call changes has changed since it was requested"
        }
      }
    : undefined;
}

/**
 * The run of a waiting call with its operation, as the call path needs them. Throws NOT_FOUND
 * where the operation is gone or its module is off.
 */
async function waitingContext(
  run: OperationRun,
  waiting: WaitingOperationCall,
  deps: RunOperationDeps
): Promise<RunContext | { actorGone: true; definition: OperationDefinition }> {
  const { actor } = waiting.call;
  const definition = await deps.registry.resolve(run.operation);
  if (!definition) {
    throw new AppError("NOT_FOUND", `Operation '${run.operation}' is not registered`);
  }
  assertOperationChecksRights(definition);
  if (!actor) {
    return { actorGone: true, definition };
  }
  const call: OperationCall = { ...waiting.call, actor };
  requireModuleOn(call, deps.modules);
  return createRunContext({
    run,
    definition,
    call,
    resource: definition.resource(call.input),
    deps,
    // The call is executed later and elsewhere than it was made: nothing of the live call is left.
    runtime: {}
  });
}

/**
 * Executes a call another person approved, once. The run is taken for execution in one
 * statement, so of two approvals of the same run one executes. An approval of a run that was
 * already taken answers what that execution came to and executes nothing. The call runs as
 * its original actor; the approver is recorded as who decided.
 */
export async function executeApprovedOperation(
  waiting: WaitingOperationCall,
  approver: OperationDecider,
  deps: RunOperationDeps
): Promise<OperationOutcome> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const taken = await deps.runs.resume({
    clientInstanceId: deps.clientInstanceId,
    id: waiting.runId,
    startedAt,
    decision: {
      mode: "approved",
      by: approver.id,
      byLabel: approver.label,
      at: startedAt,
      ...(approver.comment ? { comment: approver.comment } : {})
    }
  });
  if (!taken) {
    return answerTakenRun(waiting.runId, deps);
  }
  const context = await waitingContext(taken, waiting, deps);
  if ("actorGone" in context) {
    throw new AppError("INTERNAL", "An approved call lost its actor between check and execution");
  }
  const access = await deps.authorizer.forActor(context.call.actor);
  return { ...(await executeAdmitted(context, access)), replayed: false };
}

/** What an approval answers for a run that does not wait any more. */
async function answerTakenRun(
  runId: OperationRunId,
  deps: RunOperationDeps
): Promise<OperationOutcome> {
  const run = await deps.runs.get({ clientInstanceId: deps.clientInstanceId, id: runId });
  if (!run) {
    throw new AppError("NOT_FOUND", "The call of this request no longer exists");
  }
  if (run.decision?.mode !== "approved") {
    throw new AppError("CONFLICT", waitingEndedMessage(run), { operationRunId: run.id });
  }
  if (run.status === "running") {
    throw new AppError(
      "CONFLICT",
      "This call was approved and is being executed. Look at its run for the outcome.",
      { operationRunId: run.id }
    );
  }
  if (run.status === "failed" && run.error?.code === INTERRUPTED_RUN_ERROR.code) {
    // The execution was cut off. The record says so; nothing runs a second time.
    return { result: { status: "failed", runId, error: run.error }, run, replayed: true };
  }
  if (run.status === "done" && !run.output) {
    return { result: { status: "done", runId, output: undefined }, run, replayed: true };
  }
  return { result: recordedResult(run), run, replayed: true };
}

function waitingEndedMessage(run: OperationRun): string {
  switch (run.status) {
    case "expired":
      return "This call expired before it was decided. Nothing was executed.";
    case "denied":
      return "This call was declined. Nothing was executed.";
    default:
      return "This call does not wait for an approval any more.";
  }
}

/**
 * Ends a waiting call that a person declined: the run is `denied` as declined, with who
 * declined and the comment, and nothing is executed. Declining twice answers the same run. A
 * run that was taken for execution, or expired, refuses with what happened instead.
 */
export async function declineWaitingOperation(
  runId: OperationRunId,
  decider: OperationDecider,
  deps: RunOperationDeps
): Promise<OperationRun> {
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const comment = decider.comment ? { comment: decider.comment } : {};
  const denial: OperationDenial = { kind: "declined", by: decider.id, ...comment };
  const declined = await deps.runs.endWaiting({
    clientInstanceId: deps.clientInstanceId,
    id: runId,
    end: deniedEnd({ now: () => new Date(at) }, denial),
    decision: { mode: "declined", by: decider.id, byLabel: decider.label, at, ...comment }
  });
  if (declined) {
    return declined;
  }
  const run = await deps.runs.get({ clientInstanceId: deps.clientInstanceId, id: runId });
  if (!run) {
    throw new AppError("NOT_FOUND", "The call of this request no longer exists");
  }
  if (run.status === "denied" && run.decision?.mode === "declined") {
    return run;
  }
  throw new AppError(
    "CONFLICT",
    run.decision?.mode === "approved"
      ? "This call was approved and has been executed. It cannot be declined any more."
      : waitingEndedMessage(run),
    { operationRunId: run.id }
  );
}

/** Whether a waiting call was taken for execution: it ran, runs, or was cut off while running. */
export function wasTakenForExecution(run: OperationRun | undefined): boolean {
  return run?.decision?.mode === "approved";
}
