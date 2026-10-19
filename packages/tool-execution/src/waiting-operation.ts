import {
  AGENT_TOOL_ACTION_PREFIX,
  AppError,
  INTERRUPTED_RUN_ERROR,
  assertOperationChecksRights,
  isDataToolName,
  type AuthenticatedIdentity,
  type JsonObject,
  type OperationCall,
  type OperationCallRuntime,
  type OperationDefinition,
  type OperationDenial,
  type OperationRun,
  type OperationRunDecision,
  type OperationRunEnd,
  type OperationRunId,
  type PolicyResolution
} from "@work-shape/catalyst-core";
import {
  authorizeActor,
  authorizeOrigin,
  createRunContext,
  deniedEnd,
  executeAdmitted,
  requireModuleOn,
  type ApprovedOperationEnd,
  type RunContext,
  type RunOperationDeps
} from "./operation-execution";
import { approvedByCaller, resolveGuardedPolicy } from "./operation-policy-call";
import { hashInput } from "./input-hash";
import { OperationNotBegunError } from "./operation-call";

/** The frozen call of a run that waits for an approval, as its approval request keeps it. */
export interface WaitingOperationCall {
  runId: OperationRunId;
  /**
   * The call as it was frozen, with its actor as that actor is now. Without an actor, the
   * actor no longer exists or may not act any more.
   */
  call: Omit<OperationCall, "actor"> & { actor: AuthenticatedIdentity | undefined };
  /**
   * What the call's before-events held beside its input, such as the revision of a Page it
   * copies. Merged into the input once the input's hash is checked, in the keys the operation
   * declares (`heldInputKeys`), so the call the approval answers is asked about and executes
   * what the approval was asked about.
   */
  heldInput?: JsonObject;
}

/** Who decided on a waiting call. */
export interface OperationDecider {
  id: string;
  label: string;
  comment?: string;
}

export type { ApprovedOperationEnd } from "./operation-execution";

/**
 * Executes a call another person approved, once, outside the request that approved it.
 *
 * While the run still waits, the call is asked again as the person who made it, as that person
 * is at this moment: the operation exists and its module is on, the input is the one that was
 * asked for, the surface and the right still allow it (where the workspace of the call is only
 * where it was made, the person is still a member of it), and the policy with its guardrails does not refuse it. A call that may not run
 * ends its run with the reason and is `refused`.
 *
 * The run is then taken for execution in one statement, so of two takers one executes, and
 * the operation is called at once: nothing is awaited between the two. A run that is found
 * already taken executes nothing and answers what the run says; one that is still `running`
 * was taken by an executor that is gone, so it is ended as interrupted and never runs a second
 * time.
 *
 * A `signal` that is aborted before the run is taken throws `OperationNotBegunError`: the run
 * still waits and whoever calls again executes it. Once it is taken, a call that takes longer
 * than its operation names, or whose `signal` is aborted, is told to stop through its own
 * signal and its run ends at once: as failed with `TIMEOUT`, or as interrupted.
 */
export async function executeApprovedOperation(
  waiting: WaitingOperationCall,
  approver: OperationDecider & { at: string },
  deps: RunOperationDeps,
  options: {
    signal?: AbortSignal;
    runtime?: Pick<OperationCallRuntime, "locale" | "runFence">;
  } = {}
): Promise<ApprovedOperationEnd> {
  options.signal?.throwIfAborted();
  const run = await deps.runs.get({ clientInstanceId: deps.clientInstanceId, id: waiting.runId });
  if (run?.status !== "pending_approval") {
    return readApprovedOperationEnd(waiting.runId, deps);
  }
  const decision: OperationRunDecision = {
    mode: "approved",
    by: approver.id,
    byLabel: approver.label,
    at: approver.at,
    ...(approver.comment ? { comment: approver.comment } : {})
  };
  const admitted = await admitAgain(run, waiting, deps, decision, options.runtime);
  if ("end" in admitted) {
    return admitted.end;
  }
  return executeWaitingCall(admitted.context, decision, options.signal);
}

