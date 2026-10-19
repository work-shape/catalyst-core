import {
  AppError,
  DATA_STORE_OPERATION_PREFIX,
  approvalExecutionOf,
  asUserId,
  isAppError,
  isAuthenticatedServicePrincipal,
  unknownToJsonValue,
  type ApprovalExecution,
  type ApprovalRequest,
  type ApprovalRequestContext,
  type ApprovalRequestCreator,
  type ApprovalRequestHandler,
  type ApprovalRequestOutcome,
  type ApprovalRequestStore,
  type ApprovalTransactionStores,
  type AuthenticatedUser,
  type ClientInstanceId,
  type ConfigAssetStore,
  type JsonObject,
  type OperationDenial,
  type OperationRun,
  type OperationRunStore,
  type OperationCallRuntime,
  type UserStore
} from "@work-shape/catalyst-core";
import {
  OPERATION_CALL_APPROVAL_KIND,
  declineWaitingOperation,
  executeApprovedOperation,
  executeConfirmedOperation,
  executeInboxConfirmedOperation,
  refuseWaitingOperation,
  wasTakenForExecution,
  type ApprovedOperationEnd,
  type OperationApprovalRequests,
  type RunOperationDeps,
  type WaitingOperationCall
} from "@work-shape/catalyst-tool-execution";
import { z } from "zod";
import { executeApprovedOperationCallJob } from "../jobs/job-kinds";
import { HELD_ASSET_OPERATION, type HeldAssetPreviewer } from "./held-asset-preview";
import type { HeldCallApprovalKind } from "./held-call-kind";
import {
  payloadSchema,
  parsePayload,
  toJsonObject,
  previewOf,
  type OperationCallPayload
} from "./operation-call-payload";
import { PUBLISH_APPROVAL_KINDS } from "./publish-approval";

/**
 * The approval kinds of a call that waits for another person: `operation_call`, and the kinds
 * of a held call that its operation names (`approval` of the definition), such as a publish.
 * Each is decided and executed alike; they differ in who decides and in what the item shows.
 */
export const HELD_CALL_APPROVAL_KINDS: readonly string[] = [
  OPERATION_CALL_APPROVAL_KIND,
  ...PUBLISH_APPROVAL_KINDS
];

/**
 * The largest input a call may have to be held for an approval, as JSON. The input is kept in
 * the request until the call is decided. A larger call is refused and says so.
 */
export const HELD_OPERATION_INPUT_MAX_BYTES = 256 * 1024;

/**
 * How many calls of one person may wait for an approval at once. It bounds what an agent in a
 * loop can put into the Inbox of the people who decide. One more is refused and says so.
 */
export const HELD_OPERATION_CALLS_PER_ACTOR = 25;

/**
 * How many calls may wait for an approval across the instance. It bounds the open list every
 * approver reads. One more is refused until some are decided or expire.
 */
export const HELD_OPERATION_CALLS_PER_INSTANCE = 2000;

export interface OperationCallApprovalOptions {
  clientInstanceId: ClientInstanceId;
  /** The call path the frozen call is executed on. Read when a request is decided. */
  deps(): RunOperationDeps;
  users: Pick<UserStore, "getUser">;
  /** Describes the asset a held `assets.put` saves. Without it such a call is shown as any other. */
  assetPreview?: HeldAssetPreviewer;
  /** Where a kind reads what its request is about, outside a decision. */
  configAssets: Pick<ConfigAssetStore, "getConfigAsset">;
  /**
   * The kinds of held call, for a request of another kind that is about the same subject: a
   * confirmation in the Inbox of a publish shows and checks the publish as its kind does.
   */
  subjectKinds?: readonly HeldCallApprovalKind[];
}

/**
 * The approval kind of a call that waits for another person: `operation_call`. Approving
 * records the decision and queues the Agent Run, or a standalone execution job for a direct
 * call. Its worker executes the frozen call once as the caller, with the approver recorded.
 * Nothing of the call runs in the
 * request that approves it. Whoever holds `operations.approve` decides, the caller included;
 * for a kind of held call, whoever holds its own right.
 *
 * A request in mode `confirmation` is the confirmation of the person the call acts for, who
 * was not present (OP-4b). Its run waits `pending_confirmation`; Allow records `confirmed` and
 * Deny `declined`. Only that person decides it: the request is addressed to them.
 *
 * Inside a decision the handler reads and writes through the stores of the decision's
 * transaction alone, so a decision holds one connection however many are made at once.
 */
