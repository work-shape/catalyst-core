import { Badge, type BadgeProps } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import { approvalStatusPresentation, type ApprovalStatusTone } from "./approval-request-model";

const BADGE_LOOK = {
  pending: {},
  positive: { tone: "success" },
  negative: { tone: "danger", appearance: "outline" },
  neutral: { appearance: "outline" }
} satisfies Record<ApprovalStatusTone, Pick<BadgeProps, "tone" | "appearance">>;

/** The state of a request as a badge, the same in the conversation and in the Inbox. */
export function ApprovalStatusBadge({
  status,
  size
}: {
  status: string;
  size?: BadgeProps["size"];
}) {
  const { t } = useTranslation();
  const presentation = approvalStatusPresentation(status);
  return (
    <Badge {...BADGE_LOOK[presentation.tone]} size={size} data-status={status}>
      {t(presentation.labelKey)}
    </Badge>
  );
}
