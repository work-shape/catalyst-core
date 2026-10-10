import type { ApprovalRequestView, LocaleCode, Message } from "@vivd-catalyst/api-client";
import { approvalRevisionOwner, readApprovalDecisionMetadata } from "@vivd-catalyst/core";
import type { TranslationContextValue, TranslationKey } from "../i18n";

/** Display kind a tool result carries to render its Approval Request inline in the thread. */
export const APPROVAL_REQUEST_DISPLAY_KIND = "catalyst.approval_request";

export interface ApprovalRequestDisplayRef {
  requestId: string;
  kind?: string;
}

export function readApprovalRequestDisplay(
  display: { kind?: unknown; data?: unknown } | undefined
): ApprovalRequestDisplayRef | undefined {
  if (display?.kind !== APPROVAL_REQUEST_DISPLAY_KIND || !isRecord(display.data)) {
    return undefined;
  }
  const requestId = display.data.requestId;
  if (typeof requestId !== "string" || !requestId.trim()) {
    return undefined;
  }
  return {
    requestId,
    ...(typeof display.data.kind === "string" ? { kind: display.data.kind } : {})
  };
}

export type ApprovalStatusTone = "pending" | "positive" | "negative" | "neutral";

interface ApprovalStatusPresentation {
  labelKey: TranslationKey;
  tone: ApprovalStatusTone;
}

/**
 * Keyed by plain string: `reverted` arrives with rollback and is not part of
 * the contract's status enum yet, and a status this build does not know must
 * still render.
 */
const STATUS_PRESENTATION: Record<string, ApprovalStatusPresentation> = {
  pending: { labelKey: "approvalStatusPending", tone: "pending" },
  approved: { labelKey: "approvalStatusApproved", tone: "positive" },
  rejected: { labelKey: "approvalStatusRejected", tone: "negative" },
  changes_requested: { labelKey: "approvalStatusChangesRequested", tone: "neutral" },
  superseded: { labelKey: "approvalDecisionSuperseded", tone: "neutral" },
  withdrawn: { labelKey: "approvalStatusWithdrawn", tone: "neutral" },
  reverted: { labelKey: "approvalStatusReverted", tone: "neutral" }
};

export function approvalStatusPresentation(status: string): ApprovalStatusPresentation {
  return STATUS_PRESENTATION[status] ?? { labelKey: "approvalStatusUnknown", tone: "neutral" };
}

/** Passed checks stay silent; only warnings and blocks reach the card. */
export function visibleApprovalChecks(
  checks: ApprovalRequestView["checks"]
): ApprovalRequestView["checks"] {
  return checks.filter((check) => check.status !== "passed");
}

/**
 * Withdrawing is the requester's way out while they wait for someone else. A
 * requester who may decide rejects instead: next to "reject" a second button
 * with the same effect only raises the question of how the two differ. The
 * server still accepts either from them.
 */
export function offersApprovalWithdraw(
  request: Pick<ApprovalRequestView, "canDecide" | "canWithdraw">
): boolean {
  return request.canWithdraw && !request.canDecide;
}

/** A decision on a request, as its origin conversation stores it in the history. */
export interface ApprovalDecisionEvent {
  requestId: string;
  status: ApprovalDecisionStatus;
  decidedByLabel: string;
  decidedAt: string;
  summary: string;
  comment?: string;
  /** Changes were requested by someone other than the requester, who now revises it. */
  revisedByReviewer?: true;
}

export type ApprovalDecisionStatus = Exclude<ApprovalRequestView["status"], "pending">;

export function readApprovalDecisionEvent(
  message: Pick<Message, "metadata" | "role">
): ApprovalDecisionEvent | undefined {
  const decision =
    message.role === "system" ? readApprovalDecisionMetadata(message.metadata) : undefined;
  if (!decision) {
    return undefined;
  }
  const comment = decision.comment?.trim();
  return {
    requestId: decision.requestId,
    status: decision.status,
    decidedByLabel: decision.decidedByLabel,
    decidedAt: decision.decidedAt,
    summary: decision.summary,
    ...(comment ? { comment } : {}),
    ...(approvalRevisionOwner(decision) === "reviewer" ? { revisedByReviewer: true as const } : {})
  };
}

