import {
  AppError,
  boundedActorAccess,
  isAuthenticatedServicePrincipal,
  type ActingServicePrincipal,
  type ActorAccess,
  type LiveOnceSwitch,
  type OperationAuthorization,
  type OperationCall,
  type OperationDefinition,
  type OperationTarget,
  type PlatformEventName,
  type PolicyResolution
} from "@work-shape/catalyst-core";
import {
  authorizeActor,
  endRun,
  type OperationEnding,
  type RunContext,
  type RunOperationDeps
} from "./operation-execution";

// Calls made by a draft (ADR-0031). Where a call goes is decided here, from the call's draft
// context and from the called asset, and by no caller, so an App draft, a Workflow test run
// and an agent testing a draft cannot differ.

/**
 * The call as its run keeps it. A call of a Workflow test run names in its origin the
 * principal that bounded it. Refuses a draft context that bounds anything else: only a
 * person's call from a step of a Workflow is bounded.
 */
export function draftCallOf(call: OperationCall): OperationCall {
  const boundBy = call.draft?.boundBy;
  if (!boundBy) return call;
  if (call.origin.kind !== "workflow" || isAuthenticatedServicePrincipal(call.actor)) {
    throw new AppError("INTERNAL", "Only a person's call from a Workflow test run is bounded");
  }
  return { ...call, origin: { ...call.origin, boundBy: principalRef(boundBy) } };
}

/**
 * Where the call goes. A call of what is live goes live, and so does every reading call of a
 * draft, with the rights of the person testing. A changing call of a draft is simulated,
 * unless its caller switched "Run live once" on for its action or step of its revision. An App
 * call uses the switch up. A call of a Workflow test run binds the switch to its run, and every
 * call of that step in that run goes live, each item of a loop and each retry. Only a call that
 * may be made takes the switch: a caller the surface or the right refuses leaves it, so nobody
 * without the right uses up a builder's switch. A test target of the called asset (a Data
 * Store's test copy, a Connection's test credential) will send every call of a draft there;
 * DT-2 and DT-3 add it here.
 */
export async function decideTarget(input: {
  call: OperationCall;
  definition: OperationDefinition;
  deps: RunOperationDeps;
  /** Whether the surface and the right admit the call, asked only where a switch could apply. */
  admitted: () => Promise<boolean>;
}): Promise<OperationTarget> {
  const { call, definition, deps, admitted } = input;
  const { draft } = call;
  if (!draft || definition.effect === "reading") return "live";
  if (definition.draftTarget) return definition.draftTarget;
  if (!deps.liveOnce || !(await admitted())) return "dry_run";
  const forRun = call.origin.kind === "workflow" ? call.origin.workflowRunId : undefined;
  const now = deps.now ?? (() => new Date());
  const { taken, firstUse, cleared } = await deps.liveOnce.take({
    clientInstanceId: deps.clientInstanceId,
    assetId: draft.asset.id,
    revisionId: draft.revisionId,
    part: draft.part,
    switchedBy: call.actor.id,
    ...(forRun === undefined ? {} : { forRun }),
    at: now().toISOString()
  });
  for (const stale of cleared) {
    await emitSwitchEvent("live_once.cleared", stale, call, deps, { reason: "draft_changed" });
  }
  if (!taken) return "dry_run";
  // A switch is used once: by the call that took it, or by the test run it was bound to.
  if (firstUse) {
    await emitSwitchEvent("live_once.used", taken, call, deps, {
      operation: definition.name,
      ...(forRun === undefined ? {} : { workflowRunId: forRun })
    });
  }
  return "live";
}

/** One audit row of a switch, with the asset as its subject. */
async function emitSwitchEvent(
  name: Extract<PlatformEventName, `live_once.${string}`>,
  set: LiveOnceSwitch,
  call: OperationCall,
  deps: RunOperationDeps,
  payload: Record<string, string>
): Promise<void> {
  await deps.events.emit(
    name,
    {
      kind: set.asset.kind,
      name: set.asset.name,
      revisionId: set.revisionId,
      part: set.part,
      switchedBy: set.switchedBy.id,
      ...payload
    },
    {
      actor: call.actor,
      origin: call.origin,
      workspaceId: call.workspaceId,
      correlationId: call.correlationId,
      subject: { kind: set.asset.kind, id: set.asset.id },
      phase: "after"
    }
  );
}

/** The rights a call is made with: its actor's, and in a test run the principal's beside them. */
export interface CallRights {
  own: ActorAccess;
  bound?: { principal: ActingServicePrincipal; access: ActorAccess };
}

export async function rightsOf(call: OperationCall, deps: RunOperationDeps): Promise<CallRights> {
  const own = await deps.authorizer.forActor(call.actor, { workspaceId: call.workspaceId ?? null });
  const principal = call.draft?.boundBy;
  return principal
    ? { own, bound: { principal, access: await deps.authorizer.forActor(principal) } }
    : { own };
}

/** What the operation is executed with: the actor's rights, bounded where the call is. */
export function accessOf(rights: CallRights): ActorAccess {
  return rights.bound
    ? boundedActorAccess(rights.own, rights.bound.access, principalRef(rights.bound.principal))
    : rights.own;
}

/**
 * Asks the operation's right of the actor and, in a test run, of the principal as a live run
 * of the published Workflow would ask it. A refusal on the principal's side names it.
 */
export async function authorizeRights(
  context: Pick<RunContext, "definition" | "call" | "resource" | "resourceNotFound">,
  rights: CallRights
): Promise<OperationAuthorization> {
  const own = await authorizeActor(context, rights.own);
  if (!own.allowed || !rights.bound) return own;
  const { principal, access } = rights.bound;
  const bound = await authorizeActor(
    { ...context, call: { ...context.call, actor: principal } },
    access
  );
  if (bound.allowed) return bound;
  // The operation's own sentence speaks of the person calling; the denial names the principal.
  return {
    allowed: false,
    action: bound.action,
    reason: bound.reason,
    boundBy: principalRef(principal)
  };
}

/**
 * Ends a changing call of a draft that is not made. Policy was resolved as for the live call,
 * so a refusal refused it already; the answer says whether the live call would have waited.
 * The run keeps no input and no answer, and holds no key.
 */
export async function simulateRun(
  context: RunContext,
  policy: PolicyResolution
): Promise<OperationEnding> {
  const { run, definition, call, now } = context;
  const wouldAsk: "confirmation" | "approval" | undefined =
    policy.next === "await_confirmation"
      ? "confirmation"
      : policy.next === "await_approval"
        ? "approval"
        : undefined;
  const simulated = await endRun(context, { status: "done", finishedAt: now().toISOString() });
  await context.emit("operation.simulated", "after", {
    status: "success",
    ...(wouldAsk ? { wouldAsk } : {})
  });
  return {
    result: {
      status: "dry_run",
      runId: run.id,
      // An input that holds a secret is not handed back.
      ...(definition.secret ? {} : { input: call.input }),
      ...(wouldAsk ? { wouldAsk } : {})
    },
    run: simulated
  };
}

function principalRef(principal: ActingServicePrincipal) {
  return { id: principal.id, label: principal.displayLabel };
}