export function createOperationCallApprovalHandler(
  options: OperationCallApprovalOptions,
  held?: HeldCallApprovalKind
): ApprovalRequestHandler {
  const { clientInstanceId } = options;
  /** The runs as the decision's transaction sees them. */
  const runsOf = (context: ApprovalRequestContext): OperationRunStore =>
    context.transaction?.operationRuns ?? options.deps().runs;
  /** The assets as the decision's transaction sees them. */
  const storesOf = (
    context: ApprovalRequestContext
  ): Pick<ApprovalTransactionStores, "configAssets"> =>
    context.transaction ?? { configAssets: options.configAssets };
  const runIdOf = (payload: JsonObject) => payloadSchema.pick({ runId: true }).safeParse(payload);
  /** The kind that knows what the call is about: its own, or the one its subject names. */
  const subjectKindOf = (call: OperationCallPayload): HeldCallApprovalKind | undefined =>
    held ??
    (call.subjectKind === undefined
      ? undefined
      : options.subjectKinds?.find((kind) => kind.kind === call.subjectKind));

  return {
    kind: held?.kind ?? OPERATION_CALL_APPROVAL_KIND,
    requiredPermission: held?.requiredPermission ?? "operations.approve",
    validate(payload) {
      return toJsonObject(parsePayload(payload));
    },
    async preview(payload, context) {
      const call = parsePayload(payload);
      // Only while the call waits: afterwards its input is gone, and the stored asset may
      // already be what the call saved.
      const asset =
        context.status === "pending" &&
        !call.inputRemoved &&
        call.operation === HELD_ASSET_OPERATION
          ? await options.assetPreview?.(unknownToJsonValue(call.input), context.viewer)
          : undefined;
      // What the call is about, while it waits.
      const about = subjectKindOf(call);
      const review =
        about && call.subject && context.status === "pending"
          ? await about.review(call.subject, context.viewer?.inList ?? false, context.viewer)
          : undefined;
      const [storeName, verb, ...rest] = call.operation.startsWith(DATA_STORE_OPERATION_PREFIX)
        ? call.operation.slice(DATA_STORE_OPERATION_PREFIX.length).split(".")
        : [];
      const store =
        context.status === "pending" &&
        !call.inputRemoved &&
        storeName &&
        rest.length === 0 &&
        verb &&
        ["insert", "update", "delete_rows"].includes(verb)
          ? await options.configAssets.getConfigAsset({
              clientInstanceId,
              kind: "data_store",
              name: storeName
            })
          : undefined;
      const target = z.object({ title: z.string() }).safeParse(store?.publishedConfig);
      return toJsonObject({
        ...previewOf(call),
        ...(target.success ? { targetTitle: target.data.title } : {}),
        ...(asset ? { asset } : {}),
        ...(review ? { review } : {})
      });
    },
    async isStale(payload, context) {
      const call = parsePayload(payload);
      const { runId } = call;
      const run = await runsOf(context).get({ clientInstanceId, id: runId });
      if (!run) {
        // A call whose run is gone was deleted with its conversation or its retention.
        return { result: refusedResult(runId, GONE) };
      }
      const now = (options.deps().now ?? (() => new Date()))();
      // A confirmation in the Inbox waits as a confirmation, an approval as an approval.
      const waiting = call.mode === "confirmation" ? "pending_confirmation" : "pending_approval";
      if (
        run.status === "expired" ||
        (run.status === waiting && run.expiresAt !== undefined && new Date(run.expiresAt) <= now)
      ) {
        // The decision came too late to count. The expiry job marks the run where it has not.
        return { result: { runId, execution: "expired" }, undecided: true };
      }
      if (run.status !== waiting) {
        return { result: refusedResult(runId, run.error ?? WAITS_NO_MORE) };
      }
      const about = subjectKindOf(call);
      const moved =
        about && call.subject
          ? await about.moved(call.subject, storesOf(context).configAssets)
          : undefined;
      if (moved) {
        // Nothing of it is approved any more: the call ends refused with the request.
        await refuseWaitingOperation(
          run.id,
          { kind: "policy", operation: run.operation, reason: "approval_stale" },
          { clientInstanceId, runs: runsOf(context), now: options.deps().now }
        );
        return { result: refusedResult(runId, { code: "CONFLICT", message: moved }) };
      }
      return false;
    },
    async isApplied(payload, context) {
      const parsed = runIdOf(payload);
      return parsed.success
        ? wasTakenForExecution(
            await runsOf(context).get({ clientInstanceId, id: parsed.data.runId })
          )
        : false;
    },
    async apply(payload, approver, context) {
      const { runId, mode } = parsePayload(payload);
      if (!context.transaction) {
        throw new AppError("INTERNAL", "An operation call is approved inside its decision");
      }
      const run = await context.transaction.operationRuns.get({ clientInstanceId, id: runId });
      let resumesAgent = false;
      // A confirmation always records its decision on the run: only a confirmed call is taken.
      if (mode === "confirmation" && !run) {
        throw new AppError(
          "CONFLICT",
          "This call no longer waits for your confirmation. Nothing ran."
        );
      }
      if (run && (run.origin.kind === "agent" || mode === "confirmation")) {
        const approved = await context.transaction.operationRuns.approveWaiting({
          clientInstanceId,
          id: run.id,
          decision: {
            mode: mode === "confirmation" ? "confirmed" : "approved",
            by: approver.id,
            byLabel: approver.displayLabel,
            at: (options.deps().now ?? (() => new Date()))().toISOString()
          }
        });
        if (!approved)
          throw new AppError(
            "CONFLICT",
            mode === "confirmation"
              ? "This call no longer waits for your confirmation. Nothing ran."
              : "This call no longer waits for approval. Nothing ran."
          );
        resumesAgent = approved.resumesAgent;
      }
      if (!resumesAgent)
        await context.transaction.jobs.enqueue(
          executeApprovedOperationCallJob,
          { requestId: context.requestId },
          {
            clientInstanceId,
            subject: runId,
            dedupeKey: context.requestId,
            concurrencyKey: context.requestId,
            correlationId: context.correlationId
          }
        );
      // The decision is recorded now; what the call came to is recorded when it has run.
      return { runId, requestId: context.requestId, execution: "queued" };
    },
    async declined(payload, decision, context) {
      const parsed = runIdOf(payload);
      if (!parsed.success) return;
      const runs = runsOf(context);
      const run = await runs.get({ clientInstanceId, id: parsed.data.runId });
      // A run that is gone, or that expired meanwhile, has nothing left to end.
      if (!run || run.status === "expired") return;
      await declineWaitingOperation(
        run.id,
        { id: decision.decidedBy, label: decision.decidedByLabel, comment: decision.comment },
        { clientInstanceId, runs, now: options.deps().now }
      );
    },
    endedPayload: minimizedOperationCallPayload
  };
}

