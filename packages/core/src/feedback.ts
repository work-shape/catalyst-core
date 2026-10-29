import type { ClientInstanceId } from "./ids";
import { createPlatformId } from "./ids";
import type { StorePage } from "./paging";
import type { ISODateString } from "./time";
import type { FeedbackState, FeedbackSubjectKind } from "@work-shape/catalyst-asset-schemas";

// Feedback (LU-4, LU-6): a written comment a person leaves under an agent's answer, in an App,
// or under a Workflow result in their Inbox, for the people who build that asset. No thumbs and
// no rating: the comment is the feedback. It is a record of its own, kept for its own
// retention, and reaches its reviewers as an Inbox item of kind `feedback_review` that
// references it. Spec: limits-usage-analytics-and-feedback.md, 3.5.

/** The Inbox item kind of a comment that waits for its reviewer. */
export const FEEDBACK_REVIEW_KIND = "feedback_review";

/** The right of who reads feedback and marks it handled. */
export const FEEDBACK_REVIEW_ACTION = "feedback.review";

import type { FeedbackAssetKind } from "@work-shape/catalyst-asset-schemas";

export {
  FEEDBACK_ASSET_KINDS,
  FEEDBACK_CATEGORY_MAX_LENGTH,
  FEEDBACK_NOTE_MAX_LENGTH,
  FEEDBACK_STATES,
  FEEDBACK_SUBJECT_KINDS,
  FEEDBACK_SUMMARY_MAX_LENGTH,
  FEEDBACK_TEXT_MAX_LENGTH,
  type FeedbackAssetKind,
  type FeedbackState,
  type FeedbackSubjectKind
} from "@work-shape/catalyst-asset-schemas";

export type FeedbackId = string;

export function createFeedbackId(): FeedbackId {
  return createPlatformId("fb");
}

/** The kind of asset a comment of each subject is about. */
export const FEEDBACK_ASSET_KIND_OF = {
  message: "agent",
  app: "app",
  workflow_run: "workflow"
} as const satisfies Record<FeedbackSubjectKind, FeedbackAssetKind>;

/**
 * The asset a comment is about, as its builders know it: the agent that wrote an answer, the
 * App a person used, or the Workflow whose run reached a person's Inbox. Its reviewers hold
 * `feedback.review` on the instance or on the workspace that owns it.
 */
export interface FeedbackAsset {
  kind: FeedbackAssetKind;
  name: string;
  /** Empty once the asset is deleted. */
  id?: string;
  /** Its revision when the comment was sent: the live one, or the one the run ran on. */
  revision?: number;
  /** The workspace that owns it; empty for an asset of the instance. */
  workspaceId?: string;
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
  /** The agent, the App or the Workflow the comment is about. */
  asset: FeedbackAsset;
  /** The agent message. Empty once its conversation is deleted. */
  messageId?: string;
  /** References. They may point at something retention has deleted. */
  conversationId?: string;
  agentRunId?: string;
  /** The Workflow run whose result the comment is about. */
  workflowRunId?: string;
  /** The workspace the conversation, the App or the run was in. */
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
  asset: FeedbackAsset;
  messageId?: string;
  conversationId?: string;
  agentRunId?: string;
  workflowRunId?: string;
  workspaceId?: string;
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
  /** Refused with `CONFLICT` when the author already commented on the message or the run. */
  createFeedback(input: CreateFeedbackInput): Promise<FeedbackRecord>;
  getFeedback(input: {
    clientInstanceId: ClientInstanceId;
    id: FeedbackId;
  }): Promise<FeedbackRecord | undefined>;
  /**
   * The author's own comments in one conversation, for the state under each message, or on
   * one Workflow run, for the state under its result.
   */
  listOwnFeedback(
    input: { clientInstanceId: ClientInstanceId; authorUserId: string } & (
      { conversationId: string } | { workflowRunId: string }
    )
  ): Promise<FeedbackRecord[]>;
  /**
   * Newest first. `assetIds` narrows to the comments on these agents, Apps and Workflows; left
   * out, every comment of the instance. `agentName` keeps the comments on one agent's answers.
   */
  listFeedback(input: {
    clientInstanceId: ClientInstanceId;
    assetIds?: readonly string[];
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
