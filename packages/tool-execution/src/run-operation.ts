import {
  AppError,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  INTERRUPTED_RUN_ERROR,
  assertOperationChecksRights,
  createPlatformId,
  holdsForPublishedRun,
  isAuthenticatedServicePrincipal,
  operationDenialError,
  recordsAllowedCalls,
  type ActorAccess,
  type JsonObject,
  type NewOperationRun,
  type OperationAuthorization,
  type OperationCall,
  type OperationCallRuntime,
  type OperationDefinition,
  type OperationDenial,
  type OperationRun,
  type OperationRunActor,
  type PolicyResolution
} from "@work-shape/catalyst-core";
import {
  accessOf,
  authorizeRights,
  decideTarget,
  draftCallOf,
  rightsOf,
  simulateRun
} from "./draft-calls";
import {
  authorizeOrigin,
  createRunContext,
  denyRun,
  endRun,
  executeAdmitted,
  failRun,
  requireModuleOn,
  type DirectDecision,
  unrecordedRun,
  type OperationEnding,
  type OperationOutcome,
  type RunContext,
  type RunOperationDeps
} from "./operation-execution";
import {
  approvedByCaller,
  resolveGuardedPolicy,
  operationWorkspace
} from "./operation-policy-call";
import { recordedResult } from "./operation-recorded-result";
import { hashInput } from "./input-hash";

/**
 * How long a call waits for another person's approval before it expires unexecuted. The
 * caller then reads 409 OPERATION_EXPIRED and calls again with a new key.
 */
const PENDING_APPROVAL_EXPIRES_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a call an Agent Run holds waits for its person's confirmation (S8). */
const PENDING_CONFIRMATION_EXPIRES_AFTER_MS = 24 * 60 * 60 * 1000;

/** How long a confirmation waits in its person's Inbox, as an approval waits (OP-4b). */
const INBOX_CONFIRMATION_EXPIRES_AFTER_MS = PENDING_APPROVAL_EXPIRES_AFTER_MS;

/** How often a call looks again when the holder of its key changed while it looked. */
const IDEMPOTENCY_CLAIM_ATTEMPTS = 3;

/**
 * The one path every call of a registered operation takes, from whichever surface: validate
 * the input, start the run, check what the surface and the actor may do, resolve the policy,
 * ask the guardrails, execute, and record how it ended. A call whose input is invalid throws
 * before a run exists; every call that gets further has one.
 */
