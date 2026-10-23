import {
  AppError,
  isAppError,
  isAuthenticatedServicePrincipal,
  servicePrincipalAsRunUser,
  unknownToJsonValue,
  type ApprovalRequest,
  type ApprovalRequestCreator,
  type Authorizer,
  type ClientInstanceId
} from "@work-shape/catalyst-core";
import {
  OPERATION_CALL_APPROVAL_KIND,
  type OperationApprovalRequests
} from "@work-shape/catalyst-tool-execution";
import { z } from "zod";
import {
  HELD_ASSET_OPERATION,
  heldAssetRequestedNew,
  heldAssetRequestedRevision,
  type HeldAssetPreviewer
} from "./held-asset-preview";
import {
  endHeldOperationCalls,
  type HeldOperationCallEnderOptions
} from "./operation-call-approval-handler";
import type { HeldCallApprovalKind } from "./held-call-kind";
import { payloadSchema, toJsonObject, type OperationCallPayload } from "./operation-call-payload";

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

export interface OperationApprovalFilerOptions {
  clientInstanceId: ClientInstanceId;
  creator: ApprovalRequestCreator;
  /** Where the request a newer one replaces is ended. */
  approvals: HeldOperationCallEnderOptions["approvals"];
  /** The kinds of held call, by which a newer request tells the one it replaces. */
  held: readonly HeldCallApprovalKind[];
  assetPreview?: HeldAssetPreviewer;
  authorizer?: Authorizer;
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
      const { actor: identity, origin } = call;
      if (isAuthenticatedServicePrincipal(identity) && (!runtime.workflowAgent || confirmation))
        return undefined;
      const actor = isAuthenticatedServicePrincipal(identity)
        ? servicePrincipalAsRunUser(identity)
        : identity;
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
        ...(runtime.modelRoutes
          ? { modelRoutes: runtime.modelRoutes.map(({ id, region }) => ({ id, region })) }
          : {}),
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
      if (call.operation === HELD_ASSET_OPERATION && options.assetPreview && options.authorizer) {
        const asset = await options.assetPreview(input, {
          access: await options.authorizer.forActor(actor),
          inList: false
        });
        if (asset)
          payload.asset = toJsonObject({
            ...asset,
            requestedNew: heldAssetRequestedNew(input),
            requestedRevision: heldAssetRequestedRevision(input)
          });
      }
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
