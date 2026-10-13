import { Play } from "lucide-react";
import { Button, PageHeader, TabsLink, TabsNav } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import type { WorkflowView } from "./workflow-views";
import { BackLink, TitlePlaceholder, routeLink, type OpenRoute } from "./workflows-frame";

/**
 * The head of a Workflow, on its canvas and on the list of its runs: the way back, the name
 * and the description, "Start now", and the two tabs. The tabs are addresses. Without runs on
 * the instance there is one view and no tabs.
 */
export function WorkflowHead({
  workspaceId,
  workflowId,
  workflow,
  tab,
  runsAvailable,
  canStart,
  startOff = false,
  onStart,
  onOpenRoute
}: {
  workspaceId: string;
  workflowId: string;
  /** The Workflow, once its record arrived. */
  workflow: Pick<WorkflowView, "name" | "description"> | undefined;
  tab: "workflow" | "runs";
  runsAvailable: boolean;
  canStart: boolean;
  /** The reader may start the Workflow and the instance accepts no start of it now. */
  startOff?: boolean;
  onStart(): void;
  onOpenRoute: OpenRoute;
}) {
  const { t } = useTranslation();
  const address = { collaborationWorkspaceId: workspaceId, workflow: workflowId };
  return (
    <>
      {/* Where a control floats beside the head, the head starts at the top edge. */}
      <div
        aria-hidden="true"
        className="h-[var(--layout-page-head-inset,var(--layout-page-inset))] shrink-0"
      />
      <PageHeader
        variant="detail"
        className="shrink-0 border-b-0"
        back={
          <BackLink
            route={{ kind: "workflows", collaborationWorkspaceId: workspaceId }}
            label={t("workflows.backToList")}
            onOpenRoute={onOpenRoute}
          >
            {t("workflows.title")}
          </BackLink>
        }
        // Until the record arrived a placeholder stands for the name: the way back already
        // names the area, and the Workflow's id is never shown.
        title={workflow?.name ?? <TitlePlaceholder>{t("workflows.title")}</TitlePlaceholder>}
        description={workflow?.description}
        descriptionPlacement="inline"
        primaryAction={
          canStart || startOff ? (
            <Button disabled={startOff} onClick={onStart}>
              <Play aria-hidden="true" />
              {t("workflows.startNow")}
            </Button>
          ) : undefined
        }
      />
      {runsAvailable ? (
        <TabsNav label={t("workflows.tabs")} className="shrink-0 px-(--layout-gutter)">
          <TabsLink selected={tab === "workflow"} asChild>
            <a {...routeLink({ kind: "workflow", ...address }, onOpenRoute)}>
              {t("workflows.tabWorkflow")}
            </a>
          </TabsLink>
          <TabsLink selected={tab === "runs"} asChild>
            <a {...routeLink({ kind: "workflow-runs", ...address }, onOpenRoute)}>
              {t("workflows.sectionRuns")}
            </a>
          </TabsLink>
        </TabsNav>
      ) : (
        <div aria-hidden="true" className="shrink-0 border-b" />
      )}
    </>
  );
}
