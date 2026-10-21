import { Badge } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import type { WorkflowRunView } from "./workflow-views";

/**
 * The marker of a test run: "Test run", and of one a click in an App's draft started, the App
 * it came from (DP-1). Nothing on any other run.
 */
export function TestRunBadge({ run }: { run: Pick<WorkflowRunView, "test" | "fromApp"> }) {
  const { t } = useTranslation();
  if (!run.test) return null;
  return (
    <Badge tone="info" size="sm" data-test-run="" data-from-app={run.fromApp}>
      {run.fromApp === undefined
        ? t("workflows.run.testBadge")
        : t("workflows.run.testFromApp", { app: run.fromApp })}
    </Badge>
  );
}
