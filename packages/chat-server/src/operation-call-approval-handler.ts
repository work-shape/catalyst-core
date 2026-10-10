import { z } from "zod";
import {
  AppError,
  asUserId,
  isAuthenticatedServicePrincipal,
  isJsonObject,
  unknownToJsonValue,
  type ApprovalRequestCreator,
  type ApprovalRequestHandler,
  type ApprovalRequestStore,
  type AuthenticatedUser,
  type ClientInstanceId,
  type JsonObject,
  type JsonValue,
  type OperationRun,
  type UserStore
} from "@vivd-catalyst/core";
import {
  OPERATION_CALL_APPROVAL_KIND,
  declineWaitingOperation,
  endWaitingOperationIfStale,
  executeApprovedOperation,
  wasTakenForExecution,
  type OperationApprovalRequests,
  type RunOperationDeps,
  type WaitingOperationCall
} from "@vivd-catalyst/tool-execution";

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

/** How many input fields a preview shows, and how much of each value. The call holds all. */
const PREVIEW_INPUT_MAX_FIELDS = 50;
const PREVIEW_VALUE_MAX_CHARS = 2000;

const principalSchema = z.object({
  kind: z.enum(["user", "service"]),
  id: z.string(),
  displayLabel: z.string(),
  authSource: z.string(),
  externalUserId: z.string().optional()
});

/**
 * The frozen call. The run keeps what the call is and who made it; the request keeps what the
 * run must not: the input, and how the person was signed in when they made the call.
 */
const payloadSchema = z.object({
  runId: z.string().min(1),
  operation: z.string().min(1),
  effect: z.enum(["reading", "changing"]),
  input: z.unknown(),
  actor: z.object({
    id: z.string().min(1),
    label: z.string(),
    externalUserId: z.string(),
    authSource: z.string(),
    subjectUserId: z.string().optional(),
    principal: principalSchema.optional(),
    scopes: z.array(z.string()).optional()
  }),
  origin: z.object({
    kind: z.enum(["agent", "user", "cli", "mcp", "app", "workflow", "schedule"]),
    agentName: z.string().optional(),
    toolName: z.string().optional()
  }),
  workspaceId: z.string().optional(),
  expiresAt: z.string()
});

type OperationCallPayload = z.infer<typeof payloadSchema>;

export interface OperationCallApprovalOptions {
  clientInstanceId: ClientInstanceId;
  /** The call path the frozen call is executed on. Read when a request is decided. */
  deps(): RunOperationDeps;
  users: Pick<UserStore, "getUser">;
}

/**
 * The approval kind of a call that waits for another person: `operation_call`. Approving
 * executes the frozen call once, as the person who made it and with the approver recorded as
 * who decided. Whoever holds `operations.approve` decides, the caller included.
 */
export function createOperationCallApprovalHandler(
  options: OperationCallApprovalOptions
): ApprovalRequestHandler {
  const { clientInstanceId } = options;
  const runOf = (runId: string) => options.deps().runs.get({ clientInstanceId, id: runId });

  /** The frozen call with its actor as that person is now. */
  async function waitingCall(
    payload: OperationCallPayload
  ): Promise<{ run: OperationRun; waiting: WaitingOperationCall } | undefined> {
    const run = await runOf(payload.runId);
    if (!run) {
      return undefined;
    }
    return {
      run,
      waiting: {
        runId: run.id,
        call: {
          operation: run.operation,
          effect: run.effect,
          input: payload.input,
          actor: await currentActor(run, payload),
          origin: run.origin,
          workspaceId: run.workspaceId,
          idempotencyKey: run.idempotencyKey,
          correlationId: run.correlationId
        }
      }
    };
  }

  /**
   * The person who made the call, with the rights they have now. Nobody when that person is
   * gone or may not act: the call is then stale.
   */
  async function currentActor(
    run: OperationRun,
    payload: OperationCallPayload
  ): Promise<AuthenticatedUser | undefined> {
    if (run.actor.kind !== "user" || run.actor.id !== payload.actor.id) {
      return undefined;
    }
    const user = await options.users.getUser({ clientInstanceId, userId: asUserId(run.actor.id) });
    if (!user || user.status !== "active") {
      return undefined;
    }
    const { principal } = payload.actor;
    return {
      id: user.id,
      externalUserId: payload.actor.externalUserId,
      displayLabel: user.displayLabel,
      email: user.email,
      roles: user.roles,
      permissionRefs: user.permissionRefs,
      permissions: user.permissions,
      clientInstanceId: user.clientInstanceId,
      authSource: payload.actor.authSource,
      ...(payload.actor.subjectUserId ? { subjectUserId: payload.actor.subjectUserId } : {}),
      ...(principal ? { principal: { ...principal, clientInstanceId } } : {}),
      ...(run.actor.delegatedActor ? { delegatedActor: run.actor.delegatedActor } : {}),
      ...(payload.actor.scopes ? { scopes: payload.actor.scopes } : {})
    };
  }

  return {
    kind: OPERATION_CALL_APPROVAL_KIND,
    requiredPermission: "operations.approve",
    validate(payload) {
      return toJsonObject(parsePayload(payload));
    },
    preview(payload) {
      return Promise.resolve(toJsonObject(previewOf(parsePayload(payload))));
    },
    async isStale(payload) {
      const found = await waitingCall(parsePayload(payload));
      // A call whose run is gone was deleted with its conversation or its retention.
      return found ? endWaitingOperationIfStale(found.waiting, options.deps()) : true;
    },
    async isApplied(payload) {
      const parsed = payloadSchema.pick({ runId: true }).safeParse(payload);
      return parsed.success ? wasTakenForExecution(await runOf(parsed.data.runId)) : false;
    },
    async apply(payload, approver, context) {
      const found = await waitingCall(parsePayload(payload));
      if (!found) {
        throw new AppError("CONFLICT", "The call of this request no longer exists");
      }
      const outcome = await executeApprovedOperation(
        found.waiting,
        { id: approver.id, label: approver.displayLabel },
        options.deps()
      );
      // The approval is recorded whatever the call came to: it was decided and it ran. How
      // it ended is on its run, which the request names.
      const { result } = outcome;
      return {
        runId: outcome.run.id,
        status: result.status,
        requestId: context.requestId,
        ...(result.status === "failed" ? { error: { code: result.error.code } } : {})
      };
    },
    async declined(payload, decision) {
      const parsed = payloadSchema.pick({ runId: true }).safeParse(payload);
      if (!parsed.success) return;
      const run = await runOf(parsed.data.runId);
      // A run that is gone, or that expired meanwhile, has nothing left to end.
      if (!run || run.status === "expired") return;
      await declineWaitingOperation(
        run.id,
        { id: decision.decidedBy, label: decision.decidedByLabel, comment: decision.comment },
        options.deps()
      );
    }
  };
}

