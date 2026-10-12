import { createContext, useContext, useMemo, type ReactNode } from "react";
import { WORKFLOW_ASSET_KIND } from "@vivd-catalyst/core";
import { useWorkspaceApiClient } from "../api/workspace-api-client";
import { toWorkflow, toWorkflowListItem } from "./workflow-mapping";
import type {
  WorkflowListItem,
  WorkflowRunView,
  WorkflowStepRunView,
  WorkflowView
} from "./workflow-views";

// Where the Workflow screens read from and write to, in the screens' own shapes. The screens
// name no operation and no type of the API contract: whoever builds a source maps onto these.
// The instance's source reads Workflows from the config assets. It has no runs until the
// engine's slice brings the operations of a run; a source without runs shows a Workflow and
// offers neither a start nor the list of runs.

/** One read of a list: its rows and where the next read starts. */
interface SourcePage<Row> {
  items: readonly Row[];
  nextCursor: string | undefined;
}

export type WorkflowStepRunStatusFilter = WorkflowStepRunView["status"];

/** The runs of Workflows: `workflows.list_runs`, `get_run`, `list_step_runs`, start, cancel. */
export interface WorkflowRunsSource {
  listRuns(
    workflow: string,
    query: { limit: number; cursor: string | undefined },
    signal: AbortSignal
  ): Promise<SourcePage<WorkflowRunView>>;
  getRun(runId: string, signal: AbortSignal): Promise<WorkflowRunView>;
  /**
   * The step runs of a run that belong to no item of a loop: at most one per step of the
   * definition, however many items a loop has. The canvas reads the tree of the run from them,
   * and a loop's progress from the counts its step run carries.
   */
  listFrameStepRuns(runId: string, signal: AbortSignal): Promise<readonly WorkflowStepRunView[]>;
  /** The step runs of the items of one loop, by the loop's step run and by state. */
  listEntryStepRuns(
    runId: string,
    query: {
      containerStepRunId: string;
      status: WorkflowStepRunStatusFilter | undefined;
      limit: number;
      cursor: string | undefined;
    },
    signal: AbortSignal
  ): Promise<SourcePage<WorkflowStepRunView>>;
  /** Starts a run of the published revision of a Workflow that takes no input. */
  start(workflow: string): Promise<WorkflowRunView>;
  cancel(runId: string): Promise<WorkflowRunView>;
}

export interface WorkflowsSource {
  /** Tells the reads of one source from those of another where both are cached. */
  key: string;
  listWorkflows(
    workspaceId: string,
    query: { limit: number; cursor: string | undefined },
    signal: AbortSignal
  ): Promise<SourcePage<WorkflowListItem>>;
  getWorkflow(workspaceId: string, workflow: string, signal: AbortSignal): Promise<WorkflowView>;
  /** Absent where the instance runs no Workflow. */
  runs: WorkflowRunsSource | undefined;
}

const WorkflowsSourceContext = createContext<WorkflowsSource | undefined>(undefined);

/** Gives the Workflow screens below it another source than the instance: samples, a test. */
export function WorkflowsSourceProvider({
  source,
  children
}: {
  source: WorkflowsSource;
  children: ReactNode;
}) {
  return <WorkflowsSourceContext value={source}>{children}</WorkflowsSourceContext>;
}

/** The session the Workflows are read with: the one the workspace shell holds. */
const WORKFLOW_AUTH_SCOPE = "standalone";

/** The source the screens read: the one given from above, else the instance. */
export function useWorkflowsSource(): WorkflowsSource {
  const given = useContext(WorkflowsSourceContext);
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const instance = useMemo<WorkflowsSource>(
    () => ({
      key: `${apiBaseUrl}:${WORKFLOW_AUTH_SCOPE}`,
      listWorkflows: async (workspaceId, query, signal) => {
        const page = await client.assets.list({
          params: { kind: WORKFLOW_ASSET_KIND },
          query: { limit: query.limit, cursor: query.cursor, workspaceId },
          signal
        });
        return {
          items: page.items.map((item) => toWorkflowListItem(item)),
          nextCursor: page.nextCursor
        };
      },
      // The read names no revision, so the instance answers the view the reader may have: the
      // published one to whoever only uses the Workflow.
      getWorkflow: async (workspaceId, workflow, signal) =>
        toWorkflow(
          await client.assets.get({
            params: { kind: WORKFLOW_ASSET_KIND, name: workflow },
            query: { workspaceId },
            signal
          })
        ),
      // Engine slice A1: the client has no operation of a run yet. A1 maps `workflows.start`,
      // `list_runs`, `get_run`, `list_step_runs` and `cancel_run` onto `WorkflowRunsSource`
      // here, with `toWorkflowRun` and `toWorkflowStepRun` of the data module.
      runs: undefined
    }),
    [apiBaseUrl, client]
  );
  return given ?? instance;
}