export async function runOperation(
  made: OperationCall,
  deps: RunOperationDeps,
  runtime: OperationCallRuntime = {}
): Promise<OperationOutcome> {
  const call = draftCallOf(made);
  requireModuleOn(call, deps.modules);
  const registered = await deps.registry.resolve(call.operation);
  if (!registered) {
    throw new AppError("NOT_FOUND", `Operation '${call.operation}' is not registered`);
  }
  let definition = registered;
  assertOperationChecksRights(definition);
  if (definition.completion && definition.effect !== "changing") {
    // Its run stays open after the call, which only a recorded call under a key has.
    throw new AppError("INTERNAL", `Operation '${call.operation}' ends later, so it is changing`);
  }
  if (definition.effect !== call.effect) {
    throw new AppError("INTERNAL", `Operation '${call.operation}' is ${definition.effect}`);
  }
  // The surface is asked before the input is read: a caller it does not admit learns nothing
  // of the operation's input from a refused input.
  const surface = await authorizeOrigin(call, definition, deps);
  const input = await parseInput(call, definition, runtime, surface);
  const readPages = runtime.readPages;
  if (readPages) {
    if (
      call.origin.kind !== "workflow" ||
      definition.effect !== "reading" ||
      !definition.paging ||
      definition.completion
    )
      throw new AppError(
        "VALIDATION_FAILED",
        "Only a reading Workflow operation with paging can read pages"
      );
    definition = {
      ...definition,
      execute: (_input, execution) =>
        readPages(async (pageInput, nextLink, signal, address) => {
          const current = await deps.registry.resolve(call.operation);
          if (!current) throw new AppError("NOT_FOUND", "The paged operation no longer exists");
          runtime.signal?.throwIfAborted();
          const parsed = await current.inputSchema.safeParseAsync(pageInput);
          if (!parsed.success)
            throw new AppError("VALIDATION_FAILED", "The page input does not fit the operation");
          const pageCall = { ...call, input: parsed.data };
          const surface = await authorizeOrigin(pageCall, current, deps);
          if (!surface.allowed) throw operationDenialError({ kind: "forbidden", ...surface });
          if (current.effect !== "reading" || !current.paging || current.completion)
            throw new AppError(
              "VALIDATION_FAILED",
              "The operation no longer supports a paged read"
            );
          const declared = current.resource(parsed.data);
          const resolved =
            current.action === null ? { resource: declared } : await deps.resolveResource(declared);
          const right = await authorizeRights(
            { definition: current, call: pageCall, ...resolved },
            await rightsOf(pageCall, deps)
          );
          if (!right.allowed) throw operationDenialError({ kind: "forbidden", ...right });
          return current.execute(parsed.data, {
            ...execution,
            runtime: {
              ...execution.runtime,
              ...(nextLink ? { pageAddress: nextLink } : {}),
              ...(address?.previous ? { previousPageAddress: address.previous } : {}),
              ...(address ? { notePageAddress: address.resolved } : {}),
              ...(signal
                ? {
                    signal: execution.runtime.signal
                      ? AbortSignal.any([execution.runtime.signal, signal])
                      : signal
                  }
                : {})
            }
          });
        }, execution.runId)
    };
  }
  const idempotencyKey = readIdempotencyKey(call, definition);
  const declared = definition.resource(input);
  const resolved =
    definition.action === null ? { resource: declared } : await deps.resolveResource(declared);
  const { resource } = resolved;
  const now = deps.now ?? (() => new Date());
  const actor = runActor(call);
  const frozen: OperationCall = {
    ...call,
    input,
    workspaceId: operationWorkspace(call, resource)
  };
  // The hash is kept and shown with the run, so it is never taken over a secret of the input.
  const withoutSecrets = definition.inputWithoutSecrets?.(input);
  const inputHash = hashInput(withoutSecrets === undefined ? input : withoutSecrets);
  if (withoutSecrets !== undefined && !definition.secret) {
    // This call's input holds a secret. A held call would keep it, so the call is one that
    // never waits and keeps no answer, like an operation whose answer is the secret.
    definition = { ...definition, secret: true };
  }
  const secretInput = withoutSecrets !== undefined;
  if (call.draft && definition.effect !== "reading" && idempotencyKey !== undefined) {
    // A changing call of a draft sent again under the key of a call that went live or to a
    // test target is answered by that call's run. It never carries that run out again: a
    // changing call of a draft goes live only through "Run live once" (ADR-0031).
    const held = await deps.runs.findByIdempotencyKey({
      clientInstanceId: deps.clientInstanceId,
      actor,
      idempotencyKey
    });
    if (held && !runsAgain(held, definition)) {
      return replay(held, definition, actor, inputHash, secretInput, deps);
    }
  }
  const target = await decideTarget({
    call,
    definition,
    deps,
    admitted: async () =>
      surface.allowed &&
      (
        await authorizeRights(
          { definition, call: frozen, ...resolved },
          await rightsOf(frozen, deps)
        )
      ).allowed
  });
  // A dry run holds no key: it would only ever answer a simulation again, and the same key
  // stays free for the live call (ADR-0031).
  const heldKey = target === "dry_run" ? undefined : idempotencyKey;

  for (let attempt = 0; attempt < IDEMPOTENCY_CLAIM_ATTEMPTS; attempt++) {
    const start: NewOperationRun = {
      id: createPlatformId<"OperationRunId">("oprun"),
      clientInstanceId: deps.clientInstanceId,
      operation: definition.name,
      effect: definition.effect,
      actor,
      workspaceId: frozen.workspaceId,
      origin: call.origin,
      target,
      conversationId: "conversationId" in call.origin ? call.origin.conversationId : undefined,
      idempotencyKey: heldKey,
      inputHash,
      correlationId: call.correlationId,
      startedAt: now().toISOString(),
      // What carries the call out is handed its key and carries out one call per key.
      ...(definition.repeatsUnderKey && heldKey !== undefined
        ? { takesInterrupted: true as const }
        : {})
    };
    // Every agent call leaves a trace, including tools that project native API operations.
    // Other allowed reads leave none unless the definition records every call; refusals and
    // failures are recorded either way.
    const recorded = call.origin.kind === "agent" || recordsAllowedCalls(definition);
    let run;
    if (runtime.resumeReadingRunId) {
      const held = await deps.runs.get({
        clientInstanceId: deps.clientInstanceId,
        id: runtime.resumeReadingRunId
      });
      if (
        !readPages ||
        !held ||
        !["running", "done"].includes(held.status) ||
        !sameCall(held, definition, actor, inputHash) ||
        held.actor.id !== actor.id ||
        held.origin.kind !== "workflow" ||
        call.origin.kind !== "workflow" ||
        held.origin.workflowRunId !== call.origin.workflowRunId ||
        held.origin.stepRunId !== call.origin.stepRunId
      )
        throw new AppError("CONFLICT", "The paged operation cannot resume this call");
      if (held.status === "done") {
        const right = await authorizeRights(
          { definition, call: frozen, ...resolved },
          await rightsOf(frozen, deps)
        );
        if (!surface.allowed || !right.allowed)
          throw new AppError("FORBIDDEN", "The paged call is no longer allowed");
        const output = await readPages(async () => {
          throw new AppError("CONFLICT", "A completed paged call cannot read another page");
        }, held.id);
        return { result: { status: "done", runId: held.id, output }, run: held, replayed: true };
      }
      run = held;
    } else run = recorded ? await deps.runs.create(start) : unrecordedRun(start);
    if (run) {
      const context = createRunContext({
        run,
        ...(recorded ? {} : { unrecordedStart: start }),
        definition,
        // A call a conversation caused is in that conversation's workspace, as its run says.
        call: { ...frozen, workspaceId: frozen.workspaceId ?? run.workspaceId },
        ...resolved,
        deps,
        runtime
      });
      const ending = await admitAndExecute(context, surface);
      return {
        ...ending,
        replayed: false,
        ...(context.unrecorded ? { unrecorded: true } : {}),
        ...(context.publishedWouldAsk ? { publishedWouldAsk: context.publishedWouldAsk } : {})
      };
    }
    if (heldKey === undefined) break;
    const held = await deps.runs.findByIdempotencyKey({
      clientInstanceId: deps.clientInstanceId,
      actor,
      idempotencyKey: heldKey
    });
    // A run that may be run again is taken by the next `create`; a run that is gone frees the
    // key. Every other run answers again what it answered, to the actor that holds its key and
    // without asking for the right again: the actor had it when the call ran, and a refusal
    // now would hide an outcome that happened and invite the same change under a new key.
    if (held && !runsAgain(held, definition)) {
      return replay(held, definition, actor, inputHash, secretInput, deps);
    }
    if (held && !sameCall(held, definition, actor, inputHash)) {
      throw keyReused();
    }
  }
  throw new AppError("INTERNAL", `Operation '${definition.name}' could not start a run`);
}