const GONE = { code: "NOT_FOUND", message: "The call of this request no longer exists." };
const WAITS_NO_MORE = {
  code: "CONFLICT",
  message: "This call does not wait for an approval any more."
};

function refusedResult(runId: string, error: { code: string; message: string }): JsonObject {
  return { runId, execution: "refused", error: { code: error.code, message: error.message } };
}

/**
 * What an ended request keeps of its frozen call: which call it was, of whom and from where.
 * The input, and how the person was signed in when they made the call, are removed. A payload
 * that cannot be read keeps nothing but the mark.
 */
export function minimizedOperationCallPayload(payload: JsonObject): JsonObject {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    return { inputRemoved: true };
  }
  const { runId, operation, effect, actor, origin, workspaceId, expiresAt, subject } = parsed.data;
  const { mode, subjectKind } = parsed.data;
  return toJsonObject({
    runId,
    operation,
    effect,
    ...(mode ? { mode } : {}),
    ...(subject ? { subject } : {}),
    ...(subjectKind ? { subjectKind } : {}),
    actor: { id: actor.id, label: actor.label },
    origin,
    ...(workspaceId ? { workspaceId } : {}),
    expiresAt,
    inputRemoved: true
  });
}

/**
 * How a held call ends that nobody decided: its request is `superseded` with the reason and
 * without its input. For the paths that end a call from outside a decision.
 */
