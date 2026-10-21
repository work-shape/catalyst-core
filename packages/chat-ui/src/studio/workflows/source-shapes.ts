import type {
  CallableOperationOption,
  ChildWorkflowOption,
  LiveOnceSwitchView,
  WorkflowDefinitionView,
  WorkflowListItem,
  WorkflowRunView,
  WorkflowStepRunView,
  WorkflowStepTranscriptView,
  WorkflowView
} from "./workflow-views";
import type {
  WorkflowPublishRightsView,
  WorkflowRightGrant
} from "./workflow-publish-rights-model";

// Where the Workflow screens read from and write to, in the screens' own shapes. The screens
// name no operation and no type of the API contract: whoever builds a source maps onto these.
// The instance's source is in `instance-source.ts`. A source without runs shows a Workflow and
// offers neither a start nor the list of runs.

/** One read of a list: its rows and where the next read starts. */
interface SourcePage<Row> {
  items: readonly Row[];
  nextCursor: string | undefined;
}

/** One page of the step runs a run's drawing is made of. */
interface WorkflowFrameStepRuns {
  stepRuns: readonly WorkflowStepRunView[];
  /**
   * The step runs of loops inside an item of another loop: one per item, never drawn. Their
   * counts say what failed inside a run that ended `done`.
   */
  entryLoops: readonly WorkflowStepRunView[];
  /** Where the next page starts, while the run has step runs after these. */
  nextCursor: string | undefined;
}

export type WorkflowStepRunStatusFilter = WorkflowStepRunView["status"];

/** The runs of Workflows: `workflows.list_runs`, `get_run`, `list_step_runs`, start, cancel. */
export interface WorkflowRunsSource {
  listRuns(
    workflow: string,
    query: {
      limit: number;
      cursor: string | undefined;
      /** Only the runs whose run key starts with it. */
      keyPrefix?: string;
    },
    signal: AbortSignal
  ): Promise<SourcePage<WorkflowRunView>>;
  getRun(runId: string, signal: AbortSignal): Promise<WorkflowRunView>;
  /**
   * The step runs of a run that belong to no item of a loop, one page from `cursor` on: at most
   * one per step of the definition, however many items a loop has. The canvas reads the tree of
   * the run from them, and a loop's progress from the counts its step run carries.
   */
  listFrameStepRuns(
    runId: string,
    cursor: string | undefined,
    signal: AbortSignal
  ): Promise<WorkflowFrameStepRuns>;
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
  /**
   * The transcript of one agent step run, for a reader with run-data access. Absent where the
   * source has none, such as samples.
   */
  getStepTranscript?(
    runId: string,
    stepRunId: string,
    signal: AbortSignal
  ): Promise<WorkflowStepTranscriptView>;
  /** Starts a run of the published revision of a Workflow with the input its form gave. */
  start(workflow: string, input: Readonly<Record<string, unknown>>): Promise<WorkflowRunView>;
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
  /** Absent where the source has no technical accounts, such as samples. */
  publishRights?: WorkflowPublishRightsSource;
  /**
   * What a step's Settings offer to pick: the operations a step may call and the Workflows a
   * step may start. Absent where the source offers none, such as samples.
   */
  stepChoices?: WorkflowStepChoicesSource;
  /**
   * The instance's sentence on what publishing one revision makes live (PUBQ-1), as the asset
   * read answers it: `publishNarrative` or nothing. Absent where the source words none.
   */
  publishNarrative?: {
    read(workflow: string, revision: number, signal: AbortSignal): Promise<unknown>;
  };
}

/** One page of what a step's Settings offer, and where the next read starts. */
interface ChoicesPage<Row> {
  items: readonly Row[];
  nextCursor: string | undefined;
}

/**
 * `operations.list_callable` for a step of a Workflow, and the published Workflows of
 * `workflows.list` that list the trigger `parent`, of the instance and of one workspace.
 */
export interface WorkflowStepChoicesSource {
  listOperations(
    cursor: string | undefined,
    signal: AbortSignal
  ): Promise<ChoicesPage<CallableOperationOption>>;
  listChildWorkflows(
    workspaceId: string,
    cursor: string | undefined,
    signal: AbortSignal
  ): Promise<ChoicesPage<ChildWorkflowOption>>;
}

/**
 * What the technical accounts a publish runs as need (`workflows.principal_rights`), and
 * giving one of them a right through the ordinary grant write (`permissions.grant`).
 */
export interface WorkflowPublishRightsSource {
  read(workflow: string, signal: AbortSignal): Promise<WorkflowPublishRightsView>;
  give(grant: WorkflowRightGrant): Promise<void>;
}

/**
 * What a person does to the draft of a Workflow: `assets.publish`, `assets.discard_draft`,
 * `workflows.test` and `assets.run_live_once`.
 */
interface WorkflowDraftsSource {
  /** Makes the revision with this number the published one: the one a run starts on. */
  publish(workflow: string, revision: number): Promise<void>;
  /** Puts the draft back on the published revision. `expectedRevision` is the draft read. */
  discard(workflow: string, expectedRevision: number): Promise<void>;
  /** Starts a test run of the draft as the reader, with the input its form gave. */
  test(workflow: string, input: Readonly<Record<string, unknown>>): Promise<WorkflowRunView>;
  /** Lets one step of the draft run live in the next test run. `expectedRevision` is the draft read. */
  runLiveOnce(workflow: string, step: string, expectedRevision: number): Promise<void>;
  /** The reader's own switches on the draft, and the test run that used each. */
  listLiveOnce(workflow: string, signal: AbortSignal): Promise<LiveOnceSwitchView[]>;
  /** One revision as it is stored, such as the published one a draft is compared with. */
  readRevision(
    workflow: string,
    revision: number,
    signal: AbortSignal
  ): Promise<WorkflowDefinitionView>;
  /** What the instance would refuse in this config, asked without writing it. */
  validate(workflow: string, config: Readonly<Record<string, unknown>>): Promise<WorkflowIssue[]>;
  /**
   * Saves this config as the next revision of the draft. `expectedRevision` is the revision the
   * config was made from; a save over another one is refused with 412.
   */
  save(
    workflow: string,
    config: Readonly<Record<string, unknown>>,
    expectedRevision: number
  ): Promise<{ revision: number }>;
}

/** One thing the instance refuses in a definition: its sentence and where it is. */
export interface WorkflowIssue {
  message: string;
  /** The place in the config, as the instance names it: segments, or one dotted path. */
  path: readonly string[];
  code?: string;
}