function parsePayload(payload: JsonObject): OperationCallPayload {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", "Invalid operation call payload", {
      issues: parsed.error.issues
    });
  }
  return parsed.data;
}

function toJsonObject(value: unknown): JsonObject {
  const json = unknownToJsonValue(value);
  if (!isJsonObject(json)) {
    throw new AppError("INTERNAL", "An operation call is not a JSON object");
  }
  return json;
}

/** What a person who decides is shown: the call, who made it and its input, field by field. */
function previewOf(payload: OperationCallPayload) {
  return {
    runId: payload.runId,
    operation: payload.operation,
    effect: payload.effect,
    actor: { kind: "user", id: payload.actor.id, label: payload.actor.label },
    origin: payload.origin,
    ...(payload.workspaceId ? { workspaceId: payload.workspaceId } : {}),
    inputs: inputRows(unknownToJsonValue(payload.input)),
    expiresAt: payload.expiresAt
  };
}

function inputRows(input: JsonValue): { key: string; value: string; truncated?: true }[] {
  const fields: [string, JsonValue][] = isJsonObject(input)
    ? Object.entries(input).flatMap(([key, value]): [string, JsonValue][] =>
        value === undefined ? [] : [[key, value]]
      )
    : [["input", input]];
  return fields.slice(0, PREVIEW_INPUT_MAX_FIELDS).map(([key, value]) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > PREVIEW_VALUE_MAX_CHARS
      ? { key, value: text.slice(0, PREVIEW_VALUE_MAX_CHARS), truncated: true }
      : { key, value: text };
  });
}

export interface OperationApprovalFilerOptions {
  clientInstanceId: ClientInstanceId;
  creator: ApprovalRequestCreator;
  store: Pick<ApprovalRequestStore, "countPendingApprovalRequests" | "countOwnApprovalRequests">;
}

/**
 * Files the approval request of a call that waits, with the frozen call as its payload. A
 * call of an agent is filed for its conversation and only while its run holds its lease. A
 * service principal's own call cannot be held: no person stands behind it to act for.
 */
export function createOperationApprovalFiler(
  options: OperationApprovalFilerOptions
): OperationApprovalRequests {
  const kinds = [OPERATION_CALL_APPROVAL_KIND];
  return {
    async request({ run, call, runtime, expiresAt }) {
      const { actor, origin } = call;
      if (isAuthenticatedServicePrincipal(actor)) {
        return undefined;
      }
      const input = unknownToJsonValue(call.input);
      if (Buffer.byteLength(JSON.stringify(input)) > HELD_OPERATION_INPUT_MAX_BYTES) {
        throw new AppError(
          "VALIDATION_FAILED",
          `This call needs an approval and its input is too large to be held for one. The limit is ${HELD_OPERATION_INPUT_MAX_BYTES / 1024} KiB.`
        );
      }
      const [own, open] = await Promise.all([
        options.store.countOwnApprovalRequests({
          clientInstanceId: options.clientInstanceId,
          kinds,
          requestedById: actor.id
        }),
        options.store.countPendingApprovalRequests({
          clientInstanceId: options.clientInstanceId,
          kinds
        })
      ]);
      if (own.pending >= HELD_OPERATION_CALLS_PER_ACTOR) {
        throw new AppError(
          "RATE_LIMITED",
          `${HELD_OPERATION_CALLS_PER_ACTOR} of your calls already wait for an approval. This one was not filed. Wait until some are decided.`
        );
      }
      if (open >= HELD_OPERATION_CALLS_PER_INSTANCE) {
        throw new AppError(
          "RATE_LIMITED",
          `${HELD_OPERATION_CALLS_PER_INSTANCE} calls already wait for an approval on this instance. This one was not filed.`
        );
      }
      const payload: OperationCallPayload = {
        runId: run.id,
        operation: run.operation,
        effect: run.effect,
        input,
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
        expiresAt
      };
      const request = await options.creator.createRequest(
        actor,
        { correlationId: call.correlationId, runFence: runtime.runFence },
        {
          kind: OPERATION_CALL_APPROVAL_KIND,
          // The name of the operation. The Inbox words the item in the reader's language.
          summary: run.operation,
          payload: toJsonObject(payload),
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
      );
      return { approvalRequestId: request.id };
    }
  };
}