export function endedOperationCallOutcome(
  request: Pick<ApprovalRequest, "payload">,
  end: { execution: Extract<ApprovalExecution, "refused" | "expired">; error?: OperationCallError }
): ApprovalRequestOutcome {
  const runId = payloadSchema.pick({ runId: true }).safeParse(request.payload);
  return {
    status: "superseded",
    applyResult: {
      ...(runId.success ? { runId: runId.data.runId } : {}),
      execution: end.execution,
      ...(end.error ? { error: { code: end.error.code, message: end.error.message } } : {})
    },
    payload: minimizedOperationCallPayload(request.payload)
  };
}

interface OperationCallError {
  code: string;
  message: string;
}

export interface HeldOperationCallEnderOptions {
  clientInstanceId: ClientInstanceId;
  approvals: Pick<
    ApprovalRequestStore,
    "listApprovalRequests" | "transitionPendingApprovalRequest"
  >;
  now?: () => Date;
}

/** How many held calls one pass of an ender reads at once. A person holds at most 25. */
const HELD_CALLS_END_PAGE_SIZE = 100;

/**
 * How often an ender reads again after it met a request somebody decides at that moment, and
 * how long it waits before each: at most 3 times 200 ms. What is still held after that is
 * ended by the cleanup job of ended requests, which finds a request whose run is gone.
 */
const HELD_CALLS_LOCKED_RETRIES = 3;
const HELD_CALLS_LOCKED_RETRY_MS = 200;

/**
 * Ends the held calls that match, for a reason outside any decision: their conversation or
 * the account of the person who made them is deleted. In one transaction per call the run is
 * ended as refused, where it still waits, and the request is `superseded` without its input.
 * A call somebody decides at the same moment is read again shortly after; one that is still
 * being decided then is left to that decision, and to the cleanup job if the decision fails.
 */
export async function endHeldOperationCalls(
  options: HeldOperationCallEnderOptions,
  filter: Partial<
    Pick<
      Parameters<ApprovalRequestStore["listApprovalRequests"]>[0],
      "conversationId" | "requestedById" | "kinds" | "subjectContains"
    >
  >,
  reason: { denial: OperationDenial; message: string },
  /** A run that is not ended with its request: the call that files the newer one. */
  keepRunId?: string
): Promise<number> {
  const { clientInstanceId, approvals } = options;
  let ended = 0;
  let waits = 0;
  for (;;) {
    const held = await approvals.listApprovalRequests({
      clientInstanceId,
      kinds: HELD_CALL_APPROVAL_KINDS,
      ...filter,
      status: "pending",
      page: { limit: HELD_CALLS_END_PAGE_SIZE }
    });
    let endedOfPage = 0;
    let locked = 0;
    for (const request of held) {
      try {
        await approvals.transitionPendingApprovalRequest({
          clientInstanceId,
          requestId: request.id,
          resolve: async (pending, stores) => {
            const runId = payloadSchema.pick({ runId: true }).safeParse(pending.payload);
            const run = runId.success
              ? await stores.operationRuns.get({ clientInstanceId, id: runId.data.runId })
              : undefined;
            if (run && run.id !== keepRunId) {
              await refuseWaitingOperation(run.id, reason.denial, {
                clientInstanceId,
                runs: stores.operationRuns,
                now: options.now
              });
            }
            return endedOperationCallOutcome(pending, {
              execution: "refused",
              error: { code: "FORBIDDEN", message: reason.message }
            });
          }
        });
        endedOfPage += 1;
      } catch (error) {
        // Somebody decides or decided it at this moment.
        if (!(isAppError(error) && (error.code === "CONFLICT" || error.code === "NOT_FOUND"))) {
          throw error;
        }
        locked += 1;
      }
    }
    ended += endedOfPage;
    if (locked > 0 && waits < HELD_CALLS_LOCKED_RETRIES) {
      // The decision that holds the request is over in a moment. If it took the call, the
      // request is no longer open; if it failed, the request is open again and is ended now.
      waits += 1;
      await new Promise((resolve) => setTimeout(resolve, HELD_CALLS_LOCKED_RETRY_MS));
      continue;
    }
    // A page that ended nothing would be read again as it is.
    if (held.length < HELD_CALLS_END_PAGE_SIZE || endedOfPage === 0) return ended;
  }
}

export interface ApprovedOperationCallExecutorOptions extends Pick<
  OperationCallApprovalOptions,
  "clientInstanceId" | "deps" | "users"
