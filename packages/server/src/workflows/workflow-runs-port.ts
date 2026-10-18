import type { WorkflowKind } from "@work-shape/catalyst-core";
import type {
  WorkflowDatasetDownloadFormat,
  ActorAccess,
  AuthenticatedIdentity,
  AuthenticatedUser,
  JsonObject,
  OperationRunId,
  StorePage,
  WorkflowLastRun,
  WorkflowRunKeyFilter,
  WorkflowRunView,
  WorkflowStepRunFilter,
  WorkflowStepRunView
} from "@work-shape/catalyst-core";

/**
 * What the API reaches of the Workflow engine. The assembly hands it in where the module
 * `workflows` is on; the routes decide the caller's right before they ask it for anything.
 */
export interface WorkflowRunsPort {
  downloadDataset?(input: {
    runId: string;
    datasetId: string;
    format: WorkflowDatasetDownloadFormat;
    actor: AuthenticatedIdentity;
    access: ActorAccess;
    correlationId: string;
    signal?: AbortSignal;
  }): Promise<import("../http/download").DownloadAnswer>;
  /** Starts a run of the published definition by hand. The run acts as its own principal. */
  start(input: {
    workflow: string;
    input: unknown;
    /** The run key: a run of the Workflow that is open or done and holds it answers the start. */
    key?: string;
    startedBy: AuthenticatedIdentity;
    operationRunId?: OperationRunId;
    correlationId: string;
  }): Promise<WorkflowRunView>;
  /**
   * Starts a test run of the Workflow's draft, as the person who starts it bounded by the
   * principal the draft names (ADR-0031). Refuses a Workflow without a draft, a draft that
   * cannot be run and a principal that is missing or disabled.
   */
  test(input: {
    workflow: string;
    input: unknown;
    /** The run key: a run of the Workflow that is open or done and holds it answers the start. */
    key?: string;
    startedBy: AuthenticatedUser;
    operationRunId?: OperationRunId;
    correlationId: string;
  }): Promise<WorkflowRunView>;
  /** Ends a run as `cancelled`. A run that has ended is answered as it is; none answers nothing. */
  cancel(input: {
    runId: string;
    cancelledBy: AuthenticatedIdentity;
    correlationId: string;
  }): Promise<WorkflowRunView | undefined>;
  readRun(runId: string): Promise<WorkflowRunView | undefined>;
  /** The runs of a Workflow, newest first: all of them, or those of one key or key prefix. */
  listRuns(input: {
    workflow: string;
    key?: WorkflowRunKeyFilter;
    page?: StorePage;
  }): Promise<WorkflowRunView[]>;
  listStepRuns(input: {
    runId: string;
    filter?: WorkflowStepRunFilter;
    page?: StorePage;
  }): Promise<WorkflowStepRunView[]>;
  /**
   * Every Workflow with a published revision, each with its latest run where it has one and
   * with what a start by hand of it would be refused for now.
   */
  listWorkflows(): Promise<WorkflowListEntry[]>;
  /**
   * The id of the asset that holds the Workflow, where one does. A right is decided on it, so
   * a grant on that one asset opens the calls on its Workflow and on its runs.
   */
  assetIdOf(workflow: string): Promise<string | undefined>;
}

/** One published Workflow as the list of the instance names it. */
export interface WorkflowListEntry {
  kind?: WorkflowKind;
  id: string;
  /** The id of the asset that holds the Workflow. Decides the right; no part of the answer. */
  assetId?: string;
  name: string;
  description?: string;
  /** The published revision: what a run started now keeps as its `definitionRevisionId`. */
  definitionRevisionId: string;
  /** Whether a start by hand is accepted now. */
  runnable: boolean;
  /** Why not, under the codes the refusal of the start carries. Empty where `runnable`. */
  reasons: { code: string; message: string; path?: string }[];
  /** The published revision's `inputs`, where its definition could be read. */
  inputs?: JsonObject;
  /** The display label of the active service principal a run acts as. */
  runsAs?: string;
  lastRun?: WorkflowLastRun;
}
