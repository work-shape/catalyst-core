import {
  AppError,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  INTERRUPTED_RUN_ERROR,
  assertOperationChecksRights,
  createPlatformId,
  isAuthenticatedServicePrincipal,
  operationDenialError,
  recordsAllowedCalls,
  type ActorAccess,
  type NewOperationRun,
  type OperationAuthorization,
  type OperationCall,
  type OperationCallRuntime,
  type OperationDefinition,
  type OperationResult,
  type OperationRun,
  type OperationRunActor
} from "@vivd-catalyst/core";
import {
  authorizeActor,
  authorizeOrigin,
  createRunContext,
  denyRun,
  endRun,
  executeAdmitted,
  failRun,
  hashInput,
  requireModuleOn,
  resolveGuardedPolicy,
  type DirectDecision,
  unrecordedRun,
  type OperationEnding,
  type OperationOutcome,
  type RunContext,
  type RunOperationDeps
} from "./operation-execution";

/**
 * How long a call waits for another person's approval before it expires unexecuted. The
 * caller then reads 409 OPERATION_EXPIRED and calls again with a new key.
 */
const PENDING_APPROVAL_EXPIRES_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** How often a call looks again when the holder of its key changed while it looked. */
const IDEMPOTENCY_CLAIM_ATTEMPTS = 3;

/**
 * The one path every call of a registered operation takes, from whichever surface: validate
 * the input, start the run, check what the surface and the actor may do, resolve the policy,
 * ask the guardrails, execute, and record how it ended. A call whose input is invalid throws
 * before a run exists; every call that gets further has one.
 */
export async function runOperation(
  call: OperationCall,
  deps: RunOperationDeps,
  runtime: OperationCallRuntime = {}
): Promise<OperationOutcome> {
  requireModuleOn(call, deps.modules);
  const definition = await deps.registry.resolve(call.operation);
  if (!definition) {
    throw new AppError("NOT_FOUND", `Operation '${call.operation}' is not registered`);
  }
  assertOperationChecksRights(definition);
  if (definition.effect !== call.effect) {
    throw new AppError("INTERNAL", `Operation '${call.operation}' is ${definition.effect}`);
  }
  // The surface is asked before the input is read: a caller it does not admit learns nothing
  // of the operation's input from a refused input.
  const surface = await authorizeOrigin(call, definition, deps);
  const input = parseInput(call, definition, runtime, surface);
  const idempotencyKey = readIdempotencyKey(call, definition);
  const resource = definition.resource(input);
  const now = deps.now ?? (() => new Date());
  const actor = runActor(call);
  const frozen: OperationCall = {
    ...call,
    input,
    workspaceId: call.workspaceId ?? resource?.workspaceId
  };
  const inputHash = hashInput(input);

  for (let attempt = 0; attempt < IDEMPOTENCY_CLAIM_ATTEMPTS; attempt++) {
    const start: NewOperationRun = {
      id: createPlatformId<"OperationRunId">("oprun"),
      clientInstanceId: deps.clientInstanceId,
      operation: definition.name,
      effect: definition.effect,
      actor,
      workspaceId: frozen.workspaceId,
      origin: call.origin,
      conversationId: "conversationId" in call.origin ? call.origin.conversationId : undefined,
      idempotencyKey,
      inputHash,
      correlationId: call.correlationId,
      startedAt: now().toISOString()
    };
    // The definition says whether an allowed call leaves a run. A read that leaves none is
    // checked like every call and written only if it is refused or fails.
    const recorded = recordsAllowedCalls(definition);
    const run = recorded ? await deps.runs.create(start) : unrecordedRun(start);
    if (run) {
      const context = createRunContext({
        run,
        ...(recorded ? {} : { unrecordedStart: start }),
        definition,
        // A call a conversation caused is in that conversation's workspace, as its run says.
        call: { ...frozen, workspaceId: frozen.workspaceId ?? run.workspaceId },
        resource,
        deps,
        runtime
      });
      const ending = await admitAndExecute(context, surface);
      return { ...ending, replayed: false, ...(context.unrecorded ? { unrecorded: true } : {}) };
    }
    if (idempotencyKey === undefined) break;
    const held = await deps.runs.findByIdempotencyKey({
      clientInstanceId: deps.clientInstanceId,
      actor,
      idempotencyKey
    });
    // A run that may be run again is taken by the next `create`; a run that is gone frees the
    // key. Every other run answers again what it answered, to the actor that holds its key and
    // without asking for the right again: the actor had it when the call ran, and a refusal
    // now would hide an outcome that happened and invite the same change under a new key.
    if (held && !runsAgain(held)) {
      return { result: replay(held, definition, actor, inputHash), run: held, replayed: true };
    }
    if (held && !sameCall(held, definition, actor, inputHash)) {
      throw keyReused();
    }
  }
  throw new AppError("INTERNAL", `Operation '${definition.name}' could not start a run`);
}

