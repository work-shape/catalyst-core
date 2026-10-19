import { Badge, Button, type BadgeProps } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import {
  approvalStatusPresentation,
  readApprovalExecution,
  type ApprovalStatusTone
} from "./approval-request-model";

const BADGE_LOOK = {
  pending: {},
  positive: { tone: "success" },
  negative: { tone: "danger", appearance: "outline" },
  neutral: { appearance: "outline" }
} satisfies Record<ApprovalStatusTone, Pick<BadgeProps, "tone" | "appearance">>;

/** The state of a request as a badge, the same in the conversation and in the Inbox. */
export function ApprovalStatusBadge({
  status,
  applyResult,
  size,
  confirmation,
  notice
}: {
  status: string;
  /** What the request recorded. A change that ran after the decision says here how it went. */
  applyResult?: unknown;
  size?: BadgeProps["size"];
  /** The request is a person's own confirmation in their Inbox: it is allowed or denied. */
  confirmation?: boolean;
  /** A notice is handled without approving an action. */
  notice?: boolean;
}) {
  const { t } = useTranslation();
  const execution = readApprovalExecution(applyResult);
  const presentation =
    notice && status === "approved"
      ? { tone: "neutral" as const, labelKey: "inbox.noticeDone" as const }
      : approvalStatusPresentation(status, execution, confirmation);
  return (
    <Badge
      {...BADGE_LOOK[presentation.tone]}
      size={size}
      data-status={status}
      data-execution={execution}
    >
      {t(presentation.labelKey)}
    </Badge>
  );
}

/** Beside the badge of a change that still ran when the page stopped asking for its state. */
export function ApprovalRefreshButton({ onRefresh }: { onRefresh(): void }) {
  const { t } = useTranslation();
  return (
    <Button size="sm" variant="ghost" onClick={onRefresh} data-testid="approval-refresh">
      {t("approvalRefresh")}
    </Button>
  );
}
