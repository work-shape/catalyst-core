import type { WorkspaceRoute } from "../../shared/workspace-route";
import { WorkflowRunPage } from "./run-page";
import { WorkflowRunsPage } from "./runs-page";
import { WorkflowPage } from "./workflow-page";
import { WorkflowSettingsPage } from "./workflow-settings";
import { WorkflowsPage } from "./workflows-page";

/** The routes of the Workflows area. */
export type WorkflowsRoute = Extract<
  WorkspaceRoute,
  { kind: "workflows" | "workflow" | "workflow-runs" | "workflow-run" | "workflow-settings" }
>;

export function isWorkflowsRoute(route: WorkspaceRoute): route is WorkflowsRoute {
  return (
    route.kind === "workflows" ||
    route.kind === "workflow" ||
    route.kind === "workflow-runs" ||
    route.kind === "workflow-run" ||
    route.kind === "workflow-settings"
  );
}

/**
 * The Workflows area: the list of the workspace's Workflows, one Workflow, its runs, one run,
 * or its Settings. Each is a page with an address of its own.
 */
export function WorkflowsArea({ route }: { route: WorkflowsRoute }) {
  switch (route.kind) {
    case "workflows":
      return <WorkflowsPage />;
    case "workflow":
      // Another Workflow is another record and other runs.
      return (
        <WorkflowPage
          key={`${route.workflow}/${route.opened ?? ""}`}
          workflow={route.workflow}
          opened={route.opened}
        />
      );
    case "workflow-runs":
      return <WorkflowRunsPage key={route.workflow} workflow={route.workflow} />;
    case "workflow-run":
      // Another run starts with nothing held of the one before.
      return <WorkflowRunPage key={route.run} workflow={route.workflow} run={route.run} />;
    case "workflow-settings":
      return <WorkflowSettingsPage key={route.workflow} workflow={route.workflow} />;
  }
}
