import {
  AppError,
  FEEDBACK_ASSET_KINDS,
  auditActorFromUser,
  FEEDBACK_REVIEW_ACTION,
  FEEDBACK_REVIEW_KIND,
  isAppError,
  type AccessResource,
  type ActorAccess,
  type ApprovalRequestHandler,
  type ApprovalRequestStore,
  type ApprovalStaleness,
  type AuditActor,
  type AuditRecorder,
  type ClientInstanceId,
  type ConfigAssetRecord,
  type ConfigAssetStore,
  type FeedbackAsset,
  type FeedbackRecord,
  type FeedbackRemoval,
  type FeedbackStore,
  type JsonObject
} from "@work-shape/catalyst-core";
import { z } from "zod";

// The Inbox item of a comment on an agent's answer (LU-4), on an App or on a Workflow result
// (LU-6). Whoever holds `feedback.review` on what it is about, on the instance or on the
// workspace that owns it, sees it among the items to decide; its one answer is "mark handled",
// with an optional note. The item holds the comment's id and the asset, never the comment: the
// preview reads the comment itself, so a comment the author changed or withdrew reads as it is
// now. The author never sees the item.

/**
 * What the item holds: the comment by its id, and what it is about. An item of a comment on an
 * answer names the agent as LU-4 stored it; any other names its App or Workflow in `about`.
 */