/** The validated input, or the refusal of a call whose input no run can be started with. */
function parseInput(
  call: OperationCall,
  definition: OperationDefinition,
  runtime: OperationCallRuntime,
  surface: OperationAuthorization
): unknown {
  const unreadable = runtime.unreadableInput;
  const parsed = unreadable ? undefined : definition.inputSchema.safeParse(call.input);
  if (parsed?.success) {
    return parsed.data;
  }
  if (!surface.allowed) {
    throw operationDenialError({ kind: "forbidden", ...surface });
  }
  throw new AppError(
    "VALIDATION_FAILED",
    unreadable ? unreadable.message : "Operation input is invalid",
    {
      issues: unreadable
        ? [{ code: unreadable.code, path: [], message: unreadable.message }]
        : (parsed?.error.issues ?? [])
    }
  );
}

function readIdempotencyKey(call: OperationCall, definition: OperationDefinition) {
  if (definition.effect === "reading") return undefined;
  const key = call.idempotencyKey;
  if (key === undefined) {
    if (call.origin.kind === "app" || call.origin.kind === "workflow") {
      throw new AppError("VALIDATION_FAILED", "This call needs an Idempotency-Key");
    }
    return undefined;
  }
  if (key.length === 0 || key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new AppError(
      "VALIDATION_FAILED",
      `An Idempotency-Key has 1 to ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`
    );
  }
  return key;
}

/** The actor as the run keeps it: who, and for a delegated call through whom. */
function runActor(call: OperationCall): OperationRunActor {
  const { actor } = call;
  if (isAuthenticatedServicePrincipal(actor)) {
    return { kind: "service_principal", id: actor.id, label: actor.displayLabel };
  }
  return {
    kind: "user",
    id: actor.id,
    label: actor.displayLabel,
    ...(actor.delegatedActor ? { delegatedActor: actor.delegatedActor } : {})
  };
}

function sameCall(
  held: OperationRun,
  definition: OperationDefinition,
  actor: OperationRunActor,
  inputHash: string
): boolean {
  return (
    held.operation === definition.name &&
    held.inputHash === inputHash &&
    held.actor.kind === actor.kind
  );
}

/**
 * Whether the key of a failed run starts its call again. A read changed nothing. A changing
 * call does only where it failed before its implementation started: one that started may have
 * changed something before it threw or was cut off.
 */
function runsAgain(run: OperationRun): boolean {
  return run.status === "failed" && (run.effect === "reading" || run.error?.unexecuted === true);
}

function keyReused(): AppError {
  return new AppError(
    "IDEMPOTENCY_KEY_REUSED",
    "This Idempotency-Key was used for another call. Send a new key."
  );
}

/** What the same call answers again, read from the run that holds its key. */
function replay(
  held: OperationRun,
  definition: OperationDefinition,
  actor: OperationRunActor,
  inputHash: string
): OperationResult {
  if (!sameCall(held, definition, actor, inputHash)) throw keyReused();
  return recordedResult(held, definition);
}

