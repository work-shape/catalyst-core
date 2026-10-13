import type {
  WorkflowListItem,
  WorkflowRunView,
  WorkflowStepRunView,
  WorkflowView
} from "./workflow-views";

// Where the Workflow screens read from and write to, in the screens' own shapes. The screens
// name no operation and no type of the API contract: whoever builds a source maps onto these.
// The instance's source is in `instance-source.ts`. A source without runs shows a Workflow and
// offers neither a start nor the list of runs.

/** One read of a list: its rows and where the next read starts. */
interface SourcePage<Row> {
  items: readonly Row[];
  nextCursor: string | undefined;
}

/** The step runs a run's drawing is made of. */
interface WorkflowFrameStepRuns {
  stepRuns: readonly WorkflowStepRunView[];
  /** Every step run outside a loop's items is among them. False where the read was cut. */
  complete: boolean;
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
  listFrameStepRuns(runId: string, signal: AbortSignal): Promise<WorkflowFrameStepRuns>;
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
  /** Absent where the source has no runs. */
  runs: WorkflowRunsSource | undefined;
  /** Absent where the source holds no drafts, such as samples. */
  drafts?: WorkflowDraftsSource;
}

/** What a person does to the draft of a Workflow: `assets.publish`, `assets.discard_draft`. */
interface WorkflowDraftsSource {
  /** Makes the revision with this number the published one: the one a run starts on. */
  publish(workflow: string, revision: number): Promise<void>;
  /** Puts the draft back on the published revision. `expectedRevision` is the draft read. */
  discard(workflow: string, expectedRevision: number): Promise<void>;
}