const payloadSchema = z
  .object({
    feedbackId: z.string().min(1),
    /** What the item is about, as a reviewer with the right on some assets only finds it. */
    subject: z
      .union([
        z.object({ agentAssetId: z.string().min(1) }).strict(),
        z.object({ assetId: z.string().min(1) }).strict()
      ])
      .optional(),
    agentName: z.string().min(1).optional(),
    agentWorkspaceId: z.string().min(1).optional(),
    about: z
      .object({
        kind: z.enum(FEEDBACK_ASSET_KINDS).exclude(["agent"]),
        name: z.string().min(1),
        workspaceId: z.string().min(1).optional()
      })
      .strict()
      .optional()
  })
  .refine((payload) => (payload.agentName === undefined) !== (payload.about === undefined), {
    message: "A feedback item names an agent or another asset"
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

/** The asset a comment is about, as the right to review it is asked on it. */
export function feedbackAssetResource(
  asset: Pick<FeedbackAsset, "kind" | "name" | "id" | "workspaceId">
): AccessResource {
  return {
    kind: asset.kind,
    name: asset.name,
    ...(asset.id ? { assetId: asset.id } : {}),
    ...(asset.workspaceId ? { workspaceId: asset.workspaceId } : {})
  };
}

/** What a reviewer's list finds an item by: the agent as LU-4 stored it, or the asset. */
function reviewSubjectOf(asset: Pick<FeedbackAsset, "kind" | "id">): JsonObject | undefined {
  if (!asset.id) return undefined;
  return asset.kind === "agent" ? { agentAssetId: asset.id } : { assetId: asset.id };
}

export function feedbackReviewPayload(record: FeedbackRecord): FeedbackReviewPayload {
  const { asset } = record;
  const subject = reviewSubjectOf(asset);
  const payload = {
    feedbackId: record.id,
    ...(subject ? { subject } : {}),
    ...(asset.kind === "agent"
      ? {
          agentName: asset.name,
          ...(asset.workspaceId ? { agentWorkspaceId: asset.workspaceId } : {})
        }
      : {
          about: {
            kind: asset.kind,
            name: asset.name,
            ...(asset.workspaceId ? { workspaceId: asset.workspaceId } : {})
          }
        })
  };
  return payloadSchema.parse(payload);
}

/** The asset an item's payload is about. */
function payloadAsset(payload: FeedbackReviewPayload): Omit<FeedbackAsset, "revision"> {
  const subject = payload.subject;
  const id = subject ? ("agentAssetId" in subject ? subject.agentAssetId : subject.assetId) : "";
  if (payload.about) {
    return {
      kind: payload.about.kind,
      name: payload.about.name,
      ...(id ? { id } : {}),
      ...(payload.about.workspaceId ? { workspaceId: payload.about.workspaceId } : {})
    };
  }
  return {
    kind: "agent",
    name: payload.agentName ?? "",
    ...(id ? { id } : {}),
    ...(payload.agentWorkspaceId ? { workspaceId: payload.agentWorkspaceId } : {})
  };
}

/**
 * The agents, Apps and Workflows whose comments the holder reads one by one: those the right
 * covers, on the instance or on the workspace that owns each.
 */
export async function reviewedAssets(
  deps: {
    clientInstanceId: ClientInstanceId;
    stores: Pick<FeedbackReviewDeps["stores"], "configAssets">;
  },
  access: ActorAccess
): Promise<Omit<FeedbackAsset, "revision">[]> {
  const lists = await Promise.all(
    FEEDBACK_ASSET_KINDS.map((kind) =>
      deps.stores.configAssets.listActiveConfigAssets({
        clientInstanceId: deps.clientInstanceId,
        kind
      })
    )
  );
  return lists.flatMap((assets, index) =>
    assets.flatMap((record) => {
      const asset = {
        kind: FEEDBACK_ASSET_KINDS[index] ?? "agent",
        name: record.name,
        id: record.id,
        ...(record.scope.kind === "workspace" ? { workspaceId: record.scope.workspaceId } : {})
      };
      return access.authorize(FEEDBACK_REVIEW_ACTION, feedbackAssetResource(asset)).allowed
        ? [asset]
        : [];
    })
  );
}

/**
 * The name people read for an asset: an agent's display name, an App's title, a Workflow's
 * name from its definition.
 */
function displayNameOf(asset: ConfigAssetRecord): string | undefined {
  const config = asset.kind === "agent" ? asset.config : (asset.publishedConfig ?? asset.config);
  const manifest = config?.manifest;
  const value =
    asset.kind === "agent"
      ? config?.displayName
      : asset.kind === "workflow"
        ? typeof manifest === "object" && manifest !== null && !Array.isArray(manifest)
          ? manifest.name
          : undefined
        : config?.title;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** The ids the events of a comment carry: never its text or the exchange. */
export function feedbackEventIds(record: FeedbackRecord): JsonObject {
  const { asset } = record;
  return {
    feedbackId: record.id,
    subjectKind: record.subjectKind,
    ...(asset.kind === "agent"
      ? { agentName: asset.name, ...(asset.id ? { agentAssetId: asset.id } : {}) }
      : {
          ...(asset.kind === "app" ? { appName: asset.name } : { workflowName: asset.name }),
          ...(asset.id ? { assetId: asset.id } : {})
        }),
    ...(record.workflowRunId ? { workflowRunId: record.workflowRunId } : {}),
    ...(record.workspaceId ? { workspaceId: record.workspaceId } : {})
  };
}

/** The comment as its reviewer reads it in the Inbox. */
function feedbackReviewPreview(
  record: FeedbackRecord,
  inList: boolean,
  assetDisplayName?: string
): JsonObject {
  const { asset } = record;
  const about = {
    name: asset.name,
    ...(assetDisplayName ? { displayName: assetDisplayName } : {}),
    ...(asset.id ? { assetId: asset.id } : {}),
    ...(asset.revision === undefined ? {} : { revision: asset.revision }),
    ...(asset.workspaceId ? { workspaceId: asset.workspaceId } : {})
  };
  return {
    feedbackId: record.id,
    subjectKind: record.subjectKind,
    // The agent of an answer, where an interface of LU-4 reads it, and what it is about.
    ...(asset.kind === "agent" ? { agent: about } : {}),
    about: { kind: asset.kind, ...about },
    ...(record.workflowRunId ? { workflowRunId: record.workflowRunId } : {}),
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
    resourceOf: (payload) => feedbackAssetResource(payloadAsset(payload)),
    async reviewableSubjects(access) {
      const reviewed = await reviewedAssets(deps, access);
      return reviewed
        .map(reviewSubjectOf)
        .filter((subject): subject is JsonObject => subject !== undefined);
    },
    validate: (payload) => payloadSchema.parse(payload),
    async preview(payload, context) {
      const record = await read(payload.feedbackId);
      if (!record) {
        const asset = payloadAsset(payload);
        return {
          feedbackId: payload.feedbackId,
          ...(asset.kind === "agent" ? { agent: { name: asset.name } } : {}),
          about: { kind: asset.kind, name: asset.name },
          gone: true
        };
      }
      const asset = await deps.stores.configAssets.getConfigAsset({
        clientInstanceId: deps.clientInstanceId,
        kind: record.asset.kind,
        name: record.asset.name
      });
      return feedbackReviewPreview(
        record,
        context.viewer?.inList ?? false,
        asset ? displayNameOf(asset) : undefined
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