> {
  approvals: Pick<ApprovalRequestStore, "getApprovalRequest" | "transitionApprovedApprovalRequest">;
}

/**
 * Executes the call of an approved request and records on the request what it came to:
 * `approved` with `execution` `done`, `failed` or `interrupted`, or `superseded` with
 * `refused` or `expired` where the call was not executed. The input leaves the payload in the
 * same statement. Safe to repeat: a request whose call has an outcome is left as it is, and a
 * run that an earlier attempt took and did not end is recorded as interrupted, never run again.
 *
 * It is the job of one request at a time: no two callers may run it for the same request at
 * the same moment.
 */
export async function executeApprovedOperationCall(
  options: ApprovedOperationCallExecutorOptions,
  requestId: string,
  signal?: AbortSignal,
  runtime?: Pick<OperationCallRuntime, "locale" | "runFence">
): Promise<ApprovedOperationEnd | undefined> {
  const { clientInstanceId } = options;
  const request = await options.approvals.getApprovalRequest({ clientInstanceId, requestId });
  if (
    !request ||
    !HELD_CALL_APPROVAL_KINDS.includes(request.kind) ||
    request.status !== "approved" ||
    approvalExecutionOf(request) !== "queued"
  ) {
    return;
  }
  const end = await runFrozenCall(options, request, signal, runtime);
  await recordApprovedOperationCallEnd(options, requestId, end);
  return end;
}

async function runFrozenCall(
  options: ApprovedOperationCallExecutorOptions,
  request: ApprovalRequest,
  signal: AbortSignal | undefined,
  runtime?: Pick<OperationCallRuntime, "locale" | "runFence">
): Promise<ApprovedOperationEnd> {
  const { clientInstanceId } = options;
  const deps = options.deps();
  const parsed = payloadSchema.safeParse(request.payload);
  const { decision } = request;
  if (!parsed.success || parsed.data.inputRemoved || !decision) {
    return {
      execution: "refused",
      error: { code: "CONFLICT", message: "The frozen call of this request cannot be read." }
    };
  }
  const payload = parsed.data;
  const run = await deps.runs.get({ clientInstanceId, id: payload.runId });
  if (!run) {
    return { execution: "refused", error: GONE };
  }
  const waiting: WaitingOperationCall = {
    runId: run.id,
    call: {
      operation: run.operation,
      effect: run.effect,
      input: payload.input,
      actor: await currentActor(options, run, payload),
      origin: run.origin,
      workspaceId: run.workspaceId,
      idempotencyKey: run.idempotencyKey,
      correlationId: run.correlationId
    },
    ...(payload.heldInput ? { heldInput: toJsonObject(payload.heldInput) } : {})
  };
  if (payload.mode === "confirmation") {
    // The person confirmed their own call in the Inbox. An agent's call is executed as
    // confirmed; a direct call is asked again as the person's own click (OP-4b).
    const confirmedOptions = {
      requestId: request.id,
      ...(signal ? { signal } : {}),
      ...(runtime ? { runtime } : {})
    };
    return run.origin.kind === "agent"
      ? executeConfirmedOperation(waiting, deps, confirmedOptions)
      : executeInboxConfirmedOperation(waiting, deps, confirmedOptions);
  }
  return executeApprovedOperation(
    waiting,
    {
      id: decision.decidedBy,
      label: decision.decidedByLabel,
      at: decision.decidedAt,
      ...(decision.comment ? { comment: decision.comment } : {})
    },
    deps,
    { signal, runtime }
  );
}

