import type {
  AuthenticatedIdentity,
  OperationRunId,
  StorePage,
  WorkflowRunView,
  WorkflowStepRunView
} from "@vivd-catalyst/core";

/**
 * What the API reaches of the Workflow engine. The assembly hands it in where the module
 * `workflows` is on; the routes decide the caller's right before they ask it for anything.
 */
export interface WorkflowRunsPort {
  /** Starts a run of the published definition by hand. The run acts as its own principal. */
  start(input: {
    workflow: string;
    input: unknown;
    startedBy: AuthenticatedIdentity;
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
  listRuns(input: { workflow: string; page?: StorePage }): Promise<WorkflowRunView[]>;
  listStepRuns(input: { runId: string; page?: StorePage }): Promise<WorkflowStepRunView[]>;
}
