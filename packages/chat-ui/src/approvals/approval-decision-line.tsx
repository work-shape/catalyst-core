import { CheckCircle2, CircleSlash, PencilLine, RotateCcw, Undo2, XCircle } from "lucide-react";
import type { ComponentType } from "react";
import { useTranslation } from "../i18n";
import { cn } from "../ui/cn";
import {
  approvalDecisionLineLabelKey,
  formatApprovalDate,
  type ApprovalDecisionEvent,
  type ApprovalDecisionStatus
} from "./approval-request-model";

const DECISION_ICON: Record<
  ApprovalDecisionStatus,
  ComponentType<{ size?: number; className?: string; "aria-hidden"?: "true" }>
> = {
  approved: CheckCircle2,
  rejected: XCircle,
  changes_requested: PencilLine,
  superseded: CircleSlash,
  withdrawn: Undo2,
  reverted: RotateCcw
};

const DECISION_ICON_CLASS: Partial<Record<ApprovalDecisionStatus, string>> = {
  approved: "text-success",
  rejected: "text-destructive"
};

/**
 * The outcome of an Approval Request at its place in the conversation. Kept to
 * one quiet line: the card above it carries the proposal, this only records
 * what became of it and when.
 */
export function ApprovalDecisionLine({
  decision,
  showSummary
}: {
  decision: ApprovalDecisionEvent;
  /** Only where several proposals share the thread and the line alone would not say which. */
  showSummary: boolean;
}) {
  const { locale, t } = useTranslation();
  const Icon = DECISION_ICON[decision.status];
  const summary = showSummary ? decision.summary.trim() : "";

  return (
    <div
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs leading-5 text-muted-foreground"
      data-testid="approval-decision-line"
      data-status={decision.status}
    >
      <Icon
        size={14}
        className={cn("mt-[3px] shrink-0", DECISION_ICON_CLASS[decision.status])}
        aria-hidden="true"
      />
      <p className="min-w-0">
        <span className="font-medium text-foreground">
          {t(approvalDecisionLineLabelKey(decision.status), { name: decision.decidedByLabel })}
        </span>
        <span aria-hidden="true"> · </span>
        <time dateTime={decision.decidedAt}>{formatApprovalDate(decision.decidedAt, locale)}</time>
        {summary ? (
          <>
            <span aria-hidden="true"> · </span>
            <span>{summary}</span>
          </>
        ) : null}
      </p>
      {decision.comment ? (
        <p className="col-start-2 min-w-0 whitespace-pre-wrap break-words">{decision.comment}</p>
      ) : null}
    </div>
  );
}
