import { ExternalLink } from "lucide-react";
import { IconButton } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import { openWorkspacePageInNewTab } from "../routes";
import { WorkflowCanvas } from "./workflow-canvas";
import { useWorkflow } from "./workflow-data";
import { WorkflowDraftBar, useWorkflowDraft } from "./workflow-draft";
import { LoadError } from "./workflows-frame";
import { useWorkflowsHost } from "./workflows-host";

/**
 * A Workflow on its canvas beside the conversation in which its agent changes it. The canvas
 * draws the draft as it is saved: each save of the agent drops the read, and the canvas is
 * drawn again from the new one. The bar of the draft stands over it, with the publish and the
 * discard for whoever may.
 */
export function WorkflowCanvasSurface({
  workspaceId,
  workflow
}: {
  workspaceId: string;
  workflow: string;
}) {
  const { t } = useTranslation();
  const host = useWorkflowsHost();
  const read = useWorkflow(workspaceId, workflow);
  const draft = useWorkflowDraft(workflow, read.workflow);
  if (host === undefined) {
    return (
      <p className="p-(--layout-gutter) text-body text-muted-foreground">
        {t("workflows.unavailable")}
      </p>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workflow-canvas-surface">
      {draft.bar === undefined ? null : <WorkflowDraftBar {...draft.bar} />}
      <div className="relative min-h-0 flex-1">
        {read.problem === "failed" ? (
          <div className="p-(--layout-gutter)">
            <LoadError onRetry={read.retry}>{t("workflows.failed")}</LoadError>
          </div>
        ) : read.problem ? (
          <p className="p-(--layout-gutter) text-body text-muted-foreground">
            {t(read.problem === "missing" ? "workflows.missing" : "workflows.unavailable")}
          </p>
        ) : (
          <WorkflowCanvas
            key={workflow}
            workflow={read.workflow}
            onOpenChild={(step) => {
              if (step.workflow !== undefined) {
                host.showRoute({
                  kind: "workflow",
                  collaborationWorkspaceId: workspaceId,
                  workflow: step.workflow
                });
              }
            }}
          />
        )}
      </div>
      {draft.dialog}
    </div>
  );
}

/** Opens the page of the Workflow in a new tab from the head of its surface. */
export function WorkflowSurfaceActions({
  workspaceId,
  workflow
}: {
  workspaceId: string;
  workflow: string;
}) {
  const { t } = useTranslation();
  const host = useWorkflowsHost();
  if (host === undefined) {
    return null;
  }
  return (
    <IconButton
      label={t("workflows.surface.openPage")}
      onClick={() =>
        openWorkspacePageInNewTab({
          kind: "workflow",
          collaborationWorkspaceId: workspaceId,
          workflow
        })
      }
    >
      <ExternalLink aria-hidden="true" />
    </IconButton>
  );
}
