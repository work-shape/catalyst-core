import { Badge, type BadgeProps } from "@work-shape/catalyst-ui";
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
  size
}: {
  status: string;
  /** What the request recorded. A change that ran after the decision says here how it went. */
  applyResult?: unknown;
  size?: BadgeProps["size"];
}) {
  const { t } = useTranslation();
  const execution = readApprovalExecution(applyResult);
  const presentation = approvalStatusPresentation(status, execution);
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