/** Records what an approved call came to on its request. A request that moved on is left. */
export async function recordApprovedOperationCallEnd(
  options: Pick<ApprovedOperationCallExecutorOptions, "clientInstanceId" | "approvals">,
  requestId: string,
  end: ApprovedOperationEnd
): Promise<void> {
  try {
    await options.approvals.transitionApprovedApprovalRequest({
      clientInstanceId: options.clientInstanceId,
      requestId,
      resolve: (approved) => {
        if (end.execution === "held") {
          // The confirmation is decided; the call now waits for another person's approval,
          // which keeps the input in its own request.
          return Promise.resolve({
            status: "approved",
            decision: approved.decision,
            applyResult: {
              ...(end.run ? { runId: end.run.id } : {}),
              requestId,
              execution: "held",
              approvalRequestId: end.approvalRequestId
            },
            payload: minimizedOperationCallPayload(approved.payload)
          });
        }
        if (end.execution === "refused" || end.execution === "expired") {
          return Promise.resolve({
            ...endedOperationCallOutcome(approved, {
              execution: end.execution,
              ...("error" in end ? { error: end.error } : {})
            }),
            decision: approved.decision
          });
        }
        return Promise.resolve({
          status: "approved",
          decision: approved.decision,
          applyResult: {
            ...(end.run ? { runId: end.run.id } : {}),
            requestId,
            execution: end.execution,
            ...("error" in end
              ? { error: { code: end.error.code, message: end.error.message } }
              : {})
          },
          payload: minimizedOperationCallPayload(approved.payload)
        });
      }
    });
  } catch (error) {
    if (!(isAppError(error) && (error.code === "CONFLICT" || error.code === "NOT_FOUND"))) {
      throw error;
    }
  }
}

/**
 * The person who made the call, with the rights they have now. Nobody when that person is
 * gone or may not act: the call is then not executed.
 */
async function currentActor(
  options: Pick<OperationCallApprovalOptions, "clientInstanceId" | "users">,
  run: OperationRun,
  payload: OperationCallPayload
): Promise<AuthenticatedUser | undefined> {
  const { clientInstanceId } = options;
  const { externalUserId, authSource, principal } = payload.actor;
  if (
    run.actor.kind !== "user" ||
    run.actor.id !== payload.actor.id ||
    externalUserId === undefined ||
    authSource === undefined
  ) {
    return undefined;
  }
  const user = await options.users.getUser({ clientInstanceId, userId: asUserId(run.actor.id) });
  if (!user || user.status !== "active") {
    return undefined;
  }
  return {
    id: user.id,
    externalUserId,
    displayLabel: user.displayLabel,
    email: user.email,
    roles: user.roles,
    permissionRefs: user.permissionRefs,
    permissions: user.permissions,
    clientInstanceId: user.clientInstanceId,
    authSource,
    ...(payload.actor.subjectUserId ? { subjectUserId: payload.actor.subjectUserId } : {}),
    ...(principal ? { principal: { ...principal, clientInstanceId } } : {}),
    ...(run.actor.delegatedActor ? { delegatedActor: run.actor.delegatedActor } : {}),
    ...(payload.actor.scopes ? { scopes: payload.actor.scopes } : {})
  };
}

export interface OperationApprovalFilerOptions {
  clientInstanceId: ClientInstanceId;
  creator: ApprovalRequestCreator;
  /** Where the request a newer one replaces is ended. */
  approvals: HeldOperationCallEnderOptions["approvals"];
  /** The kinds of held call, by which a newer request tells the one it replaces. */
  held: readonly HeldCallApprovalKind[];
}

/**
 * Files the approval request of a call that waits, with the frozen call as its payload. A
 * call of an agent is filed for its conversation and only while its run holds its lease. A
 * service principal's own call cannot be held: no person stands behind it to act for.
 */
