import { FlaskConical } from "lucide-react";
import { Banner } from "@work-shape/catalyst-ui";
import { useApprovalRevisionHost } from "../../chat/approvals/approval-revision-host";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import type { WorkspaceRoute } from "../../shared/workspace-route";
import { RouteLink } from "../route-link";
import type { FrameTestRun } from "./frame-calls";
import { usePageHost } from "./page-host";

// A call of an App's draft started a test run of a Workflow (DP-1). Its result in the frame is
// partly not real, so the host says so above the frame, which revision ran, how many steps were
// simulated, and leads to the run. The published App starts no test run and shows no strip.

/** A test run of the frame session it was started from. */
export interface FrameTestRunShown {
  session: string;
  run: FrameTestRun;
}

/**
 * The line that says which revision of the Workflow ran: its draft or its published one. The
 * frame names no revision number, as nothing of an App's preview does (OPEN-1f); the run's
 * page has it.
 */
export function frameTestRunTitle(run: Pick<FrameTestRun, "workflowRevision">): TranslationKey {
  return run.workflowRevision?.kind === "published"
    ? "pages.testRunPublished"
    : "pages.testRunDraft";
}

/** Above the frame while the last call of the draft was a test run of a Workflow. */
export function FrameTestRun({ run, onClose }: { run: FrameTestRun; onClose(): void }) {
  const host = usePageHost();
  const approvals = useApprovalRevisionHost();
  const workspaceId = host?.workspace?.id;
  const route: WorkspaceRoute | undefined =
    workspaceId === undefined
      ? undefined
      : {
          kind: "workflow-run",
          collaborationWorkspaceId: workspaceId,
          workflow: run.workflow,
          run: run.id
        };
  return (
    <FrameTestRunView
      run={run}
      route={route}
      onOpen={(to) => approvals?.openRoute?.(to)}
      onClose={onClose}
    />
  );
}

export function FrameTestRunView({
  run,
  route,
  onOpen,
  onClose
}: {
  run: Pick<FrameTestRun, "id" | "workflowRevision" | "simulatedSteps">;
  /** The run's page, where the frame stands in a workspace. */
  route: WorkspaceRoute | undefined;
  onOpen(route: WorkspaceRoute): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const simulated = run.simulatedSteps?.length ?? 0;
  return (
    <Banner
      tone="info"
      layout="page"
      icon={<FlaskConical aria-hidden="true" />}
      data-testid="frame-test-run"
      data-run={run.id}
      title={t(frameTestRunTitle(run))}
      action={
        route === undefined ? undefined : (
          <RouteLink route={route} variant="link" onOpen={onOpen}>
            {t("pages.testRunView")}
          </RouteLink>
        )
      }
      onDismiss={onClose}
    >
      {simulated === 0
        ? undefined
        : simulated === 1
          ? t("pages.testRunSimulatedOne")
          : t("pages.testRunSimulated", { count: simulated })}
    </Banner>
  );
}