/**
 * Executes the call an Agent Run held for its person's confirmation, once the person
 * confirmed: as `executeApprovedOperation` executes an approved call, asked again as the
 * person is now and taken in one statement, with the decision the run holds. It runs in the
 * worker of the Agent Run, with that run's hold and its person's language.
 */
export async function executeConfirmedOperation(
  waiting: WaitingOperationCall,
  deps: RunOperationDeps,
  options: { signal?: AbortSignal; runtime?: Pick<OperationCallRuntime, "locale" | "runFence"> }
): Promise<ApprovedOperationEnd> {
  options.signal?.throwIfAborted();
  const run = await deps.runs.get({ clientInstanceId: deps.clientInstanceId, id: waiting.runId });
  const decision = run?.decision;
  if (run?.status !== "pending_confirmation" || decision?.mode !== "confirmed") {
    return readApprovedOperationEnd(waiting.runId, deps);
  }
  const admitted = await admitAgain(run, waiting, deps, decision, options.runtime);
  if ("end" in admitted) {
    return admitted.end;
  }
  const { context, policy } = admitted;
  if (
    context.call.origin.kind === "agent" &&
    context.definition.name === "assets.publish" &&
    policy.next === "await_approval"
  ) {
    const approval = await context.definition.approval?.(context.call.input);
    const access = await deps.authorizer.forActor(context.call.actor);
    if (!approval || !access.authorize(approval.action).allowed)
      return holdForApproval(context, policy, waiting.heldInput, approval);
    return executeWaitingCall(
      context,
      { ...decision, mode: "approved", reason: "approved_by_caller" },
      options.signal
    );
  }
  return executeWaitingCall(context, decision, options.signal);
}

/**
 * How long a call its person confirmed in the Inbox then waits for another person's approval,
 * as every approval waits.
 */
const HELD_AFTER_CONFIRMATION_EXPIRES_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Executes a direct call its person confirmed in their Inbox (OP-4b), such as a publish sent
 * with `catalyst app publish --yes`. The Allow is the person's click in the interface: the
 * frozen call is asked again as their own direct call, as they are now, before-events and
 * guardrails included. Where that call would have run, it runs once, taken in one statement.
 * Where it would have waited for another person's approval, it files that approval as the
 * person's own click does and waits for it on the same run: `held`.
 */
export async function executeInboxConfirmedOperation(
  waiting: WaitingOperationCall,
  deps: RunOperationDeps,
  options: {
    /** The confirmation being executed; the run may already name a newer approval. */
    requestId: string;
    signal?: AbortSignal;
    runtime?: Pick<OperationCallRuntime, "locale" | "runFence">;
  }
): Promise<ApprovedOperationEnd> {
  options.signal?.throwIfAborted();
  const run = await deps.runs.get({ clientInstanceId: deps.clientInstanceId, id: waiting.runId });
  const decision = run?.decision;
  if (
    run?.status !== "pending_confirmation" ||
    decision?.mode !== "confirmed" ||
    run.origin.kind === "agent"
  ) {
    return readDecidedOperationEnd(waiting.runId, options.requestId, deps);
  }
  const asClicked: WaitingOperationCall = {
    ...waiting,
    call: { ...waiting.call, origin: { kind: "user" } }
  };
  const admitted = await admitAgain(run, asClicked, deps, decision, options.runtime);
  if ("end" in admitted) {
    return admitted.end;
  }
  const { context, policy } = admitted;
  if (policy.next !== "await_approval") {
    return executeWaitingCall(context, decision, options.signal);
  }
  const approval = await context.definition.approval?.(context.call.input);
  const access = await deps.authorizer.forActor(context.call.actor);
  if (approval && approvedByCaller(context.call, policy, approval, access)) {
    // An approver's own click is the approval, as when they click Publish themselves.
    return executeWaitingCall(
      context,
      {
        mode: "approved",
        reason: "approved_by_caller",
        by: context.call.actor.id,
        at: context.now().toISOString()
      },
      options.signal
    );
  }
  return holdForApproval(context, policy, waiting.heldInput, approval);
}

/**
 * Files the approval a confirmed call waits for next and moves its run on to wait for it. A
 * call nothing can hold for an approval is refused, as its person's own call would be.
 */
