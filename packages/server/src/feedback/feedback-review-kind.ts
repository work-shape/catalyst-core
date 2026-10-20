import {
  AppError,
  auditActorFromUser,
  FEEDBACK_REVIEW_ACTION,
  FEEDBACK_REVIEW_KIND,
  isAppError,
  type AccessResource,
  type ApprovalRequestHandler,
  type ApprovalRequestStore,
  type ApprovalStaleness,
  type AuditActor,
  type AuditRecorder,
  type ClientInstanceId,
  type ConfigAssetStore,
  type FeedbackRecord,
  type FeedbackRemoval,
  type FeedbackStore,
  type JsonObject
} from "@work-shape/catalyst-core";
import { z } from "zod";

// The Inbox item of a comment on an agent's answer (LU-4). Whoever holds `feedback.review` on
// the agent, on the instance or on the workspace that owns it, sees it among the items to
// decide; its one answer is "mark handled", with an optional note. The item holds the
// comment's id and the agent, never the comment: the preview reads the comment itself, so a
// comment the author changed or withdrew reads as it is now. The author never sees the item.

/** What the item holds: the comment by its id, and the agent it is about. */
const payloadSchema = z.object({
  feedbackId: z.string().min(1),
  /** What the item is about, as a reviewer with the right on some agents only finds it. */
  subject: z
    .object({ agentAssetId: z.string().min(1) })
    .strict()
    .optional(),
  agentName: z.string().min(1),
  agentWorkspaceId: z.string().min(1).optional()
});

export type FeedbackReviewPayload = z.infer<typeof payloadSchema>;

export interface FeedbackReviewDeps {
  clientInstanceId: ClientInstanceId;
  stores: {
    feedback: FeedbackStore;
    approvals: ApprovalRequestStore;
    configAssets: Pick<ConfigAssetStore, "listActiveConfigAssets" | "getConfigAsset">;
  };
  auditRecorder: AuditRecorder;
}

/** The agent a comment is about, as the right to review it is asked on it. */
export function feedbackAgentResource(input: {
  agentName: string;
  agentAssetId?: string;
  agentWorkspaceId?: string;
}): AccessResource {
  return {
    kind: "agent",
    name: input.agentName,
    ...(input.agentAssetId ? { assetId: input.agentAssetId } : {}),
    ...(input.agentWorkspaceId ? { workspaceId: input.agentWorkspaceId } : {})
  };
}

export function feedbackReviewPayload(record: FeedbackRecord): FeedbackReviewPayload {
  return {
    feedbackId: record.id,
    ...(record.agentAssetId ? { subject: { agentAssetId: record.agentAssetId } } : {}),
    agentName: record.agentName,
    ...(record.agentWorkspaceId ? { agentWorkspaceId: record.agentWorkspaceId } : {})
  };
}

/** The ids the events of a comment carry: never its text or the exchange. */
export function feedbackEventIds(record: FeedbackRecord): JsonObject {
  return {
    feedbackId: record.id,
    agentName: record.agentName,
    ...(record.agentAssetId ? { agentAssetId: record.agentAssetId } : {}),
    ...(record.workspaceId ? { workspaceId: record.workspaceId } : {})
  };
}

/** The comment as its reviewer reads it in the Inbox. */
function feedbackReviewPreview(
  record: FeedbackRecord,
  inList: boolean,
  agentDisplayName?: string
): JsonObject {
  return {
    feedbackId: record.id,
    agent: {
      name: record.agentName,
      ...(agentDisplayName ? { displayName: agentDisplayName } : {}),
      ...(record.agentAssetId ? { assetId: record.agentAssetId } : {}),
      ...(record.agentRevision === undefined ? {} : { revision: record.agentRevision }),
      ...(record.agentWorkspaceId ? { workspaceId: record.agentWorkspaceId } : {})
    },
    author: {
      id: record.authorUserId,
      ...(record.authorDisplayLabel ? { displayLabel: record.authorDisplayLabel } : {})
    },
    text: record.text,
    state: record.state,
    createdAt: record.createdAt,
    ...(record.conversationId ? { conversationId: record.conversationId } : {}),
    ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
    ...(record.annotation
      ? {
          annotation: {
            summary: record.annotation.summary,
            ...(record.annotation.category ? { category: record.annotation.category } : {}),
            machineWritten: true
          }
        }
      : {}),
    // A row of a list shows the comment; the exchange is read when the item is opened.
    ...(!inList && record.exchange
      ? { exchange: { question: record.exchange.question, answer: record.exchange.answer } }
      : {}),
    ...(record.handled
      ? {
          handled: {
            byLabel: record.handled.byLabel,
            at: record.handled.at,
            ...(record.handled.note ? { note: record.handled.note } : {})
          }
        }
      : {})
  };
}