/**
 * How deeply the input of a call may be nested. No operation reads an input near it. What is
 * done with an input before a run exists follows it as deep as it goes: its schema, the hash a
 * run keeps of it. An input deeper than the stack would end the call with an error of the
 * process where it should end as an input that is invalid.
 */
export const OPERATION_INPUT_MAX_DEPTH = 256;

/** Whether no value of the input is nested deeper than `OPERATION_INPUT_MAX_DEPTH`. */
function withinInputDepth(input: unknown): boolean {
  // A list of what is left to look at, so the check itself needs no stack.
  const open: { value: unknown; depth: number }[] = [{ value: input, depth: 0 }];
  for (let next = open.pop(); next !== undefined; next = open.pop()) {
    const { value, depth } = next;
    if (typeof value !== "object" || value === null) continue;
    if (depth >= OPERATION_INPUT_MAX_DEPTH) return false;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      open.push({ value: child, depth: depth + 1 });
    }
  }
  return true;
}

/**
 * The validated input, or the refusal of a call whose input no run can be started with. The
 * schema is asked without blocking: an operation of an outside system checks its input in a
 * worker thread, and its check can end with an error of its own instead of an answer. A caller
 * the surface does not admit learns nothing of that either.
 */
async function parseInput(
  call: OperationCall,
  definition: OperationDefinition,
  runtime: OperationCallRuntime,
  surface: OperationAuthorization
): Promise<unknown> {
  const unreadable =
    runtime.unreadableInput ??
    (withinInputDepth(call.input)
      ? undefined
      : { code: "input_invalid", message: "Operation input is nested too deeply" });
  const parsed = unreadable
    ? undefined
    : await definition.inputSchema.safeParseAsync(call.input).catch((error: unknown) => {
        if (!surface.allowed) throw operationDenialError({ kind: "forbidden", ...surface });
        throw error;
      });
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
    // No person repeats these calls by hand: a frame, a step and a due time are run again by
    // code, and a changing call that code repeats without a key would change twice.
    if (
      call.origin.kind === "app" ||
      call.origin.kind === "workflow" ||
      call.origin.kind === "schedule"
    ) {
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
 * call does where it failed before its implementation started: one that started may have
 * changed something before it threw or was cut off. One that was cut off is made again all
 * the same where its operation says so (`repeatsUnderKey`): what carries it out is handed
 * the key and carries out one call per key.
 */
function runsAgain(run: OperationRun, definition: OperationDefinition): boolean {
  if (run.status !== "failed") return false;
  if (run.effect === "reading" || run.error?.unexecuted === true) return true;
  return definition.repeatsUnderKey === true && run.error?.code === INTERRUPTED_RUN_ERROR.code;
}

function keyReused(): AppError {
  return new AppError(
    "IDEMPOTENCY_KEY_REUSED",
    "This Idempotency-Key was used for another call. Send a new key."
  );
}

/** What the same call answers again, read from the run that holds its key. */
async function replay(
  held: OperationRun,
  definition: OperationDefinition,
  actor: OperationRunActor,
  inputHash: string,
  /** The call's input held a secret, so no answer was kept whatever the answer was. */
  secretInput: boolean,
  deps: RunOperationDeps
): Promise<OperationOutcome> {
  if (!sameCall(held, definition, actor, inputHash)) throw keyReused();
  let run = held;
  if (definition.completion && held.resultRef?.startsWith("operation_run:")) {
    const joined = await deps.runs.get({
      clientInstanceId: deps.clientInstanceId,
      id: held.resultRef.slice("operation_run:".length)
    });
    if (!joined || joined.operation !== definition.name)
      throw new AppError("INTERNAL", "The joined operation run is unavailable");
    run = joined;
  }
  return { result: recordedResult(run, definition, secretInput), run, replayed: true };
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
  const rights = await rightsOf(call, deps);
  // The surface and the right are asked here for every operation, so nobody without them
  // learns what the policy says or receives an approval.
  const right = surface.allowed ? await authorizeRights(context, rights) : surface;
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
        reason: right.reason,
        ...(right.message === undefined ? {} : { message: right.message }),
        ...(right.boundBy ? { boundBy: right.boundBy } : {})
      })
    };
  }

  const guarded = await resolveGuardedPolicy(context);
  if ("denial" in guarded) {
    return { ending: await denyRun(context, guarded.denial) };
  }
  const { policy, approvalAskedBy } = guarded;
  // A call of a test run resolves `confirm` as its tester's own call when their start was the
  // confirmation. A run of the published revision runs a `confirm` too, as its publish was the
  // confirmation, except where the operation's floor asks for one: there it asks for an approval.
  if (
    call.draft?.boundBy !== undefined &&
    policy.value === "confirm" &&
    holdsForPublishedRun(definition.policyFloor)
  ) {
    context.publishedWouldAsk = "approval";
  }
  if (run.target === "dry_run") {
    return { ending: await simulateRun(context, policy) };
  }
  // A subagent never waits for a decision: the call does not run, and the agent that started
  // the subagent makes it where its person is asked (CR-1).
  if (
    context.runtime.subagent &&
    (policy.next === "await_confirmation" || policy.next === "await_approval")
  ) {
    return {
      ending: await denyRun(context, {
        kind: "policy",
        operation: definition.name,
        reason: "confirmation_required"
      })
    };
  }
  // A file sent with the call lives as long as the call: nothing could carry it out later,
  // so a call with one that would wait is refused before anything waits for it.
  if (context.runtime.upload && policy.next === "await_confirmation") {
    return {
      ending: await denyRun(context, {
        kind: "policy",
        operation: definition.name,
        reason: "confirmation_required"
      })
    };
  }
  if (policy.next === "await_confirmation") {
    return {
      ending:
        policy.deliver === "inbox"
          ? await holdInInbox(context, policy)
          : await holdForConfirmation(context)
    };
  }
  if (policy.next === "await_approval") {
    const approval = await definition.approval?.(call.input);
    if (approval && approvedByCaller(context.call, policy, approval, accessOf(rights))) {
      return {
        access: accessOf(rights),
        decision: { mode: "approved", reason: "approved_by_caller" }
      };
    }
    // A held call is executed later, when nobody is there to be shown the secret once. An
    // approval the instance default alone asks for never gets here: the policy takes it as a
    // confirmation. So this refuses what a setting for the operation or a guardrail asked.
    if (definition.secret) {
      return { ending: await denyRun(context, { kind: "policy", operation: definition.name }) };
    }
    const unavailable: OperationDenial = {
      kind: "policy",
      operation: definition.name,
      reason: "approval_unavailable",
      ...(approvalAskedBy ? { guardrail: approvalAskedBy } : {})
    };
    // A file sent with the call is not kept for a later approval (see above).
    if (context.runtime.upload) {
      return { ending: await denyRun(context, unavailable) };
    }
    // A call of a draft that "Run live once" sent live does not wait: an approved call is
    // executed from the registry, which holds what is published and no draft, and a test run
    // has nothing that could ask its principal again. The approval gates it by refusing it.
    if (call.draft) {
      return { ending: await denyRun(context, unavailable) };
    }
    // The approval is asked and nothing can hold the call for it: the refusal says so.
    if (!deps.approvals) {
      return { ending: await denyRun(context, unavailable) };
    }
    const expiresAt = new Date(now().getTime() + PENDING_APPROVAL_EXPIRES_AFTER_MS).toISOString();
    // The call the approval answers reads what the approval is asked about: what could change
    // meanwhile, such as the newest revision of a Page, is held beside its input, in the keys
    // the operation declares.
    const heldInput = await heldInputOf(context);
    const filed = await deps.approvals.request({
      run,
      call,
      ...(Object.keys(heldInput).length > 0 ? { heldInput } : {}),
      resource: context.resource,
      runtime: context.runtime,
      expiresAt,
      policySource: policy.source,
      ...(approval ? { approval } : {})
    });
    if (!filed) {
      return { ending: await denyRun(context, unavailable) };
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
        waitingInput: call.input,
        run: pending
      }
    };
  }
  return {
    access: accessOf(rights),
    decision:
      "decisionMode" in policy
        ? { mode: policy.decisionMode, reason: policy.decisionReason }
        : undefined
  };
}