/**
 * Wording of the status line in the thread. Withdrawing and superseding are
 * not somebody's verdict on the proposal, so those lines name no one.
 */
const DECISION_LINE_LABEL_KEY: Record<ApprovalDecisionStatus, TranslationKey> = {
  approved: "approvalDecisionApproved",
  rejected: "approvalDecisionRejected",
  changes_requested: "approvalDecisionChangesRequested",
  superseded: "approvalDecisionSuperseded",
  withdrawn: "approvalDecisionWithdrawn",
  reverted: "approvalDecisionReverted"
};

export function approvalDecisionLineLabelKey(
  decision: Pick<ApprovalDecisionEvent, "status" | "revisedByReviewer">
): TranslationKey {
  return decision.revisedByReviewer
    ? "approvalDecisionChangesRequestedByReviewer"
    : DECISION_LINE_LABEL_KEY[decision.status];
}

/**
 * Where a proposal is revised once changes are requested. The reviser always
 * holds the approval permission, because only they can request changes:
 *
 * - `open_conversation`: the reviewer sits in the conversation the request came
 *   from, so the agent there revises it.
 * - `origin_conversation`: the reviewer decides on their own request from
 *   somewhere else and is taken back to where it came from.
 * - `new_conversation`: someone else's request. The reviewer has no access to
 *   that conversation and revises in one of their own.
 */
export type ApprovalRevisionPlan =
  | { kind: "open_conversation" }
  | { kind: "origin_conversation"; conversationId: string }
  | { kind: "new_conversation" };

export function approvalRevisionPlan(input: {
  originConversationId: string | undefined;
  /** The conversation on screen; the review queue has none. */
  openConversationId: string | undefined;
  requestedById: string;
  currentUserId: string | undefined;
}): ApprovalRevisionPlan {
  const { originConversationId } = input;
  if (originConversationId !== undefined && originConversationId === input.openConversationId) {
    return { kind: "open_conversation" };
  }
  if (
    originConversationId !== undefined &&
    input.currentUserId !== undefined &&
    input.currentUserId === input.requestedById
  ) {
    return { kind: "origin_conversation", conversationId: originConversationId };
  }
  return { kind: "new_conversation" };
}

const REVISION_HINT_KEY: Record<ApprovalRevisionPlan["kind"], TranslationKey> = {
  open_conversation: "approvalRevisionHintOpenConversation",
  origin_conversation: "approvalRevisionHintOriginConversation",
  new_conversation: "approvalRevisionHintNewConversation"
};

export function approvalRevisionHintKey(plan: ApprovalRevisionPlan): TranslationKey {
  return REVISION_HINT_KEY[plan.kind];
}

/**
 * Whether a stored decision is followed by a user message that makes the
 * agent revise right away. Only for "request changes" decided on the card
 * inside the thread the request came from, and only while that thread accepts
 * a message. The review queue never has an open conversation to pass.
 *
 * A run start takes the conversation's draft attachments with it and clears
 * the composer, so anything the user has prepared there holds the follow-up
 * back; their own next message then lets the agent revise.
 */
export function shouldSendApprovalFollowUp(input: {
  decision: "approve" | "reject" | "request_changes";
  originConversationId: string | undefined;
  openConversationId: string | undefined;
  canSendMessage: boolean;
  composerDraftText: string;
  draftAttachmentCount: number;
}): boolean {
  return (
    input.decision === "request_changes" &&
    input.originConversationId !== undefined &&
    input.originConversationId === input.openConversationId &&
    input.canSendMessage &&
    input.composerDraftText.trim().length === 0 &&
    input.draftAttachmentCount === 0
  );
}

export function formatApprovalDate(value: string, locale: LocaleCode): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The sentence for a failed action. A decision refused because the request was already decided
 * names who decided; a request that left the queue another way (withdrawn) has no such person.
 */
export function approvalActionFailureText(
  failure: "failed" | "revert_conflict" | "already_decided",
  request: Pick<ApprovalRequestView, "decision">,
  t: TranslationContextValue["t"]
): string {
  if (failure === "revert_conflict") {
    return t("approvalRevertConflict");
  }
  if (failure === "already_decided") {
    return request.decision
      ? t("approvalAlreadyDecidedBy", { name: request.decision.decidedByLabel })
      : t("approvalNoLongerOpen");
  }
  return t("approvalActionFailed");
}
