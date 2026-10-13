import { createContext, useContext, type ReactNode } from "react";
import type { WorkspaceRoute, WorkspaceRouteChangeOptions } from "../workspace/workspace-route";
import type { WorkflowRights } from "./workflow-model";

/**
 * What the workspace shell tells the Workflows area: what the reader may do, who the reader
 * is, which workspace is open, and how to go somewhere.
 */
export interface WorkflowsHost {
  rights: WorkflowRights;
  /** The id of the person who looks at the page: a run they started is theirs to cancel. */
  viewerId: string;
  /** The open workspace. Absent while none is open. */
  workspace: { id: string; name: string } | undefined;
  showRoute(route: WorkspaceRoute, options?: WorkspaceRouteChangeOptions): void;
  /**
   * Starts a conversation of the open workspace that is about this Workflow and opens it: its
   * agent reads and saves the draft of the Workflow. Rejects where the instance refuses the
   * conversation. Absent where no conversation can be started, such as over samples.
   */
  editWithAgent?(workflow: string): Promise<void>;
}

const WorkflowsHostContext = createContext<WorkflowsHost | undefined>(undefined);

export function WorkflowsHostProvider({
  value,
  children
}: {
  value: WorkflowsHost;
  children: ReactNode;
}) {
  return <WorkflowsHostContext.Provider value={value}>{children}</WorkflowsHostContext.Provider>;
}

/** The host, or nothing outside a workspace shell. */
export function useWorkflowsHost(): WorkflowsHost | undefined {
  return useContext(WorkflowsHostContext);
}