/**
 * Holds the call of an Agent Run for its person's confirmation: the run pauses and keeps the
 * input, and the call is executed once its person confirmed. Only the run's worker gets here
 * (`canPause`). A call whose answer holds a secret, or a draft's call sent live, cannot wait.
 */
async function holdForConfirmation(context: RunContext): Promise<OperationEnding> {
  const { run, definition, call, now } = context;
  // A read that records only its refusals has no run that could wait.
  if (definition.secret || call.draft || context.unrecorded || call.origin.kind !== "agent") {
    return denyRun(context, { kind: "policy", operation: definition.name });
  }
  const expiresAt = new Date(now().getTime() + PENDING_CONFIRMATION_EXPIRES_AFTER_MS).toISOString();
  const pending = await endRun(context, {
    status: "pending_confirmation",
    finishedAt: now().toISOString(),
    inputRef: `agent_run:${call.origin.agentRunId}`,
    expiresAt
  });
  return {
    result: {
      status: "pending_confirmation",
      ...(context.resource?.title ? { targetTitle: context.resource.title } : {}),
      runId: run.id,
      expiresAt,
      preview: call.input,
      inputHash: run.inputHash
    },
    run: pending
  };
}

/**
 * Holds a call that acts for a person who is not present until that person confirms it in
 * their Inbox (OP-4b): an `operation_call` request with the frozen call, addressed to them
 * alone. The run waits `pending_confirmation` on that item for 7 days. A call whose answer
 * holds a secret, a draft's call, and a call nobody could address cannot wait there.
 */
