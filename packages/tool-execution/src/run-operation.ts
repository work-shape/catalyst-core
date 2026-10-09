import { createHash } from "node:crypto";
import {
  AppError,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  callerCanConfirm,
  createPlatformId,
  isAuthenticatedServicePrincipal,
  operationDenialError,
  resolvePolicy,
  toErrorEnvelope,
  unknownToJsonValue,
  type AuditRecorder,
  type Authorizer,
  type CentralPolicySetting,
  type ClientInstanceId,
  type JsonObject,
  type JsonValue,
  type Logger,
  type OperationCall,
  type OperationDefinition,
  type OperationDenial,
  type OperationExecutionContext,
  type OperationRegistry,
  type OperationResource,
  type OperationResult,
  type OperationRun,
  type OperationRunActor,
  type OperationRunEnd,
  type OperationRunId,
  type OperationRunStore,
  type PlatformEventEmitter,
  type PlatformEventName,
  type PlatformEventOutcome,
  type PolicyDefaults,
  type PolicyResolution
} from "@vivd-catalyst/core";
import { z } from "zod";
import { failureLogFields } from "./tool-failure-log";

/**
 * The largest answer of a completed changing call a run keeps for a repeated call. It bounds
 * what one row can hold. A repeated call whose first answer was larger reads 409
 * OUTPUT_NOT_RETAINED.
 */
const OPERATION_RUN_OUTPUT_MAX_BYTES = 256 * 1024;

/**
 * How long a call waits for another person's approval before it expires unexecuted. The
 * caller then reads 409 OPERATION_EXPIRED and calls again with a new key.
 */
const PENDING_APPROVAL_EXPIRES_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** How often a call looks again when the holder of its key changed while it looked. */
const IDEMPOTENCY_CLAIM_ATTEMPTS = 3;

/** Files the request another person decides. OP-1b supplies it for direct calls. */
export interface OperationApprovalRequests {
  request(input: {
    run: OperationRun;
    /** The call with its validated input, frozen as the request's payload. */
    call: OperationCall;
    resource: OperationResource | undefined;
  }): Promise<{ approvalRequestId: string }>;
}

export interface RunOperationDeps {
  clientInstanceId: ClientInstanceId;
  registry: OperationRegistry;
  runs: OperationRunStore;
  authorizer: Authorizer;
  events: PlatformEventEmitter;
  audit: AuditRecorder;
  policy: {
    instanceDefaults: PolicyDefaults;
    /** The admin's settings. OP-2 supplies the table; nothing is set before. */
    centralSettings(): readonly CentralPolicySetting[] | Promise<readonly CentralPolicySetting[]>;
  };
  /** Without it this surface cannot hold a call for an approval and refuses one that needs it. */
  approvals?: OperationApprovalRequests;
  logger: Logger;
  now?: () => Date;
}

/** What one call came to: the result for the caller, and the run that records it. */
export interface OperationOutcome {
  result: OperationResult;
  run: OperationRun;
  /** The result was read from the run of an earlier call with the same idempotency key. */
  replayed: boolean;
}

/**
 * The one path every call of a registered operation takes, from whichever surface: validate
 * the input, start the run, check the actor's right, resolve the policy, ask the guardrails,
 * execute, and record how it ended. A call whose input is invalid throws before a run exists;
 * every call that gets further has one.
 */
export async function runOperation(
  call: OperationCall,
  deps: RunOperationDeps
): Promise<OperationOutcome> {
  const definition = await deps.registry.resolve(call.operation);
  if (!definition) {
    throw new AppError("NOT_FOUND", `Operation '${call.operation}' is not registered`);
  }
  if (definition.effect !== call.effect) {
    throw new AppError("INTERNAL", `Operation '${call.operation}' is ${definition.effect}`);
  }
  const parsed = definition.inputSchema.safeParse(call.input);
  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", "Operation input is invalid", {
      issues: parsed.error.issues
    });
  }
  const input: unknown = parsed.data;
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
    const run = await deps.runs.create({
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
    });
    if (run) {
      return {
        ...(await executeRun(run, definition, frozen, resource, deps, now)),
        replayed: false
      };
    }
    if (idempotencyKey === undefined) break;
    const held = await deps.runs.findByIdempotencyKey({
      clientInstanceId: deps.clientInstanceId,
      actorId: actor.id,
      idempotencyKey
    });
    // A failed run is taken by the next `create`; a run that is gone frees the key.
    if (held && held.status !== "failed") {
      return { result: replay(held, definition, actor, inputHash), run: held, replayed: true };
    }
    if (held && !sameCall(held, definition, actor, inputHash)) {
      throw keyReused();
    }
  }
  throw new AppError("INTERNAL", `Operation '${definition.name}' could not start a run`);
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
  const runId = held.id;
  switch (held.status) {
    case "done":
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
      break;
  }
  throw new AppError("INTERNAL", `Operation run '${runId}' cannot be answered again`);
}

