import type {
  FeedbackView,
  OwnFeedback,
  SendFeedbackRequest,
  UpdateFeedbackRequest
} from "@work-shape/catalyst-api-contract";
import {
  AppError,
  FEEDBACK_REVIEW_ACTION,
  FEEDBACK_REVIEW_KIND,
  GRANT_SCOPE_KINDS,
  asAgentRunId,
  asConversationId,
  auditActorFromUser,
  createFeedbackId,
  getSubjectUserId,
  isAppError,
  isAuthenticatedServicePrincipal,
  readAssistantFinalMetadata,
  type ActorAccess,
  type AuthenticatedIdentity,
  type AuthenticatedUser,
  type FeedbackExchange,
  type FeedbackRecord,
  type FeedbackState,
  type OperationAuthorization,
  type StorePage
} from "@work-shape/catalyst-core";
import { ApprovalRequestWorkflow } from "../approvals/approval-request-service";
import {
  requireChatConversationAccess,
  requireConversationAccess
} from "../conversations/conversation-access";
import type { ChatServerOptions } from "../types";
import {
  feedbackAgentResource,
  feedbackEventIds,
  feedbackReviewPayload,
  removeFeedback
} from "./feedback-review-kind";

type FeedbackOptions = Pick<
  ChatServerOptions,
  "clientInstanceId" | "stores" | "config" | "auditRecorder" | "approvalRequests"
>;

interface CallContext {
  actor: AuthenticatedIdentity;
  access: ActorAccess;
  correlationId: string;
}

/** The scopes of a grant narrower than the instance. */
const NARROWER_SCOPES = GRANT_SCOPE_KINDS.filter((scope) => scope !== "instance");