export function createOperationApprovalFiler(
  options: OperationApprovalFilerOptions
): OperationApprovalRequests {
  return {
    async request({
      run,
      call,
      heldInput,
      resource,
      runtime,
      expiresAt,
      policySource,
      approval,
      confirmation
    }) {
      const { actor, origin } = call;
      if (isAuthenticatedServicePrincipal(actor)) {
        return undefined;
      }
      // A confirmation is the person's own, in their Inbox: always an `operation_call`, and
      // about the subject of the approval it would otherwise be, where its operation names one.
      const kind = confirmation
        ? OPERATION_CALL_APPROVAL_KIND
        : (approval?.kind ?? OPERATION_CALL_APPROVAL_KIND);
      const held = options.held.find((entry) => entry.kind === kind);
      if (held && approval?.subject) {
        // The newer request about the same thing replaces the one that still waits. The call
        // that files it keeps waiting: it moves on from its confirmation to this request.
        await endHeldOperationCalls(
          options,
          { kinds: [kind], subjectContains: held.subjectKey(approval.subject) },
          {
            denial: { kind: "policy", operation: run.operation, reason: "approval_stale" },
            message: "A newer request about the same replaced this one."
          },
          run.id
        );
      }
      const input = unknownToJsonValue(call.input);
      if (Buffer.byteLength(JSON.stringify(input)) > HELD_OPERATION_INPUT_MAX_BYTES) {
        throw new AppError(
          "VALIDATION_FAILED",
          `This call needs an approval and its input is too large to be held for one. The limit is ${HELD_OPERATION_INPUT_MAX_BYTES / 1024} KiB.`,
          { reason: "input_too_large_to_hold", limit: "HELD_OPERATION_INPUT_MAX_BYTES" }
        );
      }
      const heldBy = payloadSchema.shape.heldBy.unwrap().safeParse(policySource);
      const payload: OperationCallPayload = {
        runId: run.id,
        operation: run.operation,
        effect: run.effect,
        input,
        ...(heldInput ? { heldInput } : {}),
        ...(confirmation ? { mode: "confirmation" as const } : {}),
        ...(approval?.subject
          ? {
              subject: {
                ...approval.subject,
                ...(approval.kind === "app_publish"
                  ? {
                      audiencePersonName: actor.displayLabel,
                      publish_widens:
                        approval.subject.publish_widens === true ||
                        (approval.subject.audience === "self" &&
                          approval.subject.liveAudience === "self" &&
                          approval.subject.liveAudienceUserId !== (actor.subjectUserId ?? actor.id))
                    }
                  : {})
              }
            }
          : {}),
        ...(confirmation && approval?.subject ? { subjectKind: approval.kind } : {}),
        actor: {
          id: actor.id,
          label: actor.displayLabel,
          externalUserId: actor.externalUserId,
          authSource: actor.authSource,
          ...(actor.subjectUserId ? { subjectUserId: actor.subjectUserId } : {}),
          ...(actor.principal
            ? {
                principal: {
                  kind: actor.principal.kind,
                  id: actor.principal.id,
                  displayLabel: actor.principal.displayLabel,
                  authSource: actor.principal.authSource,
                  ...(actor.principal.externalUserId
                    ? { externalUserId: actor.principal.externalUserId }
                    : {})
                }
              }
            : {}),
          ...(actor.scopes ? { scopes: [...actor.scopes] } : {})
        },
        origin: {
          kind: origin.kind,
          ...(origin.kind === "agent"
            ? { agentName: origin.agentName, toolName: origin.toolName }
            : {})
        },
        ...(call.workspaceId ? { workspaceId: call.workspaceId } : {}),
        // A source that refuses the call, and never makes it wait, is named by no request.
        ...(heldBy.success ? { heldBy: heldBy.data } : {}),
        expiresAt
      };
      const request = await createWithinLimits(() =>
        options.creator.createRequest(
          actor,
          { correlationId: call.correlationId, runFence: runtime.runFence },
          {
            kind,
            // The name of the operation. The Inbox words the item in the reader's language.
            summary: resource?.title ?? run.operation,
            payload: toJsonObject(payload),
            // Only the person the call acts for sees and decides their confirmation.
            ...(confirmation ? { addresseeUserId: actor.id } : {}),
            // Counted and filed under one lock, so calls made at the same moment cannot
            // each pass a limit the others fill.
            pendingLimits: {
              perRequester: HELD_OPERATION_CALLS_PER_ACTOR,
              perKind: HELD_OPERATION_CALLS_PER_INSTANCE
            },
            origin:
              origin.kind === "agent"
                ? {
                    conversationId: origin.conversationId,
                    agentRunId: origin.agentRunId,
                    toolCallId: origin.toolCallId,
                    agentName: origin.agentName
                  }
                : undefined
          }
        )
      );
      return { approvalRequestId: request.id };
    }
  };
}

/** Words the refusal of a call that would be one more than a limit. */
async function createWithinLimits(create: () => Promise<ApprovalRequest>) {
  try {
    return await create();
  } catch (error) {
    if (!isAppError(error) || error.code !== "RATE_LIMITED") throw error;
    const limit = z.object({ limit: z.enum(["requester", "kind"]) }).safeParse(error.details);
    if (!limit.success) throw error;
    throw new AppError(
      "RATE_LIMITED",
      limit.data.limit === "requester"
        ? `${HELD_OPERATION_CALLS_PER_ACTOR} of your calls already wait for an approval. This one was not filed. Wait until some are decided.`
        : `${HELD_OPERATION_CALLS_PER_INSTANCE} calls already wait for an approval on this instance. This one was not filed.`
    );
  }
}