async function executeRun(
  run: OperationRun,
  definition: OperationDefinition,
  call: OperationCall,
  resource: OperationResource | undefined,
  deps: RunOperationDeps,
  now: () => Date
): Promise<Pick<OperationOutcome, "result" | "run">> {
  const subject = resource
    ? { kind: resource.kind, id: resource.id }
    : { kind: "operation", id: definition.name };
  const emit = (
    name: PlatformEventName,
    phase: "before" | "after",
    payload: JsonObject = {}
  ): Promise<PlatformEventOutcome> =>
    deps.events.emit(
      name,
      {
        operationRunId: run.id,
        operation: definition.name,
        effect: definition.effect,
        attempt: run.attempt,
        ...payload
      },
      {
        actor: call.actor,
        origin: call.origin,
        workspaceId: call.workspaceId,
        correlationId: call.correlationId,
        subject,
        phase
      }
    );
  const end = async (ended: OperationRunEnd): Promise<OperationRun> => {
    const finished = await deps.runs.finish({
      clientInstanceId: deps.clientInstanceId,
      id: run.id,
      end: ended
    });
    if (!finished) {
      // Something else ended the run meanwhile, such as the sweep for interrupted runs.
      deps.logger.warn(
        { operationRunId: run.id, operation: definition.name, status: ended.status },
        "Operation run was no longer running when its call ended"
      );
    }
    return finished ?? run;
  };
  const deny = async (
    denial: OperationDenial
  ): Promise<Pick<OperationOutcome, "result" | "run">> => {
    const error = operationDenialError(denial);
    const denied = await end({
      status: "denied",
      finishedAt: now().toISOString(),
      error: { code: error.code, message: error.message },
      denial
    });
    await emit("operation.denied", "after", { status: "denied", reason: error.code });
    return { result: { status: "denied", runId: run.id, reason: denial }, run: denied };
  };

  let executed = false;
  try {
    const access = await deps.authorizer.forActor(call.actor);
    if (definition.action !== null) {
      const right = access.authorize(definition.action, resource);
      await emit("operation.authorization_checked", "after", {
        action: definition.action,
        status: right.allowed ? "success" : "denied",
        ...(right.allowed ? {} : { reason: right.reason })
      });
      if (!right.allowed) {
        return await deny({ kind: "forbidden", action: definition.action, reason: right.reason });
      }
    }

    const policyInput = {
      definition,
      origin: call.origin,
      instanceDefaults: deps.policy.instanceDefaults,
      centralSettings: await deps.policy.centralSettings(),
      target: { workspaceId: call.workspaceId, assetKind: resource?.kind },
      callerCanConfirm: callerCanConfirm(call.origin),
      // No surface can hold a call for its actor's confirmation before OP-3.
      canPause: false
    };
    let policy: PolicyResolution = resolvePolicy(policyInput);
    if (policy.next === "refuse") {
      return await deny({ kind: "policy", operation: definition.name });
    }
    const guardrailOutcome = strictestOutcome([
      await emit("operation.before_call", "before"),
      ...(definition.events?.before ? [await emit(definition.events.before, "before")] : [])
    ]);
    policy = resolvePolicy({ ...policyInput, guardrailOutcome });
    if (policy.next === "refuse") {
      return await deny(
        policy.source === "guardrail"
          ? // The emitter names no guardrail yet, so the event that asked stands in for it.
            { kind: "guardrail", guardrailId: definition.events?.before ?? "operation.before_call" }
          : { kind: "policy", operation: definition.name }
      );
    }
    if (policy.next === "await_confirmation") {
      throw new AppError("INTERNAL", "This surface cannot hold a call for a confirmation");
    }
    if (policy.next === "await_approval") {
      if (!deps.approvals) return await deny({ kind: "policy", operation: definition.name });
      const { approvalRequestId } = await deps.approvals.request({ run, call, resource });
      const expiresAt = new Date(now().getTime() + PENDING_APPROVAL_EXPIRES_AFTER_MS).toISOString();
      const pending = await end({
        status: "pending_approval",
        finishedAt: now().toISOString(),
        approvalRequestId,
        inputRef: `approval_request:${approvalRequestId}`,
        expiresAt
      });
      return {
        result: { status: "pending_approval", runId: run.id, approvalRequestId, expiresAt },
        run: pending
      };
    }

    await emit("operation.started", "after", { status: "success" });
    const context: OperationExecutionContext = {
      runId: run.id,
      actor: call.actor,
      origin: call.origin,
      workspaceId: call.workspaceId,
      correlationId: call.correlationId,
      access,
      audit: auditForRun(deps.audit, run.id, call.correlationId)
    };
    const output = await definition.execute(call.input, context);
    executed = true;
    const done = await end({
      status: "done",
      finishedAt: now().toISOString(),
      output: definition.effect === "changing" ? retainedOutput(output) : undefined,
      ...("decisionMode" in policy
        ? { decision: { mode: policy.decisionMode, by: run.actor.id, at: now().toISOString() } }
        : {})
    });
    await emit("operation.completed", "after", { status: "success" });
    if (definition.events?.after) await emit(definition.events.after, "after");
    return { result: { status: "done", runId: run.id, output }, run: done };
  } catch (error) {
    // Once the call's work is done, a failure to record it is not a failure of the call.
    if (executed) throw error;
    // An operation that checks a right itself refuses through `context.access.require`.
    const refused = forbiddenSchema.safeParse(error);
    if (refused.success) return deny({ kind: "forbidden", ...refused.data.details });
    return fail(error, run, definition, call, deps, now, end, emit);
  }
}

