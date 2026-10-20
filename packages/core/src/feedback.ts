import type { ClientInstanceId } from "./ids";
import { createPlatformId } from "./ids";
import type { StorePage } from "./paging";
import type { ISODateString } from "./time";
import type { FeedbackState, FeedbackSubjectKind } from "@work-shape/catalyst-asset-schemas";

// Feedback (LU-4): a written comment a person leaves under an agent's answer, for the people
// who build that agent. No thumbs and no rating: the comment is the feedback. It is a record of
// its own, kept for its own retention, and reaches its reviewers as an Inbox item of kind
// `feedback_review` that references it. Spec: limits-usage-analytics-and-feedback.md, 3.5.

/** The Inbox item kind of a comment that waits for its reviewer. */
export const FEEDBACK_REVIEW_KIND = "feedback_review";

/** The right of who reads feedback and marks it handled. */
export const FEEDBACK_REVIEW_ACTION = "feedback.review";

export {
  FEEDBACK_CATEGORY_MAX_LENGTH,
  FEEDBACK_NOTE_MAX_LENGTH,
  FEEDBACK_STATES,
  FEEDBACK_SUBJECT_KINDS,
  FEEDBACK_SUMMARY_MAX_LENGTH,
  FEEDBACK_TEXT_MAX_LENGTH,
  type FeedbackState,
  type FeedbackSubjectKind
} from "@work-shape/catalyst-asset-schemas";

export type FeedbackId = string;

export function createFeedbackId(): FeedbackId {
  return createPlatformId("fb");
}

/**
 * The question and the one answer a comment is about, copied when the author left the box
 * ticked. Nothing else of the conversation: no files, no earlier turns, no tool results.
 */
export interface FeedbackExchange {
  question: string;
  answer: string;
}

export interface FeedbackRecord {
  id: FeedbackId;
  clientInstanceId: ClientInstanceId;
  subjectKind: FeedbackSubjectKind;
  /** The agent message. Empty once its conversation is deleted. */
  messageId?: string;
  /** The agent that wrote the answer, and its live revision when the comment was sent. */
  agentName: string;
  agentAssetId?: string;
  agentRevision?: number;
  /** The workspace that owns the agent; empty for an agent of the instance. */
  agentWorkspaceId?: string;
  /** References. They may point at something retention has deleted. */
  conversationId?: string;
  agentRunId?: string;
  /** The workspace the conversation was in. */
  workspaceId?: string;
  authorUserId: string;
  /** The author's name as their record says it now. */
  authorDisplayLabel?: string;
  text: string;
  exchange?: FeedbackExchange;
  /** Written by a workflow, never by a person; the text above stays as the author wrote it. */
  annotation?: { summary: string; category?: string; annotatedAt: ISODateString };
  state: FeedbackState;
  handled?: { byUserId: string; byLabel: string; at: ISODateString; note?: string };
  /** The `feedback_review` item that brings it to its reviewers. */
  approvalRequestId?: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface CreateFeedbackInput {
  id: FeedbackId;
  clientInstanceId: ClientInstanceId;
  subjectKind: FeedbackSubjectKind;
  messageId: string;
  agentName: string;
  agentAssetId?: string;
  agentRevision?: number;
  agentWorkspaceId?: string;
  conversationId: string;
  agentRunId: string;
  workspaceId: string;
  authorUserId: string;
  text: string;
  exchange?: FeedbackExchange;
}

/** A comment as retention and account deletion remove it: with its Inbox item. */
export interface FeedbackRemoval {
  id: FeedbackId;
  approvalRequestId?: string;
}

export interface FeedbackStore {
  /** Refused with `CONFLICT` when the author already commented on the message. */
  createFeedback(input: CreateFeedbackInput): Promise<FeedbackRecord>;
  getFeedback(input: {
    clientInstanceId: ClientInstanceId;
    id: FeedbackId;
  }): Promise<FeedbackRecord | undefined>;
  /** The author's own comments in one conversation, for the state under each message. */
  listOwnFeedback(input: {
    clientInstanceId: ClientInstanceId;
    authorUserId: string;
    conversationId: string;
  }): Promise<FeedbackRecord[]>;
  /**
   * Newest first. `agentAssetIds` narrows to the comments on these agents; left out, every
   * comment of the instance.
   */
  listFeedback(input: {
    clientInstanceId: ClientInstanceId;
    agentAssetIds?: readonly string[];
    agentName?: string;
    state?: FeedbackState;
    page?: StorePage;
  }): Promise<FeedbackRecord[]>;
  /** Changes a comment that is still `new`. Nothing when it is handled or gone. */
  updateFeedback(input: {
    clientInstanceId: ClientInstanceId;
    id: FeedbackId;
    text: string;
    exchange: FeedbackExchange | null;
  }): Promise<FeedbackRecord | undefined>;
  setFeedbackApprovalRequest(input: {
    clientInstanceId: ClientInstanceId;
    id: FeedbackId;
    approvalRequestId: string;
  }): Promise<void>;
  /** Marks a `new` comment handled. Nothing when it is handled already or gone. */
  markFeedbackHandled(input: {
    clientInstanceId: ClientInstanceId;
    id: FeedbackId;
    byUserId: string;
    byLabel: string;
    note?: string;
  }): Promise<FeedbackRecord | undefined>;
  annotateFeedback(input: {
    clientInstanceId: ClientInstanceId;
    id: FeedbackId;
    summary: string;
    category?: string;
  }): Promise<FeedbackRecord | undefined>;
  deleteFeedback(input: { clientInstanceId: ClientInstanceId; id: FeedbackId }): Promise<boolean>;
  /** Comments created before `before`, oldest first. */
  listExpiredFeedback(input: {
    clientInstanceId: ClientInstanceId;
    before: Date;
    limit: number;
  }): Promise<FeedbackRemoval[]>;
  listFeedbackOfAuthor(input: {
    clientInstanceId: ClientInstanceId;
    authorUserId: string;
    limit: number;
  }): Promise<FeedbackRemoval[]>;
}