async function holdForApproval(
  context: RunContext,
  policy: PolicyResolution,
  heldInput: JsonObject | undefined,
  approval: Awaited<ReturnType<NonNullable<OperationDefinition["approval"]>>>
): Promise<ApprovedOperationEnd> {
  const { run, definition, call, deps } = context;
  const refuse = async () => {
    const end = deniedEnd(context, {
      kind: "policy",
      operation: definition.name,
      reason: "approval_unavailable"
    });
    const ended = await deps.runs.endWaiting({
      clientInstanceId: deps.clientInstanceId,
      id: run.id,
      end,
      ...(run.decision ? { decision: run.decision } : {})
    });
    return ended
      ? { execution: "refused" as const, run: ended, error: ended.error ?? UNKNOWN_END }
      : readDecidedOperationEnd(run.id, run.approvalRequestId, deps);
  };
  if (!deps.approvals || definition.secret) return refuse();
  const expiresAt = new Date(
    context.now().getTime() + HELD_AFTER_CONFIRMATION_EXPIRES_AFTER_MS
  ).toISOString();
  const filed = await deps.approvals.request({
    run,
    call,
    ...(heldInput ? { heldInput } : {}),
    resource: context.resource,
    runtime: context.runtime,
    expiresAt,
    policySource: policy.source,
    ...(approval ? { approval } : {})
  });
  if (!filed) return refuse();
  const moved = await deps.runs.holdConfirmedForApproval({
    clientInstanceId: deps.clientInstanceId,
    id: run.id,
    approvalRequestId: filed.approvalRequestId,
    inputRef: `approval_request:${filed.approvalRequestId}`,
    expiresAt
  });
  if (!moved) return readDecidedOperationEnd(run.id, run.approvalRequestId, deps);
  return { execution: "held", run: moved, approvalRequestId: filed.approvalRequestId };
}

/**
 * What a decided call that does not wait for its own request any more says: `held` where it
 * now waits for another person's approval on a newer request, else as an approved call.
 */
export async function readDecidedOperationEnd(
  runId: string,
  requestId: string | undefined,
  deps: Pick<RunOperationDeps, "clientInstanceId" | "runs">
): Promise<ApprovedOperationEnd> {
  const run = await deps.runs.get({ clientInstanceId: deps.clientInstanceId, id: runId });
  if (
    run?.status === "pending_approval" &&
    run.approvalRequestId !== undefined &&
    requestId !== undefined &&
    run.approvalRequestId !== requestId
  ) {
    return { execution: "held", run, approvalRequestId: run.approvalRequestId };
  }
  return readApprovedOperationEnd(runId, deps);
}

/**
 * What a run that does not wait any more says about its approved call. A run that is still
 * `running` is ended as interrupted: only the one executor of the run may ask.
 */
export async function readApprovedOperationEnd(
  runId: string,
  deps: Pick<RunOperationDeps, "clientInstanceId" | "runs">
): Promise<ApprovedOperationEnd> {
  const run = await deps.runs.get({ clientInstanceId: deps.clientInstanceId, id: runId });
  if (!run) {
    return {
      execution: "refused",
      error: { code: "NOT_FOUND", message: "The call of this request no longer exists." }
    };
  }
  if (
    run.status === "expired" ||
    run.status === "pending_approval" ||
    run.status === "pending_confirmation"
  ) {
    // A run that still waits and could not be taken ran out of time; the expiry job marks it.
    return { execution: "expired", run };
  }
  if (!wasTakenForExecution(run)) {
    return {
      execution: "refused",
      run,
      error: run.error ?? {
        code: "CONFLICT",
        message: "This call does not wait for an approval any more."
      }
    };
  }
  switch (run.status) {
    case "done":
      return { execution: "done", run };
    case "running": {
      const interrupted = await deps.runs.markInterrupted({
        clientInstanceId: deps.clientInstanceId,
        id: run.id
      });
      // A run that ended between the two statements says itself how.
      return interrupted
        ? { execution: "interrupted", run: interrupted, error: INTERRUPTED_RUN_ERROR }
        : readApprovedOperationEnd(runId, deps);
    }
    case "denied":
      return { execution: "refused", run, error: run.error ?? UNKNOWN_END };
    default:
      return {
        execution: run.error?.code === INTERRUPTED_RUN_ERROR.code ? "interrupted" : "failed",
        run,
        error: run.error ?? UNKNOWN_END
      };
  }
}