async function fail(
  error: unknown,
  run: OperationRun,
  definition: OperationDefinition,
  call: OperationCall,
  deps: RunOperationDeps,
  now: () => Date,
  end: (ended: OperationRunEnd) => Promise<OperationRun>,
  emit: (name: PlatformEventName, phase: "after", payload: JsonObject) => Promise<unknown>
): Promise<Pick<OperationOutcome, "result" | "run">> {
  // The envelope is the one rule for what an error may tell: no thrown message of an
  // internal error and no provider text reaches the run, the audit row or the caller.
  const { statusCode, error: safe } = toErrorEnvelope(error, call.correlationId);
  if (statusCode >= 500) {
    deps.logger.error(
      {
        operationRunId: run.id,
        operation: definition.name,
        correlationId: call.correlationId,
        ...failureLogFields(error)
      },
      "Operation failed"
    );
  }
  const failed = await end({
    status: "failed",
    finishedAt: now().toISOString(),
    error: { code: safe.code, message: safe.message }
  });
  await emit("operation.failed", "after", { status: "failed", reason: safe.code });
  const details = detailsRecord(safe.details);
  return {
    result: {
      status: "failed",
      runId: run.id,
      error: { code: safe.code, message: safe.message, ...(details ? { details } : {}) }
    },
    run: failed
  };
}

const forbiddenSchema = z.object({
  code: z.literal("FORBIDDEN"),
  details: z.object({
    action: z.string(),
    reason: z.enum(["no_grant", "denied", "unknown_action", "holder_inactive"])
  })
});

function detailsRecord(details: unknown): Record<string, unknown> | undefined {
  return typeof details === "object" && details !== null && !Array.isArray(details)
    ? Object.fromEntries(Object.entries(details))
    : undefined;
}

const OUTCOME_ORDER: readonly PlatformEventOutcome[] = [
  "allow",
  "warn",
  "require_approval",
  "block"
];

function strictestOutcome(outcomes: readonly PlatformEventOutcome[]): PlatformEventOutcome {
  return outcomes.reduce(
    (left, right) => (OUTCOME_ORDER.indexOf(left) >= OUTCOME_ORDER.indexOf(right) ? left : right),
    "allow"
  );
}

/** The answer as the run keeps it, or nothing when it is larger than a run may hold. */
function retainedOutput(output: unknown): { value: JsonValue } | undefined {
  const value = unknownToJsonValue(output);
  return Buffer.byteLength(JSON.stringify(value)) <= OPERATION_RUN_OUTPUT_MAX_BYTES
    ? { value }
    : undefined;
}

/** Audit rows written inside a call name its run and share its correlation id. */
function auditForRun(
  audit: AuditRecorder,
  operationRunId: OperationRunId,
  correlationId: string
): AuditRecorder {
  return {
    record: (input) =>
      audit.record({
        ...input,
        correlationId,
        metadata: { ...input.metadata, operationRunId }
      })
  };
}

/** The hash a run keeps in place of its input: SHA-256 over the input with sorted keys. */
function hashInput(input: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(unknownToJsonValue(input)))
    .digest("hex");
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
