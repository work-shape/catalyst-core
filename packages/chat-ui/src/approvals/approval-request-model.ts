import type { ApprovalRequestView } from "@vivd-catalyst/api-client";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