export function createFeedbackReviewHandler(
  deps: FeedbackReviewDeps
): ApprovalRequestHandler<FeedbackReviewPayload> {
  const read = (feedbackId: string) =>
    deps.stores.feedback.getFeedback({ clientInstanceId: deps.clientInstanceId, id: feedbackId });
  return {
    kind: FEEDBACK_REVIEW_KIND,
    hiddenFromRequester: true,
    requiredPermission: FEEDBACK_REVIEW_ACTION,
    resourceOf: (payload) =>
      feedbackAgentResource({
        agentName: payload.agentName,
        ...(payload.subject ? { agentAssetId: payload.subject.agentAssetId } : {}),
        ...(payload.agentWorkspaceId ? { agentWorkspaceId: payload.agentWorkspaceId } : {})
      }),
    async reviewableSubjects(access) {
      const agents = await deps.stores.configAssets.listActiveConfigAssets({
        clientInstanceId: deps.clientInstanceId,
        kind: "agent"
      });
      return agents
        .filter(
          (agent) =>
            access.authorize(
              FEEDBACK_REVIEW_ACTION,
              feedbackAgentResource({
                agentName: agent.name,
                agentAssetId: agent.id,
                ...(agent.scope.kind === "workspace"
                  ? { agentWorkspaceId: agent.scope.workspaceId }
                  : {})
              })
            ).allowed
        )
        .map((agent) => ({ agentAssetId: agent.id }));
    },
    validate: (payload) => payloadSchema.parse(payload),
    async preview(payload, context) {
      const record = await read(payload.feedbackId);
      if (!record) {
        return { feedbackId: payload.feedbackId, agent: { name: payload.agentName }, gone: true };
      }
      const agent = await deps.stores.configAssets.getConfigAsset({
        clientInstanceId: deps.clientInstanceId,
        kind: "agent",
        name: record.agentName
      });
      const displayName = agent?.config?.displayName;
      return feedbackReviewPreview(
        record,
        context.viewer?.inList ?? false,
        typeof displayName === "string" ? displayName : undefined
      );
    },
    async isStale(payload, context): Promise<false | ApprovalStaleness> {
      const store = context.transaction?.feedback ?? deps.stores.feedback;
      const record = await store.getFeedback({
        clientInstanceId: deps.clientInstanceId,
        id: payload.feedbackId
      });
      // A comment withdrawn or removed meanwhile has nothing left to mark.
      if (!record) return { result: { gone: true }, undecided: true };
      if (record.state === "handled") return { result: { handled: true } };
      return false;
    },
    async apply(payload, approver, context) {
      const store = context.transaction?.feedback ?? deps.stores.feedback;
      const note = context.decision?.comment;
      const handled = await store.markFeedbackHandled({
        clientInstanceId: deps.clientInstanceId,
        id: payload.feedbackId,
        byUserId: approver.id,
        byLabel: approver.displayLabel,
        ...(note ? { note } : {})
      });
      if (!handled) throw new AppError("CONFLICT", "The feedback was handled or withdrawn");
      await recordHandled(deps, handled, auditActorFromUser(approver), context.correlationId);
      return { handled: true };
    },
    // Answered otherwise than "mark handled", the comment is handled as well: there is
    // nothing else a reviewer can do with it.
    async declined(payload, decision, context) {
      const parsed = payloadSchema.safeParse(payload);
      if (!parsed.success) return;
      const store = context.transaction?.feedback ?? deps.stores.feedback;
      const handled = await store.markFeedbackHandled({
        clientInstanceId: deps.clientInstanceId,
        id: parsed.data.feedbackId,
        byUserId: decision.decidedBy,
        byLabel: decision.decidedByLabel,
        ...(decision.comment ? { note: decision.comment } : {})
      });
      if (handled) {
        await recordHandled(
          deps,
          handled,
          { userId: decision.decidedBy, displayLabel: decision.decidedByLabel, roles: [] },
          context.correlationId
        );
      }
    }
  };
}

async function recordHandled(
  deps: Pick<FeedbackReviewDeps, "auditRecorder">,
  record: FeedbackRecord,
  actor: AuditActor,
  correlationId: string
): Promise<void> {
  await deps.auditRecorder.record({
    type: "feedback.handled",
    status: "success",
    actor,
    subject: record.id,
    correlationId,
    metadata: feedbackEventIds(record)
  });
}

/** How the Inbox item of a removed comment ends: withdrawn by its author, or by the platform. */
interface FeedbackReviewEnding {
  status: "withdrawn" | "superseded";
  reason: string;
  /** The author who withdrew it. Nobody decided an item the platform ended. */
  by?: { id: string; label: string };
}

/**
 * Ends the Inbox items of comments that are removed, then removes the comments: a withdrawal
 * by the author, the retention and an account deletion. An item no longer pending is left as
 * it is.
 */
export async function removeFeedback(
  deps: Pick<FeedbackReviewDeps, "clientInstanceId" | "stores">,
  removals: readonly FeedbackRemoval[],
  ending: FeedbackReviewEnding
): Promise<number> {
  let removed = 0;
  for (const removal of removals) {
    if (removal.approvalRequestId) {
      await endFeedbackReview(deps, removal.approvalRequestId, ending);
    }
    if (
      await deps.stores.feedback.deleteFeedback({
        clientInstanceId: deps.clientInstanceId,
        id: removal.id
      })
    ) {
      removed += 1;
    }
  }
  return removed;
}

async function endFeedbackReview(
  deps: Pick<FeedbackReviewDeps, "clientInstanceId" | "stores">,
  requestId: string,
  ending: FeedbackReviewEnding
): Promise<void> {
  try {
    await deps.stores.approvals.transitionPendingApprovalRequest({
      clientInstanceId: deps.clientInstanceId,
      requestId,
      resolve: async () => ({
        status: ending.status,
        applyResult: { gone: true, reason: ending.reason },
        ...(ending.by
          ? {
              decision: {
                approved: false,
                decidedBy: ending.by.id,
                decidedByLabel: ending.by.label,
                decidedAt: new Date().toISOString()
              }
            }
          : {})
      })
    });
  } catch (error) {
    // Decided meanwhile, or gone: the item says so already.
    if (isAppError(error) && (error.code === "CONFLICT" || error.code === "NOT_FOUND")) return;
    throw error;
  }
}