const UNKNOWN_END = { code: "INTERNAL", message: "The run does not say how the call ended." };

/**
 * Asks again whether a call that waits may run. A call that may not has its run ended here,
 * with the approval it had, because nothing else will end it. A run that stopped waiting
 * meanwhile, because its time ran out, says itself what became of it.
 */
async function admitAgain(
  run: OperationRun,
  waiting: WaitingOperationCall,
  deps: RunOperationDeps,
  decision: OperationRunDecision,
  runtime: Pick<OperationCallRuntime, "locale" | "runFence"> = {}
): Promise<{ context: RunContext; policy: PolicyResolution } | { end: ApprovedOperationEnd }> {
  const now = deps.now ?? (() => new Date());
  /** Ends the waiting run. Without a run to answer, the run did not wait any more. */
  const endWaiting = (end: Extract<OperationRunEnd, { status: "denied" | "failed" }>) =>
    deps.runs.endWaiting({ clientInstanceId: deps.clientInstanceId, id: run.id, end, decision });
  const refused = async (
    ended: OperationRun | undefined,
    error: (ended: OperationRun) => { code: string; message: string }
  ): Promise<{ end: ApprovedOperationEnd }> => ({
    end: ended
      ? { execution: "refused", run: ended, error: error(ended) }
      : await readApprovedOperationEnd(run.id, deps)
  });

  // A data tool's operation is read from its source. The agent's own list is asked before
  // that read, as where the call was made: a tool that left the agent while its approval
  // waited is refused here, and a source that is down is never asked about it.
  const { origin } = waiting.call;
  if (origin.kind === "agent" && isDataToolName(origin.toolName)) {
    const listed = (await deps.agentToolNames?.(origin.agentName, origin.conversationId)) ?? [];
    if (!listed.includes(origin.toolName)) {
      const ended = await endWaiting(
        deniedEnd(
          { now },
          {
            kind: "forbidden",
            action: `${AGENT_TOOL_ACTION_PREFIX}${origin.toolName}`,
            reason: "no_grant"
          }
        )
      );
      return refused(ended, (denied) => denied.error ?? UNKNOWN_END);
    }
  }
  const found = await waitingContext(run, waiting, deps, runtime).catch((error: unknown) => {
    if (error instanceof AppError && error.code === "NOT_FOUND") {
      return { gone: { code: error.code, message: error.message } };
    }
    throw error;
  });
  if ("gone" in found) {
    const { gone } = found;
    const ended = await endWaiting({
      status: "failed",
      finishedAt: now().toISOString(),
      error: { ...gone, unexecuted: true }
    });
    return refused(ended, () => gone);
  }
  if ("actorGone" in found) {
    const ended = await endWaiting(
      deniedEnd(
        { now },
        {
          kind: "forbidden",
          action: found.definition.action ?? found.definition.name,
          reason: "holder_inactive"
        }
      )
    );
    return refused(ended, (denied) => ({
      code: denied.error?.code ?? "FORBIDDEN",
      message: "The account of the person who made this call is closed or deleted."
    }));
  }
  const context = found;
  const { definition, call } = context;
  // The input was validated when the call was made and is not read through the schema again:
  // a schema that changes what it reads would refuse its own output. The hash says that what
  // is executed is what was asked for.
  if (hashInput(waiting.call.input) !== run.inputHash) {
    const error = {
      code: "VALIDATION_FAILED",
      message: "The input of this call is no longer valid"
    };
    const ended = await endWaiting({
      status: "failed",
      finishedAt: now().toISOString(),
      error: { ...error, unexecuted: true }
    });
    if (ended) {
      await context.emit("operation.failed", "after", { status: "failed", reason: error.code });
    }
    return refused(ended, () => error);
  }
  const refuse = async (denial: OperationDenial, message?: string) => {
    const end = deniedEnd(context, denial);
    const ended = await endWaiting(end);
    if (ended) {
      await context.emit("operation.denied", "after", {
        status: "denied",
        reason: end.error.code
      });
    }
    return refused(ended, (denied) =>
      message ? { code: denied.error?.code ?? "FORBIDDEN", message } : (denied.error ?? UNKNOWN_END)
    );
  };
  // An operation that decides its right itself decides it below, by the rule of the call: a
  // person may ask to join a workspace without being its member. Membership is asked here
  // where the workspace is only where the call was made: for an agent's call, and for an
  // operation whose right is a named action.
  const membershipIsTheRule = definition.action !== null || call.origin.kind === "agent";
  if (
    membershipIsTheRule &&
    call.workspaceId !== undefined &&
    deps.workspaceMember &&
    !(await deps.workspaceMember({ userId: call.actor.id, workspaceId: call.workspaceId }))
  ) {
    return refuse(
      {
        kind: "forbidden",
        action: definition.action ?? definition.name,
        reason: "no_grant"
      },
      "The person who made this call is no longer a member of its workspace."
    );
  }
  if (
    call.origin.kind === "agent" &&
    call.workspaceId !== undefined &&
    deps.agentAvailable &&
    !(await deps.agentAvailable({
      agentName: call.origin.agentName,
      workspaceId: call.workspaceId
    }))
  ) {
    return refuse(
      {
        kind: "forbidden",
        action: `${AGENT_TOOL_ACTION_PREFIX}${call.origin.toolName}`,
        reason: "no_grant"
      },
      "The agent that made this call is no longer available in its workspace."
    );
  }
  const access = await deps.authorizer.forActor(call.actor, {
    workspaceId: call.workspaceId ?? null
  });
  const surface = await authorizeOrigin(call, definition, deps);
  // An operation's own rule may answer with an error where it does not say that the resource
  // exists: a workspace the person has left is not found. The run ends with that error and
  // nothing is executed.
  const asked = surface.allowed
    ? await authorizeActor(context, access).catch((error: unknown) => {
        if (error instanceof AppError) {
          return { thrown: { code: error.code, message: error.message } };
        }
        throw error;
      })
    : surface;
  if ("thrown" in asked) {
    const { thrown } = asked;
    const ended = await endWaiting({
      status: "failed",
      finishedAt: now().toISOString(),
      error: { ...thrown, unexecuted: true }
    });
    if (ended) {
      await context.emit("operation.failed", "after", { status: "failed", reason: thrown.code });
    }
    return refused(ended, () => thrown);
  }
  const right = asked;
  await context.emit("operation.authorization_checked", "after", {
    ...(definition.action === null ? {} : { action: definition.action }),
    status: right.allowed ? "success" : "denied",
    ...(right.allowed ? {} : { action: right.action, reason: right.reason })
  });
  if (!right.allowed) {
    return refuse({ kind: "forbidden", action: right.action, reason: right.reason });
  }
  const guarded = await resolveGuardedPolicy(context);
  if ("denial" in guarded) {
    return refuse(guarded.denial);
  }
  return { context, policy: guarded.policy };
}

