import { useState } from "react";
import { Play } from "lucide-react";
import { Button, PageHeader, PageLead, TabsLink, TabsNav } from "@work-shape/catalyst-ui";
import { CopyIdItem } from "../copy-id-item";
import { useTranslation } from "../../shared/i18n";
import type { WorkflowEdit } from "./workflow-draft";
import type { WorkflowView } from "./workflow-views";
import { workflowRightsOn } from "./workflow-model";
import { WorkflowRemoveDialog, WorkflowRemoveItem } from "./workflow-remove";
import { useWorkflowShare } from "./workflow-share";
import { useWorkflowsHost } from "./workflows-host";
import { BackLink, TitlePlaceholder, routeLink, type OpenRoute } from "./workflows-frame";

/**
 * The head of a Workflow, on its canvas, the list of its runs and its Settings: the way back,
 * the name, "Start now", "Copy ID" for whoever may change it, "Delete" for whoever may delete
 * it, with the question that names what the delete ends, and the
 * tabs Workflow, Runs and Settings. The tabs are addresses. Without runs on the instance, or
 * for a reader who may not read them, there is no Runs tab. The first paragraph under them
 * says what the Workflow does and whom every run acts as.
 */
export function WorkflowHead({
  workspaceId,
  workflowId,
  workflow,
  tab,
  runsShown,
  canStart,
  startOff = false,
  edit,
  onStart,
  onOpenRoute
}: {
  workspaceId: string;
  workflowId: string;
  /** The Workflow, once its record arrived. */
  workflow:
    | Pick<WorkflowView, "name" | "description" | "runsAs" | "allowed" | "ownerWorkspaceId">
    | undefined;
  tab: "workflow" | "runs" | "settings";
  /** The instance runs Workflows and the reader may read this one's runs: its tab stands. */
  runsShown: boolean;
  canStart: boolean;
  /** The reader may start the Workflow and the instance accepts no start of it now. */
  startOff?: boolean;
  /** The conversation in which the agent changes the Workflow, for a reader who may write it:
   * the page head's "Chat" starts it, and "Copy ID" stands only for such a reader. */
  edit?: Pick<WorkflowEdit, "busy" | "start">;
  onStart(): void;
  onOpenRoute: OpenRoute;
}) {
  const { t } = useTranslation();
  const host = useWorkflowsHost();
  const [removing, setRemoving] = useState(false);
  const mayDelete =
    workflow !== undefined && host !== undefined && workflowRightsOn(host.rights, workflow).delete;
  const share = useWorkflowShare({ workspaceId, workflowId, workflow, onOpenRoute });
  const address = { collaborationWorkspaceId: workspaceId, workflow: workflowId };
  const lead = [
    workflow?.description,
    workflow?.runsAs === undefined ? undefined : t("workflows.runsAs", { account: workflow.runsAs })
  ].filter((part): part is string => part !== undefined && part !== "");
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
        primaryAction={
          canStart || startOff ? (
            <Button disabled={startOff} onClick={onStart}>
              <Play aria-hidden="true" />
              {t("workflows.startNow")}
            </Button>
          ) : undefined
        }
        menu={
          edit === undefined && !mayDelete && share.item === undefined ? undefined : (
            <>
              {share.item}
              {edit === undefined ? null : <CopyIdItem id={workflowId} />}
              {mayDelete ? (
                <WorkflowRemoveItem
                  separated={edit !== undefined || share.item !== undefined}
                  onSelect={() => setRemoving(true)}
                />
              ) : null}
            </>
          )
        }
      />
      {share.dialog}
      {removing && workflow !== undefined ? (
        <WorkflowRemoveDialog
          workflow={workflowId}
          name={workflow.name}
          onClose={() => setRemoving(false)}
          onRemoved={() => {
            setRemoving(false);
            onOpenRoute({ kind: "workflows", collaborationWorkspaceId: workspaceId });
          }}
        />
      ) : null}
      <TabsNav label={t("workflows.tabs")} className="shrink-0 px-(--layout-gutter)">
        <TabsLink selected={tab === "workflow"} asChild>
          <a {...routeLink({ kind: "workflow", ...address }, onOpenRoute)}>
            {t("workflows.tabWorkflow")}
          </a>
        </TabsLink>
        {runsShown ? (
          <TabsLink selected={tab === "runs"} asChild>
            <a {...routeLink({ kind: "workflow-runs", ...address }, onOpenRoute)}>
              {t("workflows.sectionRuns")}
            </a>
          </TabsLink>
        ) : null}
        <TabsLink selected={tab === "settings"} asChild>
          <a {...routeLink({ kind: "workflow-settings", ...address }, onOpenRoute)}>
            {t("workflows.tabSettings")}
          </a>
        </TabsLink>
      </TabsNav>
      {/* What the Workflow does, and whom every run acts as: never the person who starts it. */}
      {lead.length === 0 ? null : <PageLead className="shrink-0 pb-3">{lead.join(" · ")}</PageLead>}
    </>
  );
}