async function holdInInbox(
  context: RunContext,
  policy: PolicyResolution
): Promise<OperationEnding> {
  const { run, definition, call, deps, now } = context;
  const refused: OperationDenial = { kind: "policy", operation: definition.name };
  if (definition.secret || call.draft || context.unrecorded || !deps.approvals) {
    return denyRun(context, refused);
  }
  const expiresAt = new Date(now().getTime() + INBOX_CONFIRMATION_EXPIRES_AFTER_MS).toISOString();
  const heldInput = await heldInputOf(context);
  // What the call is about, where its operation names it, so the item shows it as the
  // approval it may file next does: the publish review of a publish.
  const approval = await definition.approval?.(call.input);
  const filed = await deps.approvals.request({
    run,
    call,
    ...(Object.keys(heldInput).length > 0 ? { heldInput } : {}),
    resource: context.resource,
    runtime: context.runtime,
    expiresAt,
    policySource: policy.source,
    ...(approval ? { approval } : {}),
    confirmation: true
  });
  if (!filed) {
    return denyRun(context, refused);
  }
  const { approvalRequestId } = filed;
  const pending = await endRun(context, {
    status: "pending_confirmation",
    finishedAt: now().toISOString(),
    approvalRequestId,
    inputRef: `approval_request:${approvalRequestId}`,
    expiresAt
  });
  return {
    result: {
      status: "pending_confirmation",
      ...(context.resource?.title ? { targetTitle: context.resource.title } : {}),
      runId: run.id,
      expiresAt,
      preview: call.input,
      inputHash: run.inputHash,
      approvalRequestId
    },
    waitingInput: call.input,
    run: pending
  };
}

/** What the before-events of a call hold beside its input, in the keys its operation declares. */
async function heldInputOf(context: RunContext): Promise<JsonObject> {
  const keys = context.definition.heldInputKeys ?? [];
  const held: JsonObject = {};
  if (keys.length === 0) return held;
  for (const event of context.beforeEvents ?? []) {
    const fields = await event.heldInput?.();
    for (const key of keys) {
      const value = fields?.[key];
      if (value !== undefined) held[key] = value;
    }
  }
  return held;
}