/**
 * The run of a waiting call with its operation, as the call path needs them. Throws NOT_FOUND
 * where the operation is gone or its module is off.
 */
async function waitingContext(
  run: OperationRun,
  waiting: WaitingOperationCall,
  deps: RunOperationDeps,
  runtime: Pick<OperationCallRuntime, "locale" | "runFence">
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
  // What the approval was asked about is read and executed again: only in the keys the
  // operation declares, so nothing held can change another field of the input.
  const held = Object.fromEntries(
    (definition.heldInputKeys ?? []).flatMap((key) => {
      const value = waiting.heldInput?.[key];
      return value === undefined ? [] : [[key, value] as const];
    })
  );
  const call: OperationCall = {
    ...waiting.call,
    actor,
    ...(Object.keys(held).length > 0 && isRecord(waiting.call.input)
      ? { input: { ...waiting.call.input, ...held } }
      : {})
  };
  requireModuleOn(call, deps.modules);
  return createRunContext({
    run,
    definition,
    call,
    ...(definition.action === null
      ? { resource: definition.resource(call.input) }
      : await deps.resolveResource(definition.resource(call.input))),
    deps,
    // The call is executed later and elsewhere than it was made: nothing of the live call is
    // left but, for a call an Agent Run's worker executes, that run's hold and language. Its
    // time and its signal are set where it is executed.
    runtime,
    // Its guardrails answer again before it is executed, and their hits were kept when it was
    // made.
    repeated: true
  });
}