/** A comment as its author reads it: its state, and nothing of its reviewer's note. */
function ownFeedbackView(record: FeedbackRecord): OwnFeedback {
  return {
    id: record.id,
    ...(record.messageId ? { messageId: record.messageId } : {}),
    ...(record.agentRunId ? { agentRunId: record.agentRunId } : {}),
    text: record.text,
    includesExchange: record.exchange !== undefined,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

/** A comment as its reviewer reads it. */
function feedbackView(record: FeedbackRecord): FeedbackView {
  return {
    id: record.id,
    subjectKind: record.subjectKind,
    ...(record.messageId ? { messageId: record.messageId } : {}),
    agent: {
      name: record.agentName,
      ...(record.agentAssetId ? { assetId: record.agentAssetId } : {}),
      ...(record.agentRevision === undefined ? {} : { revision: record.agentRevision }),
      ...(record.agentWorkspaceId ? { workspaceId: record.agentWorkspaceId } : {})
    },
    ...(record.conversationId ? { conversationId: record.conversationId } : {}),
    ...(record.agentRunId ? { agentRunId: record.agentRunId } : {}),
    ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
    author: {
      id: record.authorUserId,
      ...(record.authorDisplayLabel ? { displayLabel: record.authorDisplayLabel } : {})
    },
    text: record.text,
    ...(record.exchange ? { exchange: record.exchange } : {}),
    ...(record.annotation ? { annotation: { ...record.annotation, machineWritten: true } } : {}),
    state: record.state,
    ...(record.handled
      ? {
          handled: {
            byLabel: record.handled.byLabel,
            at: record.handled.at,
            ...(record.handled.note ? { note: record.handled.note } : {})
          }
        }
      : {}),
    ...(record.approvalRequestId ? { approvalRequestId: record.approvalRequestId } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

/** Only a person writes a comment of their own. */
export function authorizeAuthor(
  _input: unknown,
  { actor }: { actor: AuthenticatedIdentity }
): OperationAuthorization {
  return isAuthenticatedServicePrincipal(actor)
    ? {
        allowed: false,
        action: FEEDBACK_REVIEW_ACTION,
        reason: "no_grant",
        message: "Only a person leaves feedback on an answer"
      }
    : { allowed: true };
}

/**
 * A reviewer's call: the caller holds `feedback.review` somewhere. Which comments it reaches
 * is decided on each comment's agent; one it does not cover reads as one that does not exist.
 */
export function authorizeReviewer(
  _input: unknown,
  { access }: { access: ActorAccess }
): OperationAuthorization {
  return access.authorize(FEEDBACK_REVIEW_ACTION).allowed ||
    access.holdsGrantAt(FEEDBACK_REVIEW_ACTION, NARROWER_SCOPES)
    ? { allowed: true }
    : { allowed: false, action: FEEDBACK_REVIEW_ACTION, reason: "no_grant" };
}

function personOf(actor: AuthenticatedIdentity): AuthenticatedUser {
  if (isAuthenticatedServicePrincipal(actor)) {
    throw new AppError("FORBIDDEN", "Only a person leaves feedback on an answer");
  }
  return actor;
}

function feedbackNotFound(): AppError {
  return new AppError("NOT_FOUND", "Feedback was not found");
}

/**
 * Written feedback on agent answers (LU-4): its author sends, changes and withdraws a comment;
 * its reviewers read it and mark it handled, and a workflow stores a summary on it. Every
 * comment reaches its reviewers as an Inbox item of kind `feedback_review`.
 */
export class FeedbackWorkflow {
  constructor(private readonly options: FeedbackOptions) {}

  private get clientInstanceId() {
    return this.options.clientInstanceId;
  }

  async listOwn(context: CallContext, conversationId: string): Promise<{ items: OwnFeedback[] }> {
    const user = personOf(context.actor);
    await requireConversationAccess(this.options, asConversationId(conversationId), user);
    const records = await this.options.stores.feedback.listOwnFeedback({
      clientInstanceId: this.clientInstanceId,
      authorUserId: getSubjectUserId(user),
      conversationId
    });
    return { items: records.map(ownFeedbackView) };
  }

  async send(
    context: CallContext,
    conversationId: string,
    input: SendFeedbackRequest
  ): Promise<OwnFeedback> {
    const user = personOf(context.actor);
    const conversation = await requireChatConversationAccess(
      this.options,
      asConversationId(conversationId),
      user
    );
    const { stores } = this.options;
    const run = await stores.agentRuns.getConversationAgentRun({
      clientInstanceId: this.clientInstanceId,
      conversationId: conversation.id,
      runId: asAgentRunId(input.runId)
    });
    if (!run || run.parentRunId !== undefined) {
      throw new AppError("NOT_FOUND", "The answer was not found");
    }
    if (run.status !== "completed") {
      throw new AppError("CONFLICT", "Feedback is left on a finished answer", {
        reason: "answer_not_finished"
      });
    }
    const messages = await stores.conversations.listMessages({
      clientInstanceId: this.clientInstanceId,
      conversationId: conversation.id
    });
    const answer = messages.find(
      (message) =>
        message.role === "assistant" &&
        readAssistantFinalMetadata(message.metadata)?.runId === run.id
    );
    if (!answer) throw new AppError("NOT_FOUND", "The answer was not found");
    const question = messages.find((message) => message.id === run.inputMessageId);
    const agent = await stores.configAssets.getConfigAsset({
      clientInstanceId: this.clientInstanceId,
      kind: "agent",
      name: run.agentName
    });
    const exchange = this.exchangeOf(input.includeExchange, question?.text, answer.text);
    const record = await stores.feedback.createFeedback({
      id: createFeedbackId(),
      clientInstanceId: this.clientInstanceId,
      subjectKind: "message",
      messageId: answer.id,
      agentName: run.agentName,
      ...(agent && agent.status === "active"
        ? {
            agentAssetId: agent.id,
            agentRevision: agent.revision,
            ...(agent.scope.kind === "workspace"
              ? { agentWorkspaceId: agent.scope.workspaceId }
              : {})
          }
        : {}),
      conversationId: conversation.id,
      agentRunId: run.id,
      workspaceId: conversation.collaborationWorkspaceId,
      authorUserId: getSubjectUserId(user),
      text: input.text,
      ...(exchange ? { exchange } : {})
    });
    let requestId: string;
    try {
      // The item names the agent, never the comment: its summary is read by every reviewer.
      const request = await stores.approvals.createApprovalRequest({
        clientInstanceId: this.clientInstanceId,
        kind: FEEDBACK_REVIEW_KIND,
        summary: `Feedback on the agent '${run.agentName}'`,
        payload: feedbackReviewPayload(record),
        requestedBy: { id: user.id, displayLabel: user.displayLabel }
      });
      requestId = request.id;
      await stores.feedback.setFeedbackApprovalRequest({
        clientInstanceId: this.clientInstanceId,
        id: record.id,
        approvalRequestId: requestId
      });
    } catch (error) {
      // A comment no reviewer can find is no comment: it goes with the item that failed.
      await stores.feedback.deleteFeedback({
        clientInstanceId: this.clientInstanceId,
        id: record.id
      });
      throw error;
    }
    await this.options.auditRecorder.record({
      type: "feedback.received",
      status: "success",
      actor: auditActorFromUser(user),
      subject: record.id,
      correlationId: context.correlationId,
      metadata: feedbackEventIds(record)
    });
    return ownFeedbackView({ ...record, approvalRequestId: requestId });
  }

  async update(
    context: CallContext,
    conversationId: string,
    feedbackId: string,
    input: UpdateFeedbackRequest
  ): Promise<OwnFeedback> {
    const { record } = await this.ownRecord(context, conversationId, feedbackId);
    if (record.state !== "new") throw handledAlready();
    let exchange: FeedbackExchange | null = null;
    if (input.includeExchange) {
      // A copy once made is kept as it was; one left out is made from the conversation now.
      exchange = record.exchange ?? (await this.copyExchange(record));
    }
    const updated = await this.options.stores.feedback.updateFeedback({
      clientInstanceId: this.clientInstanceId,
      id: record.id,
      text: input.text,
      exchange
    });
    if (!updated) throw handledAlready();
    return ownFeedbackView(updated);
  }

  async withdraw(
    context: CallContext,
    conversationId: string,
    feedbackId: string
  ): Promise<{ withdrawn: true }> {
    const { user, record } = await this.ownRecord(context, conversationId, feedbackId);
    if (record.state !== "new") throw handledAlready();
    await removeFeedback(
      { clientInstanceId: this.clientInstanceId, stores: this.options.stores },
      [
        {
          id: record.id,
          ...(record.approvalRequestId ? { approvalRequestId: record.approvalRequestId } : {})
        }
      ],
      {
        status: "withdrawn",
        reason: "withdrawn_by_author",
        by: { id: user.id, label: user.displayLabel }
      }
    );
    return { withdrawn: true };
  }

  /** The comments on the agents the caller reviews, newest first. */
  async list(
    context: CallContext,
    query: { agent?: string; state?: FeedbackState },
    page: StorePage | undefined
  ): Promise<FeedbackView[]> {
    const reach = await this.reviewReach(context.access);
    if (reach.agentAssetIds?.length === 0) return [];
    const records = await this.options.stores.feedback.listFeedback({
      clientInstanceId: this.clientInstanceId,
      ...(reach.agentAssetIds ? { agentAssetIds: reach.agentAssetIds } : {}),
      ...(query.agent ? { agentName: query.agent } : {}),
      ...(query.state ? { state: query.state } : {}),
      ...(page ? { page } : {})
    });
    return records.map(feedbackView);
  }

  async get(context: CallContext, feedbackId: string): Promise<FeedbackView> {
    return feedbackView(await this.reviewedRecord(context.access, feedbackId));
  }

  /**
   * Marks a comment handled. Its Inbox item is decided with it, so the comment, the item and
   * the audit say the same whichever of the two a reviewer used.
   */
  async markHandled(
    context: CallContext,
    feedbackId: string,
    note: string | undefined
  ): Promise<FeedbackView> {
    const user = personOf(context.actor);
    const record = await this.reviewedRecord(context.access, feedbackId);
    if (record.state !== "new") throw handledAlready();
    const approvals = this.options.approvalRequests;
    const trimmed = note?.trim();
    if (record.approvalRequestId && approvals?.handlers.has(FEEDBACK_REVIEW_KIND)) {
      const workflow = new ApprovalRequestWorkflow({
        ...approvals,
        clientInstanceId: this.clientInstanceId,
        auditRecorder: this.options.auditRecorder
      });
      try {
        await workflow.decideRequest(
          user,
          context.access,
          { correlationId: context.correlationId },
          {
            requestId: record.approvalRequestId,
            decision: "approve",
            ...(trimmed ? { comment: trimmed } : {})
          }
        );
      } catch (error) {
        // An item that is no longer pending leaves the comment to be marked here.
        if (!isAppError(error) || error.code !== "CONFLICT") throw error;
      }
    }
    const current = await this.options.stores.feedback.getFeedback({
      clientInstanceId: this.clientInstanceId,
      id: record.id
    });
    if (!current) throw feedbackNotFound();
    if (current.state === "handled") return feedbackView(current);
    const handled = await this.options.stores.feedback.markFeedbackHandled({
      clientInstanceId: this.clientInstanceId,
      id: record.id,
      byUserId: user.id,
      byLabel: user.displayLabel,
      ...(trimmed ? { note: trimmed } : {})
    });
    if (!handled) throw handledAlready();
    await this.options.auditRecorder.record({
      type: "feedback.handled",
      status: "success",
      actor: auditActorFromUser(user),
      subject: handled.id,
      correlationId: context.correlationId,
      metadata: feedbackEventIds(handled)
    });
    return feedbackView(handled);
  }

  /** A workflow's summary and category, beside the comment, which stays as it was written. */
  async annotate(
    context: CallContext,
    feedbackId: string,
    input: { summary: string; category?: string }
  ): Promise<FeedbackView> {
    const record = await this.reviewedRecord(context.access, feedbackId);
    const annotated = await this.options.stores.feedback.annotateFeedback({
      clientInstanceId: this.clientInstanceId,
      id: record.id,
      summary: input.summary,
      ...(input.category ? { category: input.category } : {})
    });
    if (!annotated) throw feedbackNotFound();
    return feedbackView(annotated);
  }

  /**
   * The agents whose comments the caller reads. All of them where the right on the instance
   * holds and no deny lies on one; otherwise the agents it is decided on one by one.
   */
  private async reviewReach(access: ActorAccess): Promise<{ agentAssetIds?: string[] }> {
    if (
      access.authorize(FEEDBACK_REVIEW_ACTION).allowed &&
      access.denials(FEEDBACK_REVIEW_ACTION).length === 0
    ) {
      return {};
    }
    const agents = await this.options.stores.configAssets.listActiveConfigAssets({
      clientInstanceId: this.clientInstanceId,
      kind: "agent"
    });
    return {
      agentAssetIds: agents
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
        .map((agent) => agent.id)
    };
  }

  private async reviewedRecord(access: ActorAccess, feedbackId: string): Promise<FeedbackRecord> {
    const record = await this.options.stores.feedback.getFeedback({
      clientInstanceId: this.clientInstanceId,
      id: feedbackId
    });
    if (
      !record ||
      !access.authorize(FEEDBACK_REVIEW_ACTION, feedbackAgentResource(record)).allowed
    ) {
      throw feedbackNotFound();
    }
    return record;
  }

  private async ownRecord(
    context: CallContext,
    conversationId: string,
    feedbackId: string
  ): Promise<{ user: AuthenticatedUser; record: FeedbackRecord }> {
    const user = personOf(context.actor);
    await requireConversationAccess(this.options, asConversationId(conversationId), user);
    const record = await this.options.stores.feedback.getFeedback({
      clientInstanceId: this.clientInstanceId,
      id: feedbackId
    });
    if (
      !record ||
      record.authorUserId !== getSubjectUserId(user) ||
      record.conversationId !== conversationId
    ) {
      throw feedbackNotFound();
    }
    return { user, record };
  }

  /** The copy of the exchange, where the author asked for it and the instance allows it. */
  private exchangeOf(
    include: boolean,
    question: string | undefined,
    answer: string
  ): FeedbackExchange | undefined {
    if (!include || !this.options.config.feedback.exchangeSnapshot) return undefined;
    return { question: question ?? "", answer };
  }

  private async copyExchange(record: FeedbackRecord): Promise<FeedbackExchange | null> {
    if (!this.options.config.feedback.exchangeSnapshot) return null;
    if (!record.conversationId || !record.agentRunId || !record.messageId) return null;
    const { stores } = this.options;
    const run = await stores.agentRuns.getAgentRun({
      clientInstanceId: this.clientInstanceId,
      runId: asAgentRunId(record.agentRunId)
    });
    const messages = await stores.conversations.listMessages({
      clientInstanceId: this.clientInstanceId,
      conversationId: asConversationId(record.conversationId)
    });
    const answer = messages.find((message) => message.id === record.messageId);
    if (!answer) return null;
    const question = run
      ? messages.find((message) => message.id === run.inputMessageId)
      : undefined;
    return { question: question?.text ?? "", answer: answer.text };
  }
}

function handledAlready(): AppError {
  return new AppError("CONFLICT", "The feedback was handled already", {
    reason: "feedback_handled"
  });
}
