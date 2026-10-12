import { useState } from "react";
import { Breadcrumb } from "@vivd-catalyst/ui";
import { useTranslation, type TranslationKey } from "../i18n";
import { useStartRun } from "./start-run";
import { WorkflowCanvas } from "./workflow-canvas";
import {
  useRunsAvailable,
  useWorkflow,
  type WorkflowRead,
  type WorkflowReadProblem
} from "./workflow-data";
import { WorkflowHead } from "./workflow-head";
import { startOffered, type WorkflowRights } from "./workflow-model";
import type { WorkflowStepView } from "./workflow-views";
import { LoadError, WorkflowsFrame, type OpenRoute } from "./workflows-frame";
import { useWorkflowsHost } from "./workflows-host";

const PROBLEM_SENTENCES: Readonly<Record<WorkflowReadProblem, TranslationKey>> = {
  missing: "workflows.missing",
  unavailable: "workflows.unavailable",
  failed: "workflows.failed"
};

/** A Workflow a step of the one above it starts, as the reader opened it. */
interface OpenedChild {
  id: string;
  /** The name of the step that starts it, until its own name arrived. */
  stepName: string;
}

/** One Workflow on its canvas, with the start by hand. */
export function WorkflowPage({ workflow }: { workflow: string }) {
  const host = useWorkflowsHost();
  const workspaceId = host?.workspace?.id;
  const read = useWorkflow(workspaceId, workflow);
  // The way from the Workflow into the ones its steps start, one level per "Open".
  const [way, setWay] = useState<readonly OpenedChild[]>([]);
  const child = useWorkflow(workspaceId, way.at(-1)?.id);
  const runsAvailable = useRunsAvailable();
  const start = useStartRun({ workflow, name: read.workflow?.name });

  if (!host || workspaceId === undefined) {
    return null;
  }
  return (
    <>
      <WorkflowPageView
        workspaceId={workspaceId}
        workflowId={workflow}
        read={read}
        way={way}
        child={way.length === 0 ? undefined : child}
        rights={host.rights}
        runsAvailable={runsAvailable}
        onOpenChild={(step) => {
          const id = step.workflow;
          if (id !== undefined) {
            setWay((opened) => [...opened, { id, stepName: step.name }]);
          }
        }}
        onLeaveChildren={(depth) => setWay((opened) => opened.slice(0, depth))}
        onOpenRoute={host.showRoute}
        onStart={start.open}
      />
      {start.dialog}
    </>
  );
}

/** The page of a Workflow for a given record and a given reader. */
export function WorkflowPageView({
  workspaceId,
  workflowId,
  read,
  way = [],
  child,
  rights,
  runsAvailable,
  onOpenChild,
  onLeaveChildren,
  onOpenRoute,
  onStart
}: {
  workspaceId: string;
  workflowId: string;
  read: Pick<WorkflowRead, "workflow" | "problem" | "retry">;
  /** The Workflows opened from a step, outermost first. The last one is on the canvas. */
  way?: readonly OpenedChild[];
  /** The read of the last of them. */
  child?: Pick<WorkflowRead, "workflow" | "problem" | "retry">;
  rights: WorkflowRights;
  /** The instance runs Workflows: there is a start and a list of runs. */
  runsAvailable: boolean;
  onOpenChild(step: WorkflowStepView): void;
  /** Goes back to the Workflow at this depth of the way: 0 is the Workflow of the page. */
  onLeaveChildren(depth: number): void;
  onOpenRoute: OpenRoute;
  onStart(): void;
}) {
  const { t } = useTranslation();
  const workflow = read.workflow;
  const canStart = runsAvailable && workflow !== undefined && startOffered(workflow, rights);
  const shown = child ?? read;
  const opened = way.at(-1);
  return (
    <WorkflowsFrame label={workflow?.name ?? t("workflows.title")} testId="workflow-page" fill>
      <WorkflowHead
        workspaceId={workspaceId}
        workflowId={workflowId}
        workflow={workflow}
        tab="workflow"
        runsAvailable={runsAvailable}
        canStart={canStart}
        onStart={onStart}
        onOpenRoute={onOpenRoute}
      />
      {opened === undefined ? null : (
        <div className="shrink-0 border-b px-(--layout-gutter) py-2">
          <Breadcrumb
            label={t("workflows.canvas.way")}
            items={[
              {
                id: workflowId,
                label: workflow?.name ?? t("workflows.title"),
                onSelect: () => onLeaveChildren(0)
              },
              ...way.map((entry, index) => ({
                id: `${String(index)}:${entry.id}`,
                label:
                  entry === opened ? (child?.workflow?.name ?? entry.stepName) : entry.stepName,
                onSelect: () => onLeaveChildren(index + 1)
              }))
            ]}
          />
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {shown.problem === "failed" ? (
          <div className="p-(--layout-gutter)">
            <LoadError onRetry={shown.retry}>{t(PROBLEM_SENTENCES.failed)}</LoadError>
          </div>
        ) : shown.problem ? (
          <p className="p-(--layout-gutter) text-body text-muted-foreground">
            {t(PROBLEM_SENTENCES[shown.problem])}
          </p>
        ) : (
          <WorkflowCanvas
            // Another Workflow is another graph: it opens fitted, with no step chosen.
            key={opened === undefined ? workflowId : `${String(way.length)}:${opened.id}`}
            workflow={shown.workflow}
            onOpenChild={onOpenChild}
          />
        )}
      </div>
    </WorkflowsFrame>
  );
}
