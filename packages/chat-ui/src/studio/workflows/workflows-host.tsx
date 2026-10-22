import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ApiClient } from "@work-shape/catalyst-api-client";
import { useWorkspaceUsersQuery } from "../../shared/api/workspace-queries";
import type { WorkspaceRoute, WorkspaceRouteChangeOptions } from "../../shared/workspace-route";
import { NO_RECIPIENT_NAMES, type RecipientNames } from "./recipient-names";
import type { InstanceTimeZone, WorkflowRights } from "./workflow-model";

/**
 * What the workspace shell tells the Workflows area: what the reader may do, who the reader
 * is, which workspace is open, and how to go somewhere.
 */
export interface WorkflowsHost {
  rights: WorkflowRights;
  /** The instance's time zone, for a schedule saved without one of its own. */
  instanceTimeZone?: InstanceTimeZone;
  /** The id of the person who looks at the page: a run they started is theirs to cancel. */
  viewerId: string;
  /** The open workspace. Absent while none is open. */
  workspace: { id: string; name: string } | undefined;
  showRoute(route: WorkspaceRoute, options?: WorkspaceRouteChangeOptions): void;
  /**
   * Starts a conversation of the open workspace that is about this Workflow and opens it: its
   * agent reads and saves the draft of the Workflow. `prompt` stands in its composer, unsent.
   * Rejects where the instance refuses the conversation. Absent where no conversation can be
   * started, such as over samples.
   */
  editWithAgent?(workflow: string, prompt?: string, options?: { fresh: boolean }): Promise<void>;
  /**
   * "New workflow": opens the dock on the list with a new conversation with an agent that builds
   * assets and `prompt` in its composer; nothing is created until its first save. Absent where
   * no such agent is offered or the reader may write no Workflow.
   */
  startNew?(prompt: string): void;
  /** The names of the people and workspaces a Notify step may name, as far as the reader may read them. */
  recipients?: RecipientNames;
}

const WorkflowsHostContext = createContext<WorkflowsHost | undefined>(undefined);

export function WorkflowsHostProvider({
  value,
  children
}: {
  /** Nothing where the Workflows area is not open to the reader. */
  value: WorkflowsHost | undefined;
  children: ReactNode;
}) {
  return <WorkflowsHostContext.Provider value={value}>{children}</WorkflowsHostContext.Provider>;
}

/** The host, or nothing outside a workspace shell and where the area is closed to the reader. */
export function useWorkflowsHost(): WorkflowsHost | undefined {
  return useContext(WorkflowsHostContext);
}

/** The names a Notify step's recipients are shown by: none outside a workspace shell. */
export function useRecipientNames(): RecipientNames {
  return useWorkflowsHost()?.recipients ?? NO_RECIPIENT_NAMES;
}

/**
 * Whether the instance's people are read for the names of Notify recipients: only for a reader
 * who manages people, and only on the page of one Workflow or one run, where its steps are
 * drawn. Every other page mounts the host without reading the instance's directory.
 */
export function readsRecipientPeople(route: WorkspaceRoute, managesPeople: boolean): boolean {
  return managesPeople && (route.kind === "workflow" || route.kind === "workflow-run");
}

/**
 * The host with the names of who a Notify step may reach: the reader, the reader's own
 * workspaces, and every person of the instance for a reader who manages people. Nothing is
 * read that the reader could not read on another page.
 */
export function WorkflowsHostWithRecipients({
  value,
  api,
  viewer,
  workspaces,
  readsPeople,
  children
}: {
  value: WorkflowsHost | undefined;
  api: { apiBaseUrl: string; authScope: string; client: ApiClient };
  viewer: { id: string; name: string };
  workspaces: readonly { id: string; name: string }[];
  readsPeople: boolean;
  children: ReactNode;
}) {
  const users = useWorkspaceUsersQuery({ ...api, enabled: value !== undefined && readsPeople });
  const people = readsPeople ? users.data : undefined;
  const recipients = useMemo<RecipientNames>(
    () => ({
      people: new Map([
        ...(people ?? []).map((user) => [user.id, user.displayLabel] as const),
        [viewer.id, viewer.name] as const
      ]),
      workspaces: new Map(workspaces.map((workspace) => [workspace.id, workspace.name] as const))
    }),
    [people, viewer.id, viewer.name, workspaces]
  );
  return (
    <WorkflowsHostProvider value={value === undefined ? undefined : { ...value, recipients }}>
      {children}
    </WorkflowsHostProvider>
  );
}
