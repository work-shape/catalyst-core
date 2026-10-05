import type { ApprovalRequestView, LocaleCode, Message } from "@vivd-catalyst/api-client";
import { readApprovalDecisionMetadata } from "@vivd-catalyst/core";
import type { TranslationKey } from "../i18n";

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
  superseded: { labelKey: "approvalStatusSuperseded", tone: "neutral" },
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

/** History is everything that is no longer waiting, most recently touched first. */
export function decidedApprovalRequests(requests: ApprovalRequestView[]): ApprovalRequestView[] {
  return requests
    .filter((request) => request.status !== "pending")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * `canRevert` lands on the view together with the rollback endpoint. Until the
 * contract carries it, the field is simply absent and rollback stays hidden.
 */
export function canRevertApprovalRequest(request: object): boolean {
  return "canRevert" in request && request.canRevert === true;
}

export interface ApprovalReversion {
  revertedByLabel: string;
  revertedAt: string;
}

/** Who rolled an accepted change back; read like `canRevert`, for the same reason. */
export function readApprovalReversion(request: object): ApprovalReversion | undefined {
  const reversion = "reversion" in request ? request.reversion : undefined;
  return isRecord(reversion) &&
    typeof reversion.revertedByLabel === "string" &&
    typeof reversion.revertedAt === "string"
    ? { revertedByLabel: reversion.revertedByLabel, revertedAt: reversion.revertedAt }
    : undefined;
}

/** A decision on a request, as its origin conversation stores it in the history. */
export interface ApprovalDecisionEvent {
  requestId: string;
  status: ApprovalDecisionStatus;
  decidedByLabel: string;
  decidedAt: string;
  summary: string;
  comment?: string;
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
    ...(comment ? { comment } : {})
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

export function approvalDecisionLineLabelKey(status: ApprovalDecisionStatus): TranslationKey {
  return DECISION_LINE_LABEL_KEY[status];
}

/**
 * Whether a stored decision is followed by a user message that makes the
 * agent revise right away. Only for "request changes" decided on the card
 * inside the thread the request came from, and only while that thread accepts
 * a message. The review queue never has an open conversation to pass.
 */
export function shouldSendApprovalFollowUp(input: {
  decision: "approve" | "reject" | "request_changes";
  originConversationId: string | undefined;
  openConversationId: string | undefined;
  canSendMessage: boolean;
}): boolean {
  return (
    input.decision === "request_changes" &&
    input.originConversationId !== undefined &&
    input.originConversationId === input.openConversationId &&
    input.canSendMessage
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