/** The result a run that has an outcome answers with, whoever asks again. */
function recordedResult(held: OperationRun, definition: OperationDefinition): OperationResult {
  const runId = held.id;
  switch (held.status) {
    case "done":
      if (definition.secret) {
        // The secret went to the first call alone. Nothing here could answer it again.
        throw new AppError(
          "OUTPUT_NOT_RETAINED",
          "The call completed and its answer held a secret that is shown once and not kept. What the call created exists. If the secret is lost, revoke what the call created and call again with a new Idempotency-Key.",
          { operationRunId: runId }
        );
      }
      if (!held.output) {
        throw new AppError(
          "OUTPUT_NOT_RETAINED",
          "The call completed and its answer is not kept. Read the result from what it changed.",
          { operationRunId: runId }
        );
      }
      return { status: "done", runId, output: held.output.value };
    case "pending_approval":
      if (held.approvalRequestId === undefined || held.expiresAt === undefined) break;
      return {
        status: "pending_approval",
        runId,
        approvalRequestId: held.approvalRequestId,
        expiresAt: held.expiresAt
      };
    case "denied":
      if (!held.denial) break;
      return { status: "denied", runId, reason: held.denial };
    case "expired":
      return { status: "expired", runId };
    case "running":
    case "pending_confirmation":
      throw new AppError("OPERATION_IN_PROGRESS", "The first call with this key has not ended", {
        operationRunId: runId
      });
    case "failed":
      if (!held.error) break;
      if (held.error.code === INTERRUPTED_RUN_ERROR.code) {
        // Nobody knows how far the first call got, so the key never runs it a second time.
        throw new AppError(
          "OPERATION_IN_PROGRESS",
          "The first call with this key was interrupted and its outcome is not known. Check what it changed, then call again with a new Idempotency-Key.",
          { operationRunId: runId, interrupted: true }
        );
      }
      // The call may have changed something before it failed. It answers its failure again;
      // another attempt takes a new key.
      return {
        status: "failed",
        runId,
        error: { code: held.error.code, message: held.error.message }
      };
  }
  throw new AppError("INTERNAL", `Operation run '${runId}' cannot be answered again`);
}

async function admitAndExecute(
  context: RunContext,
  surface: OperationAuthorization
): Promise<OperationEnding> {
  let admitted: Admission;
  try {
    admitted = await admit(context, surface);
  } catch (error) {
    // Nothing of the operation ran: a check before it failed.
    return failRun(context, error, true);
  }
  return "ending" in admitted
    ? admitted.ending
    : executeAdmitted(context, admitted.access, admitted.decision);
}

/** A call that may run now, or how it ended before it could. */
type Admission = { ending: OperationEnding } | { access: ActorAccess; decision?: DirectDecision };

async function admit(context: RunContext, surface: OperationAuthorization): Promise<Admission> {
  const { run, definition, call, deps, now } = context;
  const access = await deps.authorizer.forActor(call.actor);
  // The surface and the right are asked here for every operation, so nobody without them
  // learns what the policy says or receives an approval.
  const right = surface.allowed ? await authorizeActor(context, access) : surface;
  await context.emit("operation.authorization_checked", "after", {
    ...(definition.action === null ? {} : { action: definition.action }),
    status: right.allowed ? "success" : "denied",
    ...(right.allowed ? {} : { action: right.action, reason: right.reason })
  });
  if (!right.allowed) {
    return {
      ending: await denyRun(context, {
        kind: "forbidden",
        action: right.action,
        reason: right.reason
      })
    };
  }

  const guarded = await resolveGuardedPolicy(context);
  if ("denial" in guarded) {
    return { ending: await denyRun(context, guarded.denial) };
  }
  const { policy } = guarded;
  if (policy.next === "await_confirmation") {
    throw new AppError("INTERNAL", "This surface cannot hold a call for a confirmation");
  }
  if (policy.next === "await_approval") {
    // A held call is executed later, when nobody is there to be shown the secret once. An
    // approval the instance default alone asks for never gets here: the policy takes it as a
    // confirmation. So this refuses what a setting for the operation or a guardrail asked.
    if (definition.secret) {
      return { ending: await denyRun(context, { kind: "policy", operation: definition.name }) };
    }
    if (!deps.approvals) {
      return { ending: await denyRun(context, { kind: "policy", operation: definition.name }) };
    }
    const expiresAt = new Date(now().getTime() + PENDING_APPROVAL_EXPIRES_AFTER_MS).toISOString();
    const filed = await deps.approvals.request({
      run,
      call,
      resource: context.resource,
      runtime: context.runtime,
      expiresAt
    });
    if (!filed) {
      return { ending: await denyRun(context, { kind: "policy", operation: definition.name }) };
    }
    const { approvalRequestId } = filed;
    const pending = await endRun(context, {
      status: "pending_approval",
      finishedAt: now().toISOString(),
      approvalRequestId,
      inputRef: `approval_request:${approvalRequestId}`,
      expiresAt
    });
    return {
      ending: {
        result: { status: "pending_approval", runId: run.id, approvalRequestId, expiresAt },
        run: pending
      }
    };
  }
  return {
    access,
    decision:
      "decisionMode" in policy
        ? { mode: policy.decisionMode, reason: policy.decisionReason }
        : undefined
  };
}