/**
 * Takes the run and calls the operation, for at most the time its operation names and until
 * `signal` is aborted.
 */
async function executeWaitingCall(
  admitted: RunContext,
  decision: OperationRunDecision,
  signal: AbortSignal | undefined
): Promise<ApprovedOperationEnd> {
  const { deps, call } = admitted;
  const context: RunContext = {
    ...admitted,
    runtime: { ...admitted.runtime, signal }
  };
  const access = await deps.authorizer.forActor(call.actor, {
    workspaceId: call.workspaceId ?? null
  });
  /** What kept the call from being dispatched, where something did. */
  let notBegun: ApprovedOperationEnd | "still_waiting" | undefined;
  /**
   * The last thing before the operation is called: the run is marked as started here and not
   * earlier, and only while nobody asked this executor to stop.
   */
  const begin = async (): Promise<void> => {
    if (signal?.aborted) {
      notBegun = "still_waiting";
      throw new OperationNotBegunError();
    }
    const taken = await deps.runs.resume({
      clientInstanceId: deps.clientInstanceId,
      id: context.run.id,
      startedAt: context.now().toISOString(),
      decision
    });
    if (!taken) {
      notBegun = await readApprovedOperationEnd(context.run.id, deps);
      throw new OperationNotBegunError();
    }
    // Dispatch rechecks the signal after this await; a stop here is still unexecuted.
  };
  try {
    const first = await executeAdmitted(context, access, undefined, begin);
    const { result, run } = first;
    switch (result.status) {
      case "done":
        return { execution: "done", run, outcome: first };
      case "denied":
        return { execution: "refused", run, outcome: first, error: run.error ?? UNKNOWN_END };
      case "failed":
        return {
          execution: result.error.code === INTERRUPTED_RUN_ERROR.code ? "interrupted" : "failed",
          run,
          outcome: first,
          error: { code: result.error.code, message: result.error.message }
        };
      default:
        throw new AppError("INTERNAL", `An approved call ended as '${result.status}'`);
    }
  } catch (error) {
    if (error instanceof OperationNotBegunError && notBegun !== undefined) {
      if (notBegun === "still_waiting") throw error;
      return notBegun;
    }
    throw error;
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
  deps: Pick<RunOperationDeps, "clientInstanceId" | "runs" | "now">
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
      : run.status === "expired"
        ? "This call expired before it was decided. Nothing was executed."
        : "This call does not wait for an approval any more.",
    { operationRunId: run.id }
  );
}

/**
 * Ends a waiting call that nobody can decide any more, such as the call of a deleted
 * conversation or account: the run is `denied` with the reason and nothing is executed.
 * A run that does not wait any more is left as it is.
 */
export async function refuseWaitingOperation(
  runId: OperationRunId,
  denial: OperationDenial,
  deps: Pick<RunOperationDeps, "clientInstanceId" | "runs" | "now">
): Promise<void> {
  await deps.runs.endWaiting({
    clientInstanceId: deps.clientInstanceId,
    id: runId,
    end: deniedEnd({ now: deps.now ?? (() => new Date()) }, denial)
  });
}

/**
 * Whether a waiting call was taken for execution: it ran, runs, or was cut off while running.
 * A confirmed call that still waits for its run's worker has its decision and was not taken.
 */
export function wasTakenForExecution(run: OperationRun | undefined): boolean {
  return (
    (run?.decision?.mode === "approved" && run.status !== "pending_approval") ||
    (run?.decision?.mode === "confirmed" && run.status !== "pending_confirmation")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
